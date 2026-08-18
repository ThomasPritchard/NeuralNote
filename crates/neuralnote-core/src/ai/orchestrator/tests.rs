use super::citations::{extract_cited_ids, strip_cited_markers};
use super::collect::{EvidenceCollection, RETRY_BACKOFF};
use super::context_budget::{
    context_window_tokens, estimate_tokens, fit_prompt_to_window, total_tokens,
    ANSWER_RESERVE_TOKENS, LOCAL_CONTEXT_WINDOW_TOKENS, PROMPT_OVERHEAD_TOKENS,
};
use super::coverage::{emit_coverage, CoverageAcc};
use super::history::{prepare_history, MAX_HISTORY_CHARS};
use super::prompt::SYSTEM_PROMPT;
use super::usage::EmissionGuard;
use super::*;
use crate::ai::approval::{
    ApprovalMode, ApprovalPolicy, DenyingApprovalPrompt, UnavailableApprovalClassifier,
};
use crate::ai::events::{TokenUsage, ToolStatus, VecSink};
use crate::ai::evidence::EvidenceRegistry;
use crate::ai::llm::{Completion, LlmRequest, NoUserPrompt, Role, ToolCall, UserPrompt};
use crate::ai::local::HardwareSpec;
use crate::ai::plan::{PlanStep, RunPlan, StepStatus};
use crate::ai::retrieval::{FolderMeta, KeywordRetriever, ListOutcome, SearchOutcome};
use crate::ai::skills::{ActiveSkills, SkillEnvironment, SkillRegistry};
use crate::ai::tool_turn_reader::{StreamedToolTurn, ToolTurnReader};
use crate::ai::tools;
use crate::ai::write_policy::UnavailableNoteWriter;
use crate::ai::youtube::YoutubeToolSession;
use crate::ai::{
    CaptionPayload, CaptionRequest, CaptureCancellation, Elicitation, MetadataPayload,
    NotePathState, NoteWriteBackend, NoteWriteParent, OpenedNoteParent, PlaylistPayload,
    ThumbnailPayload, VideoId, YoutubeIo, YoutubeUrl, FIXTURE_SKILL_ID, YOUTUBE_DISTIL_SKILL_ID,
};
use crate::capture::{CaptureError, PricingInput};
use crate::error::CoreError;
use async_trait::async_trait;
use futures::executor::block_on;
use std::time::Duration;

/// A gate that approves everything, for the tests in this module — none of
/// which is about approval. It still runs the real `decide()`, so the gate
/// stays on the dispatch path here rather than being bypassed. The approval
/// behaviour itself is tested in `ai::approval` and in
/// `tests/tool_approval*.rs`.
fn open_gate() -> ApprovalGate {
    ApprovalGate::new(unattended_policy())
}

static TEST_APPROVAL_PROMPT: DenyingApprovalPrompt = DenyingApprovalPrompt;
static TEST_APPROVAL_CLASSIFIER: UnavailableApprovalClassifier = UnavailableApprovalClassifier;

/// YOLO, plus an explicit unpin of `transcribe_audio`, so a test that is not
/// about approval is not blocked by it. Written out rather than hidden behind
/// a "disable the gate" switch: there is no such switch, and the gate still
/// runs for every call these tests make.
fn unattended_policy() -> ApprovalPolicy {
    ApprovalPolicy::new(
        ApprovalMode::Yolo,
        std::collections::BTreeMap::from([(
            tools::TOOL_TRANSCRIBE_AUDIO.to_string(),
            ApprovalMode::Yolo,
        )]),
        false,
    )
}

use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;

#[test]
fn system_prompt_defines_converse_and_research_modes() {
    assert!(SYSTEM_PROMPT.contains("CONVERSE"));
    assert!(SYSTEM_PROMPT.contains("RESEARCH"));
}

#[test]
fn system_prompt_scopes_the_search_mandate_to_research_mode() {
    let research = SYSTEM_PROMPT.find("RESEARCH").expect("RESEARCH mode");
    let search_mandate = SYSTEM_PROMPT
        .find("Issue 3 to 8 varied searches")
        .expect("research search mandate");

    assert!(search_mandate > research);
}

#[test]
fn system_prompt_does_not_promise_unavailable_capture_skills() {
    let prompt = SYSTEM_PROMPT.to_lowercase();

    assert!(!prompt.contains("youtube"));
    assert!(!prompt.contains("distil"));
    assert!(!prompt.contains("pdf"));
}

#[test]
fn coverage_is_suppressed_on_a_conversational_turn() {
    // "hello" searches nothing and reads nothing. An empty footer is a lie of
    // precision, so emit no footer at all.
    let mut sink = VecSink::default();
    emit_coverage(CoverageAcc::default(), false, &mut sink);
    assert!(sink.events.is_empty());
}

#[test]
fn coverage_still_reports_a_tripped_guard_with_no_searches() {
    // `list_notes` / `list_folders` yield `ToolOutcome::Listed`, populating neither
    // `searched_terms` nor `notes_read` — yet they can still trip `max_iterations`
    // or `max_context_chars`. Suppressing the footer there would hide the
    // truncation, and "partial coverage is visible, never hidden" (events.rs).
    let mut sink = VecSink::default();
    emit_coverage(CoverageAcc::default(), true, &mut sink);
    assert!(
        matches!(
            sink.events.as_slice(),
            [ChatEvent::Coverage {
                truncated: true,
                ..
            }]
        ),
        "a cut-short run must surface its truncation, got {:?}",
        sink.events
    );
}

#[test]
fn coverage_still_reports_skipped_files_with_no_searches() {
    let coverage = CoverageAcc {
        skipped_files: 3,
        ..CoverageAcc::default()
    };
    let mut sink = VecSink::default();
    emit_coverage(coverage, false, &mut sink);
    assert!(
        matches!(
            sink.events.as_slice(),
            [ChatEvent::Coverage {
                skipped_files: 3,
                ..
            }]
        ),
        "skipped files must never be silently dropped, got {:?}",
        sink.events
    );
}

/// A scripted, network-free [`LlmClient`]. `completions` are popped by each
/// `complete` turn; `answer` is streamed by `complete_streaming`. An optional
/// `before_answer` hook fires just before streaming, letting a test mutate the
/// vault to simulate an external edit landing mid-answer.
struct MockLlmClient {
    completions: Mutex<VecDeque<Completion>>,
    answer: String,
    fail: bool,
    /// The number of tools the last `complete_streaming` call was handed — so a
    /// test can assert the answer turn advertises none.
    streaming_tools_len: Mutex<Option<usize>>,
    /// Reasoning deltas streamed as `Thinking` events before the answer, so a test
    /// can assert reasoning reaches the sink without polluting the answer string.
    reasoning: Vec<String>,
    #[allow(clippy::type_complexity)]
    before_answer: Option<Box<dyn Fn() + Send + Sync>>,
    max_request_chars: std::sync::atomic::AtomicUsize,
    completion_requests: Mutex<Vec<Vec<LlmMessage>>>,
    streaming_messages: Mutex<Vec<LlmMessage>>,
    /// Errors returned by successive `complete` calls before normal scripting takes
    /// over — lets a test script a transient failure then a success.
    pending_complete_errors: Mutex<VecDeque<CoreError>>,
    /// If set, every `complete_streaming` call returns this error (to prove the
    /// streamed answer turn is never retried).
    streaming_error: Mutex<Option<CoreError>>,
    streaming_attempts: std::sync::atomic::AtomicUsize,
    /// The context window this client reports for the active provider+model
    /// (None = unknown, like a cloud model absent from the catalogue cache).
    context_window: Option<usize>,
}

impl MockLlmClient {
    fn new(completions: Vec<Completion>, answer: &str) -> Self {
        Self {
            completions: Mutex::new(completions.into()),
            answer: answer.into(),
            fail: false,
            streaming_tools_len: Mutex::new(None),
            reasoning: Vec::new(),
            before_answer: None,
            max_request_chars: std::sync::atomic::AtomicUsize::new(0),
            completion_requests: Mutex::new(Vec::new()),
            streaming_messages: Mutex::new(Vec::new()),
            pending_complete_errors: Mutex::new(VecDeque::new()),
            streaming_error: Mutex::new(None),
            streaming_attempts: std::sync::atomic::AtomicUsize::new(0),
            context_window: None,
        }
    }

    fn failing() -> Self {
        Self {
            completions: Mutex::new(VecDeque::new()),
            answer: String::new(),
            fail: true,
            streaming_tools_len: Mutex::new(None),
            reasoning: Vec::new(),
            before_answer: None,
            max_request_chars: std::sync::atomic::AtomicUsize::new(0),
            completion_requests: Mutex::new(Vec::new()),
            streaming_messages: Mutex::new(Vec::new()),
            pending_complete_errors: Mutex::new(VecDeque::new()),
            streaming_error: Mutex::new(None),
            streaming_attempts: std::sync::atomic::AtomicUsize::new(0),
            context_window: None,
        }
    }

    /// Report `window` as the active model's context window, like a client that
    /// knows its provider's real limit (the shell's local `num_ctx`, or a cloud
    /// model's catalogue `context_length`).
    fn with_context_window(mut self, window: usize) -> Self {
        self.context_window = Some(window);
        self
    }

    /// Script the first N `complete` calls to fail with these errors (in order),
    /// then fall through to the normal completion queue.
    fn with_complete_failures(self, errors: Vec<CoreError>) -> Self {
        *self.pending_complete_errors.lock().unwrap() = errors.into();
        self
    }

    /// Make every `complete_streaming` call fail with this error.
    fn with_streaming_failure(self, error: CoreError) -> Self {
        *self.streaming_error.lock().unwrap() = Some(error);
        self
    }

    fn streaming_attempts(&self) -> usize {
        self.streaming_attempts
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn with_hook(mut self, f: impl Fn() + Send + Sync + 'static) -> Self {
        self.before_answer = Some(Box::new(f));
        self
    }

    fn with_reasoning(mut self, deltas: &[&str]) -> Self {
        self.reasoning = deltas.iter().map(|d| d.to_string()).collect();
        self
    }

    fn max_request_chars(&self) -> usize {
        self.max_request_chars
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn completion_requests(&self) -> Vec<Vec<LlmMessage>> {
        self.completion_requests.lock().unwrap().clone()
    }

    fn streaming_messages(&self) -> Vec<LlmMessage> {
        self.streaming_messages.lock().unwrap().clone()
    }
}

#[async_trait]
impl LlmClient for MockLlmClient {
    fn context_window_tokens(&self) -> Option<usize> {
        self.context_window
    }

    async fn complete(&self, req: &LlmRequest) -> CoreResult<Completion> {
        let request_chars = serde_json::to_string(&req.messages).unwrap().len();
        self.max_request_chars
            .fetch_max(request_chars, std::sync::atomic::Ordering::SeqCst);
        self.completion_requests
            .lock()
            .unwrap()
            .push(req.messages.clone());
        if let Some(error) = self.pending_complete_errors.lock().unwrap().pop_front() {
            return Err(error);
        }
        if self.fail {
            return Err(CoreError::Llm("mock transport failure: boom".into()));
        }
        // Default to a no-tool-call turn if the script runs dry (ends the loop).
        Ok(self
            .completions
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Completion {
                content: Some(String::new()),
                tool_calls: Vec::new(),
            }))
    }

    async fn complete_streaming(
        &self,
        req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<String> {
        self.streaming_attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.streaming_tools_len.lock().unwrap() = Some(req.tools.len());
        *self.streaming_messages.lock().unwrap() = req.messages.clone();
        if let Some(error) = self.streaming_error.lock().unwrap().clone() {
            return Err(error);
        }
        if let Some(hook) = &self.before_answer {
            hook();
        }
        // Reasoning, if any, streams as Thinking before the answer — mirroring the
        // real client, and never folded into the returned answer string.
        for delta in &self.reasoning {
            sink.send(ChatEvent::Thinking {
                delta: delta.clone(),
            });
        }
        for chunk in self.answer.split_inclusive(' ') {
            sink.send(ChatEvent::Answer {
                delta: chunk.to_string(),
            });
        }
        Ok(self.answer.clone())
    }
}

fn tool_call(id: &str, name: &str, args: &str) -> Completion {
    Completion {
        content: None,
        tool_calls: vec![ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args.into(),
        }],
    }
}

fn final_turn() -> Completion {
    Completion {
        content: Some("ready".into()),
        tool_calls: Vec::new(),
    }
}

/// One turn that issues several search calls at once (to exercise the mid-turn
/// cap check).
fn multi_search(queries: &[&str]) -> Completion {
    Completion {
        content: None,
        tool_calls: queries
            .iter()
            .enumerate()
            .map(|(i, q)| ToolCall {
                id: format!("c{i}"),
                name: "search_notes".into(),
                arguments: format!(r#"{{"query":"{q}"}}"#),
            })
            .collect(),
    }
}

fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("Research")).unwrap();
    fs::write(
        dir.path().join("Research/widgets.md"),
        "# Widgets\n\nWidgets are small components.\nThey snap together.\n",
    )
    .unwrap();
    dir
}

struct PlaylistPrompt(Mutex<VecDeque<Option<Vec<String>>>>);

#[async_trait]
impl UserPrompt for PlaylistPrompt {
    async fn ask(&self, _elicitation: Elicitation) -> CoreResult<Option<Vec<String>>> {
        Ok(self.0.lock().unwrap().pop_front().flatten())
    }
}

struct PlaylistIo(usize);

#[async_trait]
impl YoutubeIo for PlaylistIo {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        Err(CaptureError::MetadataUnavailable(
            "unused in this script".into(),
        ))
    }

    async fn fetch_caption_vtt(
        &self,
        _request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(CaptureError::CaptionsAbsent("unused in this script".into()))
    }

    async fn enumerate_playlist(&self, _url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        let entries = (0..self.0)
            .map(|index| {
                serde_json::json!({
                    "id": format!("V{index:010}"),
                    "title": format!("Realistic lecture {index}"),
                    "duration": 3600,
                })
            })
            .collect::<Vec<_>>();
        Ok(PlaylistPayload {
            json: serde_json::to_vec(&serde_json::json!({
                "_type": "playlist",
                "id": "PL-orchestrator_21",
                "title": "Twenty-one lectures",
                "entries": entries,
            }))
            .unwrap(),
        })
    }

    async fn fetch_thumbnail(&self, _video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        Err(CaptureError::ThumbnailRejected(
            "fixture has no image".into(),
        ))
    }

    async fn transcribe_audio(
        &self,
        _url: &YoutubeUrl,
        _model: &str,
        _cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(CaptureError::TranscriptionFailed(
            "unused in this script".into(),
        ))
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        Err(CaptureError::ExtractorStale("unused in this script".into()))
    }
}

#[derive(Default)]
struct GuardedPlaylistIo {
    enumerations: std::sync::atomic::AtomicUsize,
    capture_calls: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl YoutubeIo for GuardedPlaylistIo {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        self.capture_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(CaptureError::MetadataUnavailable(
            "host capture should not be reached".into(),
        ))
    }

    async fn fetch_caption_vtt(
        &self,
        _request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        self.capture_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(CaptureError::CaptionsAbsent(
            "host capture should not be reached".into(),
        ))
    }

    async fn enumerate_playlist(&self, _url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        self.enumerations
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(PlaylistPayload {
            json: serde_json::to_vec(&serde_json::json!({
                "_type": "playlist",
                "id": "PL-guarded_2",
                "title": "Guarded playlist",
                "entries": [
                    {"id":"V0000000000","title":"First","duration":60},
                    {"id":"V0000000001","title":"Second","duration":60}
                ],
            }))
            .unwrap(),
        })
    }

    async fn fetch_thumbnail(&self, _video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        Err(CaptureError::ThumbnailRejected(
            "fixture has no image".into(),
        ))
    }

    async fn transcribe_audio(
        &self,
        _url: &YoutubeUrl,
        _model: &str,
        _cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        self.capture_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(CaptureError::TranscriptionFailed(
            "host capture should not be reached".into(),
        ))
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        Ok(())
    }
}

struct FsParent(PathBuf);

impl NoteWriteParent for FsParent {
    fn probe(&self, leaf: &str) -> CoreResult<NotePathState> {
        match fs::symlink_metadata(self.0.join(leaf)) {
            Ok(metadata) if metadata.file_type().is_file() => Ok(NotePathState::RegularFile {
                actual_name: leaf.to_string(),
            }),
            Ok(_) => Ok(NotePathState::Other),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(NotePathState::Missing)
            }
            Err(error) => Err(CoreError::Io(error.to_string())),
        }
    }

    fn create_new_all_or_nothing(&self, leaf: &str, content: &str) -> CoreResult<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.0.join(leaf))
            .map_err(|error| CoreError::Io(error.to_string()))?;
        file.write_all(content.as_bytes())
            .map_err(|error| CoreError::Io(error.to_string()))
    }
}

struct FsWriter;

impl NoteWriteBackend for FsWriter {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        fs::canonicalize(path).map_err(|error| CoreError::Io(error.to_string()))
    }

    fn open_parent(
        &self,
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        let opened =
            fs::canonicalize(canonical_parent).map_err(|error| CoreError::Io(error.to_string()))?;
        if !opened.starts_with(canonical_root) {
            return Err(CoreError::OutsideVault(opened.display().to_string()));
        }
        Ok(OpenedNoteParent::new(
            opened.clone(),
            Box::new(FsParent(opened)),
        ))
    }
}

struct CancellingParent {
    path: PathBuf,
    cancellation: CaptureCancellation,
}

impl NoteWriteParent for CancellingParent {
    fn probe(&self, leaf: &str) -> CoreResult<NotePathState> {
        FsParent(self.path.clone()).probe(leaf)
    }

    fn create_new_all_or_nothing(&self, leaf: &str, content: &str) -> CoreResult<()> {
        FsParent(self.path.clone()).create_new_all_or_nothing(leaf, content)?;
        self.cancellation.cancel();
        Ok(())
    }
}

struct CancellingWriter(CaptureCancellation);

impl NoteWriteBackend for CancellingWriter {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        FsWriter.canonicalize(path)
    }

    fn open_parent(
        &self,
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        let opened =
            fs::canonicalize(canonical_parent).map_err(|error| CoreError::Io(error.to_string()))?;
        if !opened.starts_with(canonical_root) {
            return Err(CoreError::OutsideVault(opened.display().to_string()));
        }
        Ok(OpenedNoteParent::new(
            opened.clone(),
            Box::new(CancellingParent {
                path: opened,
                cancellation: self.0.clone(),
            }),
        ))
    }
}

fn realistic_transcript(video_id: &str) -> String {
    let cues = (0..120)
        .map(|cue| {
            format!(
                "[00:{:02}:{:02}](https://youtu.be/{video_id}?t={}) Lecture sentence {cue} explains a concrete idea with enough detail for distillation.",
                cue / 60,
                cue % 60,
                cue
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("---\nnn:\n  source:\n    youtubeId: {video_id}\n---\n\n{cues}\n")
}

fn youtube_test_environment() -> SkillEnvironment {
    SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 8 * 1024 * 1024 * 1024,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 2_000_000_000,
        },
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::from([PathBuf::from("/app-data/bin/yt-dlp")]),
    }
}

#[test]
fn playlist_orchestrator_processes_21_transcripts_with_bounded_context_and_full_partial_ledger() {
    let vault = tempfile::tempdir().unwrap();
    let selected = (0..21)
        .map(|index| format!("V{index:010}"))
        .collect::<Vec<_>>();
    let prompt = PlaylistPrompt(Mutex::new(VecDeque::from([
        Some(selected.clone()),
        Some(vec!["continue".into()]),
    ])));
    let mut script = vec![tool_call(
        "select",
        "select_playlist_videos",
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-orchestrator_21"}"#,
    )];
    for (work_item, video_id) in selected.iter().enumerate() {
        let transcript = realistic_transcript(video_id);
        script.push(Completion {
            content: None,
            tool_calls: vec![
                ToolCall {
                    id: format!("literature-{work_item}"),
                    name: "write_note".into(),
                    arguments: serde_json::json!({
                        "rel_path": format!("literature-{work_item}.md"),
                        "content": format!("# Lecture {work_item}\n\nDistilled from {video_id}."),
                        "kind": "literature",
                        "work_item": work_item,
                    })
                    .to_string(),
                },
                ToolCall {
                    id: format!("transcript-{work_item}"),
                    name: "write_note".into(),
                    arguments: serde_json::json!({
                        "rel_path": format!("transcript-{work_item}.md"),
                        "content": transcript,
                        "kind": "transcript",
                        "work_item": work_item,
                    })
                    .to_string(),
                },
            ],
        });
    }
    let llm = MockLlmClient::new(script, "Playlist complete.");
    let retriever = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 8 * 1024 * 1024 * 1024,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 2_000_000_000,
        },
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::from([PathBuf::from("/app-data/bin/yt-dlp")]),
    };
    let pricing = PricingInput::Local;
    let services = SkillServices::new(&skills, &environment, &prompt, &FsWriter, 1)
        .with_approval(
            unattended_policy(),
            &TEST_APPROVAL_PROMPT,
            &TEST_APPROVAL_CLASSIFIER,
        )
        .with_youtube_io(&PlaylistIo(21))
        .with_pricing(&pricing);
    let mut sink = VecSink::default();
    let ledger = block_on(run_chat(
        "Distil this playlist",
        &[],
        vec![YOUTUBE_DISTIL_SKILL_ID.into()],
        vault.path(),
        "test-model",
        &retriever,
        &llm,
        &services,
        &mut sink,
        &Guards::default(),
    ))
    .unwrap();

    assert_eq!(
        ledger.entries().len(),
        42,
        "every item keeps both Undo entries"
    );
    assert_eq!(
        count(&sink.events, |event| matches!(
            event,
            ChatEvent::NoteWritten { .. }
        )),
        42,
        "context eviction must not discard partial report-card events"
    );
    for video_id in selected {
        assert!(sink.events.iter().any(|event| {
            matches!(event, ChatEvent::SkillStep { message } if message.contains(&video_id) && message.contains("succeeded"))
        }), "missing explicit outcome for {video_id}");
    }
    assert!(
        llm.max_request_chars() < 120_000,
        "completed transcript context was not evicted: {} chars",
        llm.max_request_chars()
    );
    let completion_requests = llm.completion_requests();
    let tool_context = completion_requests
        .last()
        .expect("the final tool-decision request preserves the execution trace");
    let work_item_turns = tool_context
        .iter()
        .filter(|message| message.role == Role::Assistant)
        .filter_map(|message| {
            let ids = message
                .tool_calls
                .iter()
                .map(|call| call.id.clone())
                .collect::<Vec<_>>();
            ids.iter()
                .any(|id| id.starts_with("literature-"))
                .then_some(ids)
        })
        .collect::<Vec<_>>();
    // A request records the tool batches that PRECEDE the completion being
    // requested, so the final (21st) batch is not in this captured input. Its
    // two writes are covered by the 42-entry ledger and NoteWritten assertions
    // above; the preceding 20 inputs still prove each item stayed paired.
    assert_eq!(work_item_turns.len(), 20);
    for (index, ids) in work_item_turns.iter().enumerate() {
        assert_eq!(
            ids,
            &vec![format!("literature-{index}"), format!("transcript-{index}"),],
            "work item {index} must finish both required writes before the next item"
        );
    }
    let streaming_messages = llm.streaming_messages();
    let final_context = streaming_messages
        .iter()
        .filter_map(|message| message.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(final_context.contains("PLAYLIST EXECUTION SUMMARY"));
    assert!(final_context.contains("V0000000000: succeeded"));
    assert!(final_context.contains("V0000000020: succeeded"));
    assert_eq!(completion_requests.len(), 22);
}

#[test]
fn playlist_cancellation_inside_a_batched_turn_skips_later_calls_and_keeps_partial_ledger() {
    let vault = tempfile::tempdir().unwrap();
    let selected = vec!["V0000000000".to_string(), "V0000000001".to_string()];
    let prompt = PlaylistPrompt(Mutex::new(VecDeque::from([Some(selected)])));
    let batch = Completion {
        content: None,
        tool_calls: (0..2)
            .flat_map(|work_item| {
                ["literature", "transcript"].map(move |kind| ToolCall {
                    id: format!("{kind}-{work_item}"),
                    name: "write_note".into(),
                    arguments: serde_json::json!({
                        "rel_path": format!("{kind}-{work_item}.md"),
                        "content": format!("# {kind} {work_item}"),
                        "kind": kind,
                        "work_item": work_item,
                    })
                    .to_string(),
                })
            })
            .collect(),
    };
    let llm = MockLlmClient::new(
        vec![
            tool_call(
                "select",
                "select_playlist_videos",
                r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-orchestrator_2"}"#,
            ),
            batch,
        ],
        "Cancelled with partial results.",
    );
    let retriever = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 8 * 1024 * 1024 * 1024,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 2_000_000_000,
        },
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::from([PathBuf::from("/app-data/bin/yt-dlp")]),
    };
    let cancellation = CaptureCancellation::default();
    let writer = CancellingWriter(cancellation.clone());
    let services = SkillServices::new(&skills, &environment, &prompt, &writer, 1)
        .with_approval(
            unattended_policy(),
            &TEST_APPROVAL_PROMPT,
            &TEST_APPROVAL_CLASSIFIER,
        )
        .with_youtube_io(&PlaylistIo(2))
        .with_capture_cancellation(cancellation);
    let mut sink = VecSink::default();
    let ledger = block_on(run_chat(
        "Distil this playlist",
        &[],
        vec![YOUTUBE_DISTIL_SKILL_ID.into()],
        vault.path(),
        "test-model",
        &retriever,
        &llm,
        &services,
        &mut sink,
        &Guards::default(),
    ))
    .unwrap();

    assert_eq!(ledger.entries().len(), 1);
    assert_eq!(
        count(&sink.events, |event| matches!(
            event,
            ChatEvent::NoteWritten { .. }
        )),
        1
    );
    assert!(vault.path().join("literature-0.md").exists());
    assert!(!vault.path().join("transcript-0.md").exists());
    assert!(!vault.path().join("literature-1.md").exists());
    assert!(!vault.path().join("transcript-1.md").exists());
    for video_id in ["V0000000000", "V0000000001"] {
        assert!(sink.events.iter().any(|event| {
            matches!(event, ChatEvent::SkillStep { message } if message.contains(video_id) && message.contains("cancelled"))
        }));
    }
    let final_context = llm
        .streaming_messages()
        .iter()
        .filter_map(|message| message.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(final_context.matches("capture_cancelled").count(), 3);
}

#[test]
fn rejected_playlist_batch_cannot_cascade_into_the_next_work_item() {
    let vault = tempfile::tempdir().unwrap();
    let selected = vec!["V0000000000".to_string(), "V0000000001".to_string()];
    let prompt = PlaylistPrompt(Mutex::new(VecDeque::from([Some(selected)])));
    let stale_old_item_write = |kind: &str| ToolCall {
        id: format!("stale-{kind}"),
        name: "write_note".into(),
        arguments: serde_json::json!({
            "rel_path": format!("stale-{kind}.md"),
            "content": "must never be written",
            "kind": kind,
            "work_item": 0,
        })
        .to_string(),
    };
    let hostile_batch = Completion {
        content: None,
        tool_calls: vec![
            ToolCall {
                id: "reject-item-0".into(),
                name: "write_note".into(),
                arguments: serde_json::json!({
                    "rel_path": "../escape.md",
                    "content": "reject this",
                    "kind": "literature",
                    "work_item": 0,
                })
                .to_string(),
            },
            stale_old_item_write("literature"),
            stale_old_item_write("transcript"),
        ],
    };
    let next_item = Completion {
        content: None,
        tool_calls: ["literature", "transcript"]
            .into_iter()
            .map(|kind| ToolCall {
                id: format!("next-{kind}"),
                name: "write_note".into(),
                arguments: serde_json::json!({
                    "rel_path": format!("next-{kind}.md"),
                    "content": format!("# Next {kind}"),
                    "kind": kind,
                    "work_item": 1,
                })
                .to_string(),
            })
            .collect(),
    };
    let llm = MockLlmClient::new(
        vec![
            tool_call(
                "select",
                "select_playlist_videos",
                r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-orchestrator_2"}"#,
            ),
            hostile_batch,
            next_item,
        ],
        "Partial playlist complete.",
    );
    let retriever = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 8 * 1024 * 1024 * 1024,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 2_000_000_000,
        },
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::from([PathBuf::from("/app-data/bin/yt-dlp")]),
    };
    let services = SkillServices::new(&skills, &environment, &prompt, &FsWriter, 1)
        .with_approval(
            unattended_policy(),
            &TEST_APPROVAL_PROMPT,
            &TEST_APPROVAL_CLASSIFIER,
        )
        .with_youtube_io(&PlaylistIo(2));
    let mut sink = VecSink::default();
    let ledger = block_on(run_chat(
        "Distil this playlist",
        &[],
        vec![YOUTUBE_DISTIL_SKILL_ID.into()],
        vault.path(),
        "test-model",
        &retriever,
        &llm,
        &services,
        &mut sink,
        &Guards::default(),
    ))
    .unwrap();

    assert_eq!(ledger.entries().len(), 2);
    assert!(!vault.path().join("stale-literature.md").exists());
    assert!(!vault.path().join("stale-transcript.md").exists());
    assert!(vault.path().join("next-literature.md").exists());
    assert!(vault.path().join("next-transcript.md").exists());
    let steps = sink
        .events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::SkillStep { message } => Some(message.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        steps
            .iter()
            .filter(|message| message.contains("V0000000000 failed"))
            .count(),
        1
    );
    assert!(steps
        .iter()
        .any(|message| message.contains("V0000000001 succeeded")));
    assert!(!steps
        .iter()
        .any(|message| message.contains("V0000000001 failed")));
    let final_context = llm
        .streaming_messages()
        .iter()
        .filter_map(|message| message.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(final_context.matches("stale_playlist_batch").count(), 2);
}

#[test]
fn playlist_capture_rejects_cross_video_and_unselected_urls_before_host_io() {
    let vault = tempfile::tempdir().unwrap();
    let prompt = PlaylistPrompt(Mutex::new(VecDeque::from([Some(vec![
        "V0000000000".into(),
        "V0000000001".into(),
    ])])));
    let hostile_batch = Completion {
        content: None,
        tool_calls: vec![
            ToolCall {
                id: "prefetch-next".into(),
                name: "fetch_video_info".into(),
                arguments: r#"{"url":"https://youtu.be/V0000000001"}"#.into(),
            },
            ToolCall {
                id: "arbitrary-unselected".into(),
                name: "fetch_captions".into(),
                arguments: r#"{"url":"https://youtu.be/jNQXAC9IVRw","lang":"en"}"#.into(),
            },
        ],
    };
    let next_item = Completion {
        content: None,
        tool_calls: ["literature", "transcript"]
            .into_iter()
            .map(|kind| ToolCall {
                id: format!("item-1-{kind}"),
                name: "write_note".into(),
                arguments: serde_json::json!({
                    "rel_path": format!("item-1-{kind}.md"),
                    "content": format!("# Item 1 {kind}"),
                    "kind": kind,
                    "work_item": 1,
                })
                .to_string(),
            })
            .collect(),
    };
    let llm = MockLlmClient::new(
        vec![
            tool_call(
                "select",
                "select_playlist_videos",
                r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-guarded_2"}"#,
            ),
            hostile_batch,
            next_item,
        ],
        "Partial playlist complete.",
    );
    let io = GuardedPlaylistIo::default();
    let retriever = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = youtube_test_environment();
    let services = SkillServices::new(&skills, &environment, &prompt, &FsWriter, 1)
        .with_approval(
            unattended_policy(),
            &TEST_APPROVAL_PROMPT,
            &TEST_APPROVAL_CLASSIFIER,
        )
        .with_youtube_io(&io);
    let mut sink = VecSink::default();
    let ledger = block_on(run_chat(
        "Distil this playlist",
        &[],
        vec![YOUTUBE_DISTIL_SKILL_ID.into()],
        vault.path(),
        "test-model",
        &retriever,
        &llm,
        &services,
        &mut sink,
        &Guards::default(),
    ))
    .unwrap();

    assert_eq!(
        io.capture_calls.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(ledger.entries().len(), 2);
    assert!(vault.path().join("item-1-literature.md").exists());
    assert!(vault.path().join("item-1-transcript.md").exists());
    assert!(sink.events.iter().any(|event| {
        matches!(event, ChatEvent::SkillStep { message } if message.contains("V0000000000 failed"))
    }));
    assert!(sink.events.iter().any(|event| {
        matches!(event, ChatEvent::SkillStep { message } if message.contains("V0000000001 succeeded"))
    }));
    let final_context = llm
        .streaming_messages()
        .iter()
        .filter_map(|message| message.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(final_context.matches("stale_playlist_batch").count(), 1);
}

#[test]
fn nested_playlist_batch_is_stale_without_replacing_or_advancing_the_original_run() {
    let vault = tempfile::tempdir().unwrap();
    let prompt = PlaylistPrompt(Mutex::new(VecDeque::from([Some(vec![
        "V0000000000".into(),
        "V0000000001".into(),
    ])])));
    let nested_batch = Completion {
        content: None,
        tool_calls: vec![
            ToolCall {
                id: "nested-select".into(),
                name: "select_playlist_videos".into(),
                arguments: r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-replacement"}"#.into(),
            },
            ToolCall {
                id: "stale-after-nested".into(),
                name: "write_note".into(),
                arguments: r#"{"rel_path":"must-not-exist.md","content":"stale","kind":"literature","work_item":0}"#.into(),
            },
        ],
    };
    let write_turn = |work_item: usize| Completion {
        content: None,
        tool_calls: ["literature", "transcript"]
            .into_iter()
            .map(|kind| ToolCall {
                id: format!("item-{work_item}-{kind}"),
                name: "write_note".into(),
                arguments: serde_json::json!({
                    "rel_path": format!("item-{work_item}-{kind}.md"),
                    "content": format!("# Item {work_item} {kind}"),
                    "kind": kind,
                    "work_item": work_item,
                })
                .to_string(),
            })
            .collect(),
    };
    let llm = MockLlmClient::new(
        vec![
            tool_call(
                "select",
                "select_playlist_videos",
                r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-guarded_2"}"#,
            ),
            nested_batch,
            write_turn(0),
            write_turn(1),
        ],
        "Playlist complete.",
    );
    let io = GuardedPlaylistIo::default();
    let retriever = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = youtube_test_environment();
    let services = SkillServices::new(&skills, &environment, &prompt, &FsWriter, 1)
        .with_approval(
            unattended_policy(),
            &TEST_APPROVAL_PROMPT,
            &TEST_APPROVAL_CLASSIFIER,
        )
        .with_youtube_io(&io);
    let mut sink = VecSink::default();
    let ledger = block_on(run_chat(
        "Distil this playlist",
        &[],
        vec![YOUTUBE_DISTIL_SKILL_ID.into()],
        vault.path(),
        "test-model",
        &retriever,
        &llm,
        &services,
        &mut sink,
        &Guards::default(),
    ))
    .unwrap();

    assert_eq!(io.enumerations.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(ledger.entries().len(), 4);
    assert!(!vault.path().join("must-not-exist.md").exists());
    assert!(!sink.events.iter().any(|event| {
        matches!(event, ChatEvent::SkillStep { message } if message.contains("failed"))
    }));
    let final_context = llm
        .streaming_messages()
        .iter()
        .filter_map(|message| message.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(final_context.matches("stale_playlist_batch").count(), 1);
    assert!(final_context.contains("V0000000000: succeeded"));
    assert!(final_context.contains("V0000000001: succeeded"));
}

fn run(root: &Path, mock: &MockLlmClient, guards: &Guards) -> Vec<ChatEvent> {
    run_with_provider(root, &KeywordRetriever::new(root), mock, guards)
}

/// A provider whose every vault operation blows up the way a real one does
/// when the disk goes away mid-run: the call is dispatched, reaches the
/// vault, and fails there. Nothing here is a validation refusal.
struct FailingProvider;

impl RetrievalProvider for FailingProvider {
    fn list_notes(&self, _folder: Option<&str>) -> CoreResult<ListOutcome> {
        Err(CoreError::Io("the vault volume disappeared".into()))
    }
    fn list_folders(&self) -> CoreResult<Vec<FolderMeta>> {
        Err(CoreError::Io("the vault volume disappeared".into()))
    }
    fn search_notes(
        &self,
        _query: &str,
        _max_results: usize,
        _folder: Option<&str>,
    ) -> CoreResult<SearchOutcome> {
        Err(CoreError::Io("the vault volume disappeared".into()))
    }
    fn read_note_span(
        &self,
        _rel_path: &str,
        _start_line: u32,
        _end_line: u32,
        _max_bytes: usize,
    ) -> CoreResult<crate::ai::evidence::EvidenceSpan> {
        Err(CoreError::Io("the vault volume disappeared".into()))
    }
}

/// How the timeline node for `call_id` settled.
fn settled_status(events: &[ChatEvent], call_id: &str) -> ToolStatus {
    events
        .iter()
        .find_map(|event| match event {
            ChatEvent::ToolResult { id, status, .. } if id == call_id => Some(*status),
            _ => None,
        })
        .unwrap_or_else(|| panic!("call '{call_id}' never settled"))
}

/// The bounded disclosure the timeline node shows under a settled call.
fn settled_detail(events: &[ChatEvent], call_id: &str) -> String {
    events
        .iter()
        .find_map(|event| match event {
            ChatEvent::ToolResult { id, detail, .. } if id == call_id => Some(detail.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("call '{call_id}' never settled"))
        .unwrap_or_default()
}

/// A provider whose every vault call answers the way the shell's run-scoped
/// wrapper does once the user has pressed Stop: a `CoreError::Conflict`
/// raised by `ensure_run_active`
/// (`app/desktop/src-tauri/src/skills/note_writer.rs`), not by anything in
/// the vault going wrong.
struct StoppedRunProvider;

impl StoppedRunProvider {
    fn stopped<T>() -> CoreResult<T> {
        Err(CoreError::Conflict(
            "chat run ended before the note write completed".into(),
        ))
    }
}

impl RetrievalProvider for StoppedRunProvider {
    fn list_notes(&self, _folder: Option<&str>) -> CoreResult<ListOutcome> {
        Self::stopped()
    }
    fn list_folders(&self) -> CoreResult<Vec<FolderMeta>> {
        Self::stopped()
    }
    fn search_notes(
        &self,
        _query: &str,
        _max_results: usize,
        _folder: Option<&str>,
    ) -> CoreResult<SearchOutcome> {
        Self::stopped()
    }
    fn read_note_span(
        &self,
        _rel_path: &str,
        _start_line: u32,
        _end_line: u32,
        _max_bytes: usize,
    ) -> CoreResult<crate::ai::evidence::EvidenceSpan> {
        Self::stopped()
    }
}

#[test]
fn a_call_cut_short_by_the_user_pressing_stop_is_not_reported_as_a_failure() {
    // `CoreError::Conflict` has three unrelated producers and only one of
    // them is breakage. Two are not: the `write_note` cap refusal, and this
    // one — the run-scoped wrapper answering "the run ended" once the user
    // pressed Stop. The variant cannot separate them, so the state of the
    // RUN has to. A call that came apart while the run was already
    // cancelling did not fail, and painting a destructive-red "failed" node
    // for something the user deliberately asked for is the one account that
    // is certainly false.
    //
    // `Cancelled`, not `Rejected`: NeuralNote refused nothing either. The
    // timeline already renders that status as "run ended first", in the calm
    // register, which is exactly what happened.
    let vault = vault();
    let llm = MockLlmClient::new(
        vec![Completion {
            content: None,
            tool_calls: vec![
                ToolCall {
                    id: "c1".into(),
                    name: "list_notes".into(),
                    arguments: "{}".into(),
                },
                // Both stories in ONE run, so they cannot be checked against
                // different worlds: `c2` never reached the vault, and a Stop
                // arriving afterwards does not retrospectively make the
                // model's nonsense arguments the run's fault.
                ToolCall {
                    id: "c2".into(),
                    name: "search_notes".into(),
                    arguments: r#"{"not_a_query":1}"#.into(),
                },
            ],
        }],
        "The run ended early.",
    );
    let cancellation = CaptureCancellation::default();
    cancellation.cancel();

    let events = run_with_provider_and_cancellation(
        vault.path(),
        &StoppedRunProvider,
        &llm,
        &Guards::default(),
        cancellation,
    );

    assert_eq!(
        settled_status(&events, "c1"),
        ToolStatus::Cancelled,
        "a user's own Stop is neither a failure nor a refusal"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, ChatEvent::PartialRun { .. }))
            .count(),
        1,
        "stopping mid-run must announce PartialRun once, not leave the UI to infer it"
    );
    assert_eq!(
        settled_status(&events, "c2"),
        ToolStatus::Rejected,
        "a refusal stays a refusal: nothing was attempted, so the run ending changes nothing about it"
    );
    // Nothing is swallowed to buy the gentler status. The disclosure still
    // carries the underlying error, so a genuine fault that happened to
    // coincide with a Stop is still there to read — only the attribution
    // changes.
    assert!(
        settled_detail(&events, "c1").contains("chat run ended"),
        "the underlying error must survive the re-attribution, got {:?}",
        settled_detail(&events, "c1")
    );
}

#[test]
fn the_same_conflict_in_a_live_run_still_settles_as_a_failure() {
    // The mirror, and the reason the test above cannot be satisfied by a
    // guard that simply never reports failures. An atomic-note collision is
    // the third `Conflict` producer and it IS breakage — the run is live,
    // nobody stopped anything, and calling that "run ended first" would be
    // the same false attribution pointed the other way.
    let vault = vault();
    let llm = MockLlmClient::new(vec![tool_call("c1", "list_notes", "{}")], "Nothing found.");

    let events = run_with_provider(vault.path(), &StoppedRunProvider, &llm, &Guards::default());

    assert_eq!(
        settled_status(&events, "c1"),
        ToolStatus::Error,
        "a conflict in a run nobody stopped is still a failure"
    );
}

#[test]
fn every_vault_tool_that_ran_and_failed_settles_as_an_error_not_a_refusal() {
    // Issue #116. Each of these reached the vault and the vault blew up.
    // Settling that as `Rejected` renders "· refused by NeuralNote", telling
    // the user NeuralNote DECLINED a call it in fact attempted — the one
    // account that is definitely false.
    //
    // All four read-only tools are pinned, not just the one that happened to
    // have a test: they share the `settle_vault_error` seam, so a regression
    // in any of them is the same regression.
    let vault = vault();
    let calls = [
        ("c1", tools::TOOL_SEARCH_NOTES, r#"{"query":"widgets"}"#),
        ("c2", tools::TOOL_LIST_NOTES, "{}"),
        ("c3", tools::TOOL_LIST_FOLDERS, "{}"),
        (
            "c4",
            tools::TOOL_READ_NOTE_SPAN,
            r#"{"rel_path":"Research/widgets.md","start_line":1,"end_line":2}"#,
        ),
    ];
    let llm = MockLlmClient::new(
        vec![Completion {
            content: None,
            tool_calls: calls
                .iter()
                .map(|(id, name, arguments)| ToolCall {
                    id: (*id).into(),
                    name: (*name).into(),
                    arguments: (*arguments).into(),
                })
                .collect(),
        }],
        "Nothing found.",
    );

    let events = run_with_provider(vault.path(), &FailingProvider, &llm, &Guards::default());

    for (id, name, _) in &calls {
        assert_eq!(
            settled_status(&events, id),
            ToolStatus::Error,
            "{name} ran and failed; it must not be reported as a refusal"
        );
    }
}

#[test]
fn a_malformed_argument_call_is_refused_and_never_collapses_into_a_failure() {
    // The other half of the same split, asserted in ONE run so the two
    // stories cannot be checked against different worlds: `c1` never
    // reached the vault (the model sent nonsense), `c2` did and the vault
    // failed. They must settle differently, or the status vocabulary is
    // saying one thing about two events.
    let vault = vault();
    let llm = MockLlmClient::new(
        vec![Completion {
            content: None,
            tool_calls: vec![
                ToolCall {
                    id: "c1".into(),
                    name: "search_notes".into(),
                    arguments: r#"{"not_a_query":1}"#.into(),
                },
                ToolCall {
                    id: "c2".into(),
                    name: "search_notes".into(),
                    arguments: r#"{"query":"widgets"}"#.into(),
                },
            ],
        }],
        "Nothing found.",
    );

    let events = run_with_provider(vault.path(), &FailingProvider, &llm, &Guards::default());
    let (refused, failed) = (settled_status(&events, "c1"), settled_status(&events, "c2"));

    assert_eq!(
        refused,
        ToolStatus::Rejected,
        "arguments that never parsed are a refusal, not a failure"
    );
    assert_ne!(
        refused, failed,
        "a refusal and a failure must not settle as the same status"
    );
}

fn run_with_provider(
    root: &Path,
    provider: &dyn RetrievalProvider,
    mock: &MockLlmClient,
    guards: &Guards,
) -> Vec<ChatEvent> {
    run_with_provider_and_cancellation(root, provider, mock, guards, CaptureCancellation::default())
}

/// The same run with the host's cancellation token supplied, for the cases
/// where what a settled call MEANS depends on whether the run is still live.
fn run_with_provider_and_cancellation(
    root: &Path,
    provider: &dyn RetrievalProvider,
    mock: &MockLlmClient,
    guards: &Guards,
    cancellation: CaptureCancellation,
) -> Vec<ChatEvent> {
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 1,
            cpu_cores: 1,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 1,
        },
        app_data_bin_dir: std::path::PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::new(),
    };
    let services = SkillServices::new(
        &skills,
        &environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    )
    .with_capture_cancellation(cancellation);
    let mut sink = VecSink::default();
    block_on(run_chat(
        "how do widgets work?",
        &[],
        Vec::new(),
        root,
        "test-model",
        provider,
        mock,
        &services,
        &mut sink,
        guards,
    ))
    .unwrap();
    sink.events
}

/* ────────────────  Plan declaration, and what the run cost  ──────────────── */

/// A client that prices every turn, so a run can be totalled end to end.
///
/// It reports through the sink it is handed — which is whatever wrapper stack
/// the orchestrator has built around it — so a test using it exercises
/// propagation through the real stack rather than a shortcut into the meter.
struct MeteredLlm {
    completions: Mutex<VecDeque<Completion>>,
    tool_turn_usage: Option<TokenUsage>,
    answer_usage: Option<TokenUsage>,
}

impl MeteredLlm {
    fn new(
        completions: Vec<Completion>,
        tool_turn_usage: Option<TokenUsage>,
        answer_usage: Option<TokenUsage>,
    ) -> Self {
        Self {
            completions: Mutex::new(completions.into()),
            tool_turn_usage,
            answer_usage,
        }
    }
}

#[async_trait]
impl LlmClient for MeteredLlm {
    async fn complete(&self, _req: &LlmRequest) -> CoreResult<Completion> {
        unreachable!("the tool turn is streamed here, so `complete` is never reached")
    }

    async fn complete_tool_streaming(
        &self,
        _req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<Completion> {
        sink.record_usage(self.tool_turn_usage);
        Ok(self
            .completions
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(final_turn))
    }

    async fn complete_streaming(
        &self,
        _req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<String> {
        sink.send(ChatEvent::Answer {
            delta: "ready".into(),
        });
        sink.record_usage(self.answer_usage);
        Ok("ready".into())
    }
}

fn run_metered(root: &Path, llm: &MeteredLlm) -> Vec<ChatEvent> {
    let retriever = KeywordRetriever::new(root);
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 1,
            cpu_cores: 1,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 1,
        },
        app_data_bin_dir: std::path::PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::new(),
    };
    let services = SkillServices::new(
        &skills,
        &environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    );
    let mut sink = VecSink::default();
    block_on(run_chat(
        "how do widgets work?",
        &[],
        Vec::new(),
        root,
        "test-model",
        &retriever,
        llm,
        &services,
        &mut sink,
        &Guards::default(),
    ))
    .unwrap();
    sink.events
}

fn plan_call(id: &str, steps: serde_json::Value) -> Completion {
    tool_call(
        id,
        tools::TOOL_UPDATE_PLAN,
        &serde_json::json!({ "steps": steps }).to_string(),
    )
}

fn usage_events(events: &[ChatEvent]) -> Vec<&ChatEvent> {
    events
        .iter()
        .filter(|event| matches!(event, ChatEvent::Usage { .. }))
        .collect()
}

fn plan_transitions(events: &[ChatEvent]) -> Vec<(&str, StepStatus)> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::PlanStepStatus { id, status } => Some((id.as_str(), *status)),
            _ => None,
        })
        .collect()
}

#[test]
fn a_run_where_the_model_declares_no_plan_emits_no_plan_events() {
    // The common case, and the whole reason this phase is last: a model that
    // never plans must produce exactly the run it produced before plans
    // existed — not an empty plan, not a placeholder step.
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MockLlmClient::new(
        vec![tool_call("c1", "search_notes", r#"{"query":"widgets"}"#)],
        "Widgets spin [e1].",
    );
    let events = run(vault.path(), &llm, &Guards::default());

    assert_eq!(
        count(&events, |e| matches!(
            e,
            ChatEvent::Plan { .. } | ChatEvent::PlanStepStatus { .. }
        )),
        0
    );
    assert!(matches!(events.last(), Some(ChatEvent::Done)));
}

#[test]
fn a_declared_plan_reaches_the_timeline_with_its_steps_pending() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MockLlmClient::new(
        vec![
            plan_call(
                "p1",
                serde_json::json!([
                    { "id": "s1", "label": "Search the vault", "status": "running" },
                    { "id": "s2", "label": "Read the best matches" },
                ]),
            ),
            tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
        ],
        "Widgets spin [e1].",
    );
    let events = run(vault.path(), &llm, &Guards::default());

    let declared = events
        .iter()
        .find_map(|event| match event {
            ChatEvent::Plan { steps } => Some(steps.clone()),
            _ => None,
        })
        .expect("the declared plan reaches the timeline");
    assert_eq!(
        declared,
        vec![
            PlanStep {
                id: "s1".into(),
                label: "Search the vault".into()
            },
            PlanStep {
                id: "s2".into(),
                label: "Read the best matches".into()
            },
        ]
    );
    // Only the departure from pending is announced; `s2` is pending by
    // virtue of having been declared.
    assert_eq!(plan_transitions(&events), vec![("s1", StepStatus::Running)]);
}

#[test]
fn a_plan_whose_steps_are_skipped_or_fail_reports_both_endings() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let steps = |first: &str, second: &str| {
        serde_json::json!([
            { "id": "s1", "label": "Search the vault", "status": first },
            { "id": "s2", "label": "Transcribe the talk", "status": second },
        ])
    };
    let llm = MockLlmClient::new(
        vec![
            plan_call("p1", steps("running", "pending")),
            plan_call("p2", steps("failed", "skipped")),
            tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
        ],
        "Widgets spin [e1].",
    );
    let events = run(vault.path(), &llm, &Guards::default());

    assert_eq!(
        plan_transitions(&events),
        vec![
            ("s1", StepStatus::Running),
            ("s1", StepStatus::Failed),
            ("s2", StepStatus::Skipped),
        ],
        "a step that was abandoned and one that broke are two different accounts"
    );
    // One declaration, however many times the plan is re-sent.
    assert_eq!(count(&events, |e| matches!(e, ChatEvent::Plan { .. })), 1);
}

#[test]
fn re_declaring_a_different_plan_is_refused_in_full_view() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MockLlmClient::new(
        vec![
            plan_call(
                "p1",
                serde_json::json!([{ "id": "s1", "label": "Search the vault" }]),
            ),
            plan_call(
                "p2",
                serde_json::json!([{ "id": "s9", "label": "Something else" }]),
            ),
            tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
        ],
        "Widgets spin [e1].",
    );
    let events = run(vault.path(), &llm, &Guards::default());

    // Refused, and visibly so — the node settles `rejected` rather than the
    // call quietly succeeding against a plan it did not change.
    assert!(events.iter().any(|event| matches!(
        event,
        ChatEvent::ToolResult { id, status, detail, .. }
            if id == "p2"
                && *status == ToolStatus::Rejected
                && detail.as_deref().is_some_and(|d| d.contains("declared once"))
    )));
    assert_eq!(count(&events, |e| matches!(e, ChatEvent::Plan { .. })), 1);
}

/// Every announced call as `(id, step_id)`, in emission order — the pairing
/// the timeline nests on.
fn call_affiliations(events: &[ChatEvent]) -> Vec<(&str, Option<&str>)> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::ToolCall { id, step_id, .. } => Some((id.as_str(), step_id.as_deref())),
            _ => None,
        })
        .collect()
}

#[test]
fn a_tool_dispatched_under_a_running_step_is_affiliated_with_it() {
    // `s2` is pinned as a literal on purpose: reading the expectation back
    // out of the same `RunPlan` the code read it from would compare a value
    // against its own source and pass whatever the affiliation logic did.
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MockLlmClient::new(
        vec![
            plan_call(
                "p1",
                serde_json::json!([
                    { "id": "s1", "label": "Plan the work", "status": "done" },
                    { "id": "s2", "label": "Search the vault", "status": "running" },
                    { "id": "s3", "label": "Answer", "status": "pending" },
                ]),
            ),
            tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
        ],
        "Widgets spin [e1].",
    );
    let events = run(vault.path(), &llm, &Guards::default());

    assert_eq!(
        call_affiliations(&events),
        vec![
            // The plan call itself went out before any plan existed.
            ("p1", None),
            ("c1", Some("s2")),
        ]
    );
}

#[test]
fn a_run_with_no_plan_leaves_every_tool_call_unaffiliated() {
    // Unaffiliated is ordinary, not a failure — and the turn still folds and
    // answers exactly as it did before plans existed.
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
            tool_call(
                "c2",
                "read_note_span",
                r#"{"rel_path":"w.md","start_line":1,"end_line":1}"#,
            ),
        ],
        "Widgets spin [e1].",
    );
    let events = run(vault.path(), &llm, &Guards::default());

    assert_eq!(call_affiliations(&events), vec![("c1", None), ("c2", None)]);
    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Plan { .. })),
        0,
        "no plan was declared, so none may be synthesised"
    );
    // The pre-plan run is unchanged: it still searches, reads, verifies,
    // cites and completes.
    assert!(count(&events, |e| matches!(e, ChatEvent::Answer { .. })) >= 1);
    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Citation { .. })),
        1
    );
    assert!(matches!(events.last(), Some(ChatEvent::Done)));
}

#[test]
fn a_plan_declared_after_a_call_does_not_retroactively_affiliate_it() {
    // The affiliation is a fact about WHEN the call was dispatched, so it is
    // stamped then. An implementation that resolved it at render time — or
    // re-read the plan once the run finished — would hand `c1` the step that
    // was running later, and this is the test that catches it.
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
            plan_call(
                "p1",
                serde_json::json!([
                    { "id": "s1", "label": "Read the best matches", "status": "running" },
                ]),
            ),
            tool_call(
                "c2",
                "read_note_span",
                r#"{"rel_path":"w.md","start_line":1,"end_line":1}"#,
            ),
        ],
        "Widgets spin [e1].",
    );
    let events = run(vault.path(), &llm, &Guards::default());

    assert_eq!(
        call_affiliations(&events),
        vec![
            // Dispatched before the plan existed, and it stays that way.
            ("c1", None),
            // The declaring call is itself pre-plan.
            ("p1", None),
            ("c2", Some("s1")),
        ]
    );
}

#[test]
fn a_tool_result_still_settles_its_call_across_a_step_boundary() {
    // Settlement correlates on `id` alone. A step that moves on between the
    // call and its result must not leave the node spinning.
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MockLlmClient::new(
        vec![
            plan_call(
                "p1",
                serde_json::json!([
                    { "id": "s1", "label": "Search the vault", "status": "running" },
                    { "id": "s2", "label": "Read the best matches" },
                ]),
            ),
            tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
            plan_call(
                "p2",
                serde_json::json!([
                    { "id": "s1", "label": "Search the vault", "status": "done" },
                    { "id": "s2", "label": "Read the best matches", "status": "running" },
                ]),
            ),
            tool_call(
                "c2",
                "read_note_span",
                r#"{"rel_path":"w.md","start_line":1,"end_line":1}"#,
            ),
        ],
        "Widgets spin [e1].",
    );
    let events = run(vault.path(), &llm, &Guards::default());

    assert_eq!(
        call_affiliations(&events),
        vec![
            ("p1", None),
            ("c1", Some("s1")),
            ("p2", Some("s1")),
            ("c2", Some("s2"))
        ]
    );
    for id in ["p1", "c1", "p2", "c2"] {
        assert_eq!(
            count(&events, |e| matches!(
                e,
                ChatEvent::ToolResult { id: settled, .. } if settled == id
            )),
            1,
            "call '{id}' did not settle exactly once"
        );
    }
}

#[test]
fn usage_is_emitted_exactly_once_immediately_before_done() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MockLlmClient::new(
        vec![tool_call("c1", "search_notes", r#"{"query":"widgets"}"#)],
        "Widgets spin [e1].",
    );
    let events = run(vault.path(), &llm, &Guards::default());

    assert_eq!(usage_events(&events).len(), 1);
    assert!(matches!(
        events.as_slice(),
        [.., ChatEvent::Usage { .. }, ChatEvent::Done]
    ));
}

#[test]
fn usage_is_emitted_exactly_once_immediately_before_a_terminal_error() {
    // `Done` is not the only way a run ends, and an errored run is exactly when
    // the cost matters most: it spent tokens and produced nothing. The footer
    // must therefore take the same position before `Error` that it holds
    // before `Done` — not merely appear somewhere in the stream.
    let v = vault();
    let mock = MockLlmClient::failing();
    let events = run(v.path(), &mock, &Guards::default());

    assert_eq!(usage_events(&events).len(), 1);
    assert!(matches!(
        events.as_slice(),
        [.., ChatEvent::Usage { .. }, ChatEvent::Error { .. }]
    ));
}

#[test]
fn a_run_that_errors_after_a_successful_tool_call_still_reports_usage() {
    // The observed failure (#123): a tool call landed, the model then returned
    // an empty answer, and the settled turn carried no footer at all.
    let v = vault();
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"components"}"#),
            final_turn(),
        ],
        "   ",
    );
    let events = run(v.path(), &mock, &Guards::default());

    assert!(
        events.iter().any(|e| matches!(
            e,
            ChatEvent::ToolResult {
                status: ToolStatus::Ok,
                ..
            }
        )),
        "the run must reach the error with a settled, successful tool call behind it"
    );
    assert!(matches!(
        events.as_slice(),
        [.., ChatEvent::Usage { .. }, ChatEvent::Error { .. }]
    ));
    match usage_events(&events).as_slice() {
        [ChatEvent::Usage {
            tokens_in,
            tokens_out,
            ..
        }] => {
            // The mock prices nothing, and absent must stay absent here: a `0`
            // would claim a measurement this run never made.
            assert_eq!(*tokens_in, None);
            assert_eq!(*tokens_out, None);
        }
        other => panic!("expected one Usage event, got {other:?}"),
    }
}

#[test]
fn a_run_that_ends_twice_over_reports_usage_once() {
    // Two terminal events through one meter. Asserted on the stream the sink
    // actually received — the flag guarding it is an implementation detail.
    let mut sink = VecSink::default();
    let mut meter = UsageMeter::new(&mut sink, Instant::now(), "test-model");
    meter.send(ChatEvent::Error {
        message: "boom".into(),
    });
    meter.send(ChatEvent::Done);

    assert!(matches!(
        sink.events.as_slice(),
        [
            ChatEvent::Usage { .. },
            ChatEvent::Error { .. },
            ChatEvent::Done
        ]
    ));
}

#[test]
fn an_unmetered_run_reports_absent_token_counts_rather_than_zero() {
    // `MockLlmClient` never prices a turn, exactly like a provider that does
    // not report usage. A `0` here would read as a real measurement of a run
    // that cost nothing — the failure this phase exists to prevent.
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MockLlmClient::new(
        vec![tool_call("c1", "search_notes", r#"{"query":"widgets"}"#)],
        "Widgets spin [e1].",
    );
    let events = run(vault.path(), &llm, &Guards::default());

    match usage_events(&events).as_slice() {
        [ChatEvent::Usage {
            tokens_in,
            tokens_out,
            model,
            ..
        }] => {
            assert_eq!(*tokens_in, None);
            assert_eq!(*tokens_out, None);
            assert_eq!(model, "test-model");
        }
        other => panic!("expected one Usage event, got {other:?}"),
    }
}

#[test]
fn usage_survives_the_whole_sink_stack_and_totals_every_turn() {
    // The check behind `EventSink::record_usage`'s discarding default: the run
    // builds a stack of wrapper sinks, and one that forgot to forward would
    // cost the footer its numbers silently. Two priced turn kinds must arrive
    // as their sum, through the whole stack, not as the answer turn alone.
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MeteredLlm::new(
        vec![tool_call("c1", "search_notes", r#"{"query":"widgets"}"#)],
        Some(TokenUsage {
            tokens_in: 100,
            tokens_out: 20,
        }),
        Some(TokenUsage {
            tokens_in: 400,
            tokens_out: 5,
        }),
    );
    let events = run_metered(vault.path(), &llm);

    match usage_events(&events).as_slice() {
        [ChatEvent::Usage {
            tokens_in,
            tokens_out,
            ..
        }] => {
            // Two tool turns run (the search, then the turn that stops calling
            // tools), so the total covers every priced call, not just the last.
            assert_eq!(*tokens_in, Some(100 + 100 + 400));
            assert_eq!(*tokens_out, Some(20 + 20 + 5));
        }
        other => panic!("expected one Usage event, got {other:?}"),
    }
}

#[test]
fn one_unpriced_call_makes_the_whole_run_absent_rather_than_understated() {
    // A total that silently omits a turn is a wrong number, and a wrong number
    // in a cost footer is worse than no number at all.
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("w.md"), "Widgets spin.").unwrap();
    let llm = MeteredLlm::new(
        vec![tool_call("c1", "search_notes", r#"{"query":"widgets"}"#)],
        None,
        Some(TokenUsage {
            tokens_in: 400,
            tokens_out: 5,
        }),
    );
    let events = run_metered(vault.path(), &llm);

    match usage_events(&events).as_slice() {
        [ChatEvent::Usage {
            tokens_in,
            tokens_out,
            ..
        }] => {
            assert_eq!(*tokens_in, None, "400 would be the answer turn alone");
            assert_eq!(*tokens_out, None);
        }
        other => panic!("expected one Usage event, got {other:?}"),
    }
}

#[test]
fn a_usage_report_does_not_count_as_something_the_user_has_seen() {
    // `EmissionGuard` bars a retry once anything has been emitted. A token
    // report is not visible, so it must pass through without barring one —
    // otherwise the trait default's `record_usage(None)` would silently
    // disable every tool-turn retry.
    struct BufferedToolTurn;
    #[async_trait]
    impl LlmClient for BufferedToolTurn {
        async fn complete(&self, _req: &LlmRequest) -> CoreResult<Completion> {
            Ok(final_turn())
        }
        async fn complete_streaming(
            &self,
            _req: &LlmRequest,
            _sink: &mut dyn EventSink,
        ) -> CoreResult<String> {
            Ok("ready".into())
        }
    }

    let mut sink = VecSink::default();
    let mut guard = EmissionGuard {
        inner: &mut sink,
        emitted: false,
    };
    block_on(BufferedToolTurn.complete_tool_streaming(
        &LlmRequest {
            model: "m".into(),
            messages: Vec::new(),
            tools: Vec::new(),
        },
        &mut guard,
    ))
    .unwrap();
    assert!(!guard.emitted);
}

#[test]
fn terminal_skill_recovery_finishes_every_parallel_tool_result_before_stopping() {
    let vault = tempfile::tempdir().unwrap();
    let provider = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 16_000_000_000,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 10_000_000_000,
        },
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::new(),
    };
    let calls = vec![
        ToolCall {
            id: "missing-ytdlp".into(),
            name: tools::TOOL_USE_SKILL.into(),
            arguments: format!(r#"{{"id":"{YOUTUBE_DISTIL_SKILL_ID}"}}"#),
        },
        ToolCall {
            id: "sibling-skill".into(),
            name: tools::TOOL_USE_SKILL.into(),
            arguments: format!(r#"{{"id":"{}"}}"#, crate::ai::FIXTURE_SKILL_ID),
        },
    ];
    let llm = MockLlmClient::new(
        vec![Completion {
            content: None,
            tool_calls: calls.clone(),
        }],
        "must not stream",
    );
    let services = SkillServices::new(
        &skills,
        &environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    );
    let guards = Guards::default();
    let session = ChatSession {
        root: vault.path(),
        model: "test-model",
        provider: &provider,
        llm: &llm,
        skill_services: &services,
        guards: &guards,
    };
    let mut messages = vec![LlmMessage::system("system"), LlmMessage::user("capture")];
    let mut active_skills = ActiveSkills::new(guards.max_iterations);
    let mut writes = WriteSession::new(1).unwrap();
    let mut youtube_session = YoutubeToolSession::new_with_update_session(
        services.capture_cancellation.clone(),
        services.extractor_updates.clone(),
    );
    let mut registry = EvidenceRegistry::new();
    let mut coverage = CoverageAcc::default();
    let mut sink = VecSink::default();

    let outcome = block_on(session.collect_evidence(
        &mut messages,
        &mut active_skills,
        &mut writes,
        &mut youtube_session,
        &mut RunPlan::default(),
        &mut registry,
        &mut coverage,
        &mut open_gate(),
        &mut sink,
    ))
    .unwrap();

    assert!(matches!(outcome, EvidenceCollection::CompleteTurn));
    assert_eq!(llm.completion_requests().len(), 1);
    assert!(llm.streaming_messages().is_empty());
    assert!(!sink
        .events
        .iter()
        .any(|event| matches!(event, ChatEvent::Verifying | ChatEvent::Answer { .. })));
    let result_ids = messages
        .iter()
        .filter(|message| message.role == Role::Tool)
        .filter_map(|message| message.tool_call_id.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(result_ids, ["missing-ytdlp", "sibling-skill"]);
    assert!(active_skills.contains(crate::ai::FIXTURE_SKILL_ID));
}

fn count(events: &[ChatEvent], pred: impl Fn(&ChatEvent) -> bool) -> usize {
    events.iter().filter(|e| pred(e)).count()
}

// ── §7 behavioural eval — plumbing tier ─────────────────────────────────
// The five spec-§7 cases run against the scripted MockLlmClient. Because the
// SCRIPT (not the model) decides whether a tool call fires, this tier proves
// PLUMBING only: the orchestrator injects no mandatory retrieval before the
// model's first turn (a no-tool script yields zero Searching), a zero-search
// turn emits no Coverage, and search/citation counts flow through intact. It
// CANNOT prove the model chooses to search — that is the network-gated
// real-model tier in app/desktop/src-tauri/tests/behavioural_eval.rs.
//
// The zero-search-but-still-emit-Coverage guardrail (a list-only run tripping a
// guard or skipping files) is already proven by
// coverage_still_reports_a_tripped_guard_with_no_searches and
// coverage_still_reports_skipped_files_with_no_searches — not duplicated here.
#[test]
fn eval_plumbs_the_five_section_7_cases_through_the_mock() {
    struct EvalCase {
        label: &'static str,
        script: Vec<Completion>,
        answer: &'static str,
        search_bounds: std::ops::RangeInclusive<usize>,
        citation_bounds: std::ops::RangeInclusive<usize>,
        coverage_bounds: std::ops::RangeInclusive<usize>,
    }

    let cases = [
        EvalCase {
            label: "Case 1 Greeting",
            script: vec![final_turn()],
            answer: "Hey! What would you like to explore?",
            search_bounds: 0..=0,
            citation_bounds: 0..=0,
            coverage_bounds: 0..=0,
        },
        EvalCase {
            label: "Case 2 Meta",
            script: vec![final_turn()],
            answer: "I can help you think with and search your notes.",
            search_bounds: 0..=0,
            citation_bounds: 0..=0,
            coverage_bounds: 0..=0,
        },
        EvalCase {
            label: "Case 3 Factual-in-vault",
            script: vec![
                tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                tool_call(
                    "c2",
                    "read_note_span",
                    r#"{"rel_path":"Research/widgets.md","start_line":1,"end_line":2}"#,
                ),
                final_turn(),
            ],
            answer: "Widgets are small components. [e1]",
            search_bounds: 1..=usize::MAX,
            citation_bounds: 1..=usize::MAX,
            coverage_bounds: 1..=usize::MAX,
        },
        EvalCase {
            label: "Case 4 Factual-not-in-vault",
            script: vec![
                tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                final_turn(),
            ],
            answer: "Nothing in your notes covers this yet — add a note and I'll answer next time.",
            search_bounds: 1..=usize::MAX,
            citation_bounds: 0..=0,
            coverage_bounds: 1..=usize::MAX,
        },
        EvalCase {
            label: "Case 5 Follow-up",
            script: vec![final_turn()],
            answer: "Widgets are small parts.",
            search_bounds: 0..=0,
            citation_bounds: 0..=0,
            coverage_bounds: 0..=0,
        },
    ];

    for EvalCase {
        label,
        script,
        answer,
        search_bounds,
        citation_bounds,
        coverage_bounds,
    } in cases
    {
        let v = vault();
        let mock = MockLlmClient::new(script, answer);
        let events = run(v.path(), &mock, &Guards::default());

        let searches = count(&events, |event| {
            matches!(event, ChatEvent::Searching { .. })
        });
        let citations = count(&events, |event| matches!(event, ChatEvent::Citation { .. }));
        let coverage = count(&events, |event| matches!(event, ChatEvent::Coverage { .. }));

        assert!(
            search_bounds.contains(&searches),
            "{label}: expected Searching count in {search_bounds:?}, got {searches}"
        );
        assert!(
            citation_bounds.contains(&citations),
            "{label}: expected Citation count in {citation_bounds:?}, got {citations}"
        );
        assert!(
            coverage_bounds.contains(&coverage),
            "{label}: expected Coverage count in {coverage_bounds:?}, got {coverage}"
        );

        let last = events.last();
        assert!(
            matches!(last, Some(ChatEvent::Done)),
            "{label}: last event must be Done, got {last:?}"
        );
    }
}

#[test]
fn happy_path_searches_reads_and_emits_a_verified_citation() {
    let v = vault();
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"components"}"#),
            tool_call(
                "c2",
                "read_note_span",
                r#"{"rel_path":"Research/widgets.md","start_line":1,"end_line":2}"#,
            ),
            final_turn(),
        ],
        "Widgets are small components that snap together [e1].",
    );
    let events = run(v.path(), &mock, &Guards::default());

    assert!(matches!(events.first(), Some(ChatEvent::Processing)));
    // `Processing` means "the run was accepted" and says it exactly once. The
    // per-round beacon is `PlanningRound`, which carries a round number and so
    // cannot read as a fresh start when it repeats.
    assert_eq!(
        count(&events, |event| matches!(event, ChatEvent::Processing)),
        1
    );
    // One round beacon before each tool-deciding turn (#126) — never one per row
    // of anything. Counted from the turns the mock was actually asked for rather
    // than written as a number, so the bound is on the RATE rather than on this
    // script's length.
    //
    // What it does NOT bound is beacons per ATTEMPT. Nothing in this run
    // fails, so one `complete` call is one turn is one round-trip, and a
    // beacon moved inside the retry loop would lift both sides of this
    // equality together and leave the fixture green. That property — one
    // beacon per CALL, not per try — is pinned by
    // `a_streamed_tool_turn_that_failed_before_emitting_is_still_retried_once`,
    // which retries once and still admits exactly one.
    assert_eq!(
        count(&events, |event| matches!(
            event,
            ChatEvent::PlanningRound { .. }
        )),
        mock.completion_requests().len()
    );
    // The rounds count up from 1 and never restart, and no round ever exceeds
    // the ceiling it was measured against.
    let rounds: Vec<(u32, u32)> = events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::PlanningRound { round, max_rounds } => Some((*round, *max_rounds)),
            _ => None,
        })
        .collect();
    for (index, (round, max_rounds)) in rounds.iter().enumerate() {
        assert_eq!(
            *round,
            u32::try_from(index).unwrap() + 1,
            "rounds are 1-based and strictly increasing: {rounds:?}"
        );
        assert!(round <= max_rounds, "round {round} of {max_rounds}");
    }
    assert!(events
        .iter()
        .any(|e| matches!(e, ChatEvent::Searching { query, .. } if query == "components")));
    assert!(events
        .iter()
        .any(|e| matches!(e, ChatEvent::Retrieved { hit_count, .. } if *hit_count == 1)));
    assert!(events.iter().any(
        |e| matches!(e, ChatEvent::Reading { rel_path, start_line, end_line, .. }
        if rel_path == "Research/widgets.md" && *start_line == 1 && *end_line == 2)
    ));
    assert!(events.iter().any(|e| matches!(e, ChatEvent::Verifying)));
    assert!(count(&events, |e| matches!(e, ChatEvent::Answer { .. })) >= 1);
    assert!(events.iter().any(
        |e| matches!(e, ChatEvent::Citation { id, rel_path, start_line, text, .. }
        if id == "e1" && rel_path == "Research/widgets.md" && *start_line == 3
            && text == "Widgets are small components.")
    ));
    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::CitationDropped { .. })),
        0
    );
    assert!(matches!(events.last(), Some(ChatEvent::Done)));

    // Event ordering: search cue precedes retrieval; verify precedes citation.
    let pos = |pred: fn(&ChatEvent) -> bool| events.iter().position(pred).unwrap();
    assert!(
        pos(|e| matches!(e, ChatEvent::PlanningRound { .. }))
            < pos(|e| matches!(e, ChatEvent::Searching { .. }))
    );
    assert!(
        pos(|e| matches!(e, ChatEvent::Searching { .. }))
            < pos(|e| matches!(e, ChatEvent::Retrieved { .. }))
    );
    assert!(
        pos(|e| matches!(e, ChatEvent::Verifying))
            < pos(|e| matches!(e, ChatEvent::Citation { .. }))
    );
}

#[test]
fn coverage_footer_reports_searched_terms_and_notes_read() {
    let v = vault();
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"components"}"#),
            final_turn(),
        ],
        "Answer [e1].",
    );
    let events = run(v.path(), &mock, &Guards::default());
    let coverage = events
        .iter()
        .find_map(|e| match e {
            ChatEvent::Coverage {
                searched_terms,
                notes_read,
                truncated,
                skipped_files,
            } => Some((
                searched_terms.clone(),
                notes_read.clone(),
                *truncated,
                *skipped_files,
            )),
            _ => None,
        })
        .expect("a coverage footer must be emitted");
    assert_eq!(coverage.0, vec!["components".to_string()]);
    assert_eq!(coverage.1, vec!["Research/widgets.md".to_string()]);
    assert!(!coverage.2);
    assert_eq!(coverage.3, 0);
}

#[test]
fn no_evidence_answer_emits_no_citations() {
    let v = vault();
    // The model answers immediately without searching.
    let mock = MockLlmClient::new(vec![final_turn()], "I couldn't find this in your vault.");
    let events = run(v.path(), &mock, &Guards::default());

    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Citation { .. })),
        0
    );
    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Searching { .. })),
        0
    );
    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Coverage { .. })),
        0,
        "a turn with no searches must not emit a coverage footer"
    );
    assert!(matches!(events.last(), Some(ChatEvent::Done)));
}

#[test]
fn max_iterations_guard_stops_a_runaway_loop() {
    let v = vault();
    // The model would loop forever; the guard caps it at 2 tool turns.
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
            tool_call("c2", "search_notes", r#"{"query":"components"}"#),
            tool_call("c3", "search_notes", r#"{"query":"snap"}"#),
        ],
        "Best effort [e1].",
    );
    let guards = Guards {
        max_iterations: 2,
        ..Guards::default()
    };
    let events = run(v.path(), &mock, &guards);

    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Searching { .. })),
        2,
        "the loop must stop after max_iterations tool turns"
    );
    assert!(
        matches!(events.last(), Some(ChatEvent::Done)),
        "still answers, never hangs"
    );
}

#[test]
fn guard_trip_reports_partial_coverage() {
    let v = vault();
    // The model keeps issuing tool calls; max_iterations caps it mid-search, so
    // the footer must report partial coverage rather than a full-vault read.
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
            tool_call("c2", "search_notes", r#"{"query":"components"}"#),
            tool_call("c3", "search_notes", r#"{"query":"snap"}"#),
        ],
        "Best effort [e1].",
    );
    let guards = Guards {
        max_iterations: 2,
        ..Guards::default()
    };
    let events = run(v.path(), &mock, &guards);
    assert!(
        events.iter().any(|e| matches!(
            e,
            ChatEvent::Coverage {
                truncated: true,
                ..
            }
        )),
        "an iteration-capped sweep must report truncated coverage"
    );
}

#[test]
fn guard_tripped_empty_answer_still_reports_truncated_coverage() {
    let v = vault();
    // The model keeps issuing tool calls (max_iterations caps it → partial
    // coverage) and THEN streams an empty final answer — often a symptom of the
    // cut-short sweep. The truncation footer must survive the empty-answer error
    // path, never dropped (the "never drop truncation" invariant, one layer up
    // from emit_coverage).
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
            tool_call("c2", "search_notes", r#"{"query":"components"}"#),
            tool_call("c3", "search_notes", r#"{"query":"snap"}"#),
        ],
        "",
    );
    let guards = Guards {
        max_iterations: 2,
        ..Guards::default()
    };
    let events = run(v.path(), &mock, &guards);

    assert!(
        events.iter().any(|e| matches!(
            e,
            ChatEvent::Coverage {
                truncated: true,
                ..
            }
        )),
        "a guard-tripped empty answer must still surface its truncation, got {:?}",
        events
    );
    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Error { .. })),
        1,
        "the empty-answer error still fires — the footer complements it"
    );
    // The error is terminal: no Done.
    assert_eq!(count(&events, |e| matches!(e, ChatEvent::Done)), 0);
}

#[test]
fn span_cap_stops_dispatch_within_a_turn_and_reports_partial() {
    let v = vault();
    // One turn, three searches. max_spans=1: after the first search registers a
    // span the cap fires, so the remaining two searches in the SAME turn are not
    // dispatched (the cost spike the guard exists to prevent).
    let mock = MockLlmClient::new(
        vec![multi_search(&["components", "widgets", "snap"])],
        "Answer [e1].",
    );
    let guards = Guards {
        max_spans: 1,
        ..Guards::default()
    };
    let events = run(v.path(), &mock, &guards);
    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Searching { .. })),
        1,
        "the span cap must stop further dispatch mid-turn"
    );
    assert!(events.iter().any(|e| matches!(
        e,
        ChatEvent::Coverage {
            truncated: true,
            ..
        }
    )));
}

#[test]
fn answer_turn_advertises_no_tools() {
    let v = vault();
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"components"}"#),
            final_turn(),
        ],
        "Answer [e1].",
    );
    let _ = run(v.path(), &mock, &Guards::default());
    assert_eq!(
        *mock.streaming_tools_len.lock().unwrap(),
        Some(0),
        "the final answer turn must be unambiguous — no tools advertised"
    );
}

#[test]
fn final_answer_prompt_removes_tool_protocol_but_preserves_tool_results() {
    let v = vault();
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"components"}"#),
            final_turn(),
        ],
        "Answer [e1].",
    );

    let _ = run(v.path(), &mock, &Guards::default());

    let messages = mock.streaming_messages();
    assert!(
        messages.iter().all(|message| message.role != Role::Tool),
        "the answer prompt must not retain protocol-level tool-result turns"
    );
    assert!(
        messages.iter().all(|message| message.tool_calls.is_empty()),
        "the answer prompt must not retain assistant tool calls"
    );
    let result_record = messages
        .iter()
        .find(|message| {
            message.content.as_deref().is_some_and(|content| {
                content.starts_with("Tool result record from `search_notes` (untrusted data):")
            })
        })
        .expect("the tool result must remain available as answer context");
    assert_eq!(result_record.role, Role::Assistant);
    assert!(
        result_record
            .content
            .as_deref()
            .unwrap()
            .contains("Research/widgets.md"),
        "sanitising the protocol must not discard retrieved evidence"
    );
    let final_instruction = messages.last().expect("the answer prompt has messages");
    assert_eq!(final_instruction.role, Role::System);
    assert!(final_instruction
        .content
        .as_deref()
        .is_some_and(|content| content.contains("Tool execution is complete")));
}

#[test]
fn reasoning_deltas_reach_the_sink_as_thinking_events() {
    let v = vault();
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"components"}"#),
            final_turn(),
        ],
        "Widgets snap together [e1].",
    )
    .with_reasoning(&["Let me ", "check the notes."]);
    let events = run(v.path(), &mock, &Guards::default());

    let thinking: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ChatEvent::Thinking { delta } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(thinking, vec!["Let me ", "check the notes."]);
    // Reasoning is surfaced but never conflated with the answer: the run still
    // ends cleanly and the answer's own citation verifies.
    assert!(matches!(events.last(), Some(ChatEvent::Done)));
    assert!(events
        .iter()
        .any(|e| matches!(e, ChatEvent::Citation { id, .. } if id == "e1")));
}

#[test]
fn whitespace_only_answer_after_search_emits_error_and_stops() {
    let v = vault();
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"components"}"#),
            final_turn(),
        ],
        "   ",
    );
    let events = run(v.path(), &mock, &Guards::default());

    assert_eq!(count(&events, |e| matches!(e, ChatEvent::Error { .. })), 1);
    assert!(events.iter().any(|e| matches!(
        e,
        ChatEvent::Error { message } if message == "the model returned an empty answer"
    )));
    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Coverage { .. })),
        0
    );
    assert_eq!(count(&events, |e| matches!(e, ChatEvent::Done)), 0);
}

#[test]
fn reasoning_only_answer_emits_reasoning_aware_error_and_stops() {
    let v = vault();
    let mock = MockLlmClient::new(vec![final_turn()], "")
        .with_reasoning(&["all the answer ", "went into reasoning"]);
    let events = run(v.path(), &mock, &Guards::default());

    assert_eq!(count(&events, |e| matches!(e, ChatEvent::Error { .. })), 1);
    assert!(events.iter().any(|e| matches!(
        e,
        ChatEvent::Error { message } if message.contains("reasoning")
    )));
    assert_eq!(count(&events, |e| matches!(e, ChatEvent::Done)), 0);
}

#[test]
fn citing_an_unknown_evidence_id_is_dropped() {
    let v = vault();
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"components"}"#),
            final_turn(),
        ],
        "As noted [e9].", // e9 was never handed out (only e1 exists)
    );
    let events = run(v.path(), &mock, &Guards::default());

    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Citation { .. })),
        0
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, ChatEvent::CitationDropped { reason }
        if reason.contains("unknown evidence id"))));
}

#[test]
fn a_citation_whose_note_changed_mid_answer_is_dropped() {
    let v = vault();
    let path = v.path().join("Research/widgets.md");
    // The external edit lands while the answer is streaming — the recorded hash
    // no longer matches, so the citation must be dropped, not surfaced.
    let hook_path = path.clone();
    let mock = MockLlmClient::new(
        vec![
            tool_call("c1", "search_notes", r#"{"query":"components"}"#),
            final_turn(),
        ],
        "Widgets are small components [e1].",
    )
    .with_hook(move || {
        fs::write(&hook_path, "# Widgets\n\nCompletely rewritten now.\n").unwrap();
    });
    let events = run(v.path(), &mock, &Guards::default());

    assert_eq!(
        count(&events, |e| matches!(e, ChatEvent::Citation { .. })),
        0
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, ChatEvent::CitationDropped { reason }
        if reason.contains("changed on disk"))));
}

#[test]
fn an_llm_transport_error_surfaces_and_stops() {
    let v = vault();
    let mock = MockLlmClient::failing();
    let events = run(v.path(), &mock, &Guards::default());

    assert!(events
        .iter()
        .any(|e| matches!(e, ChatEvent::Error { message } if message.contains("boom"))));
    // The error is terminal — no Done, no partial answer.
    assert_eq!(count(&events, |e| matches!(e, ChatEvent::Done)), 0);
}

#[test]
fn extract_cited_ids_finds_markers_and_dedupes() {
    assert_eq!(
        extract_cited_ids("see [e1] and [e2], again [e1]; not [x] nor [e] nor [e1x]"),
        vec!["e1".to_string(), "e2".to_string()]
    );
    assert!(extract_cited_ids("no citations here").is_empty());
}

#[test]
fn extract_cited_ids_drops_a_marker_severed_by_truncation() {
    // The moat guarantee under a `length` cut: when the answer is truncated mid
    // marker, the complete markers survive and the severed one — missing its closing
    // `]` — is never emitted as a citation. A wrong citation is worse than no answer.
    assert_eq!(
        extract_cited_ids("Sugar is sweet [e1] and salt [e2"),
        vec!["e1".to_string()]
    );
    // Cut at the bracket, at the prefix, and mid-digits — none of these parse.
    assert!(extract_cited_ids("cut at the bracket [").is_empty());
    assert!(extract_cited_ids("cut at the prefix [e").is_empty());
    assert!(extract_cited_ids("cut mid-digits [e12").is_empty());
}

fn assistant_msg(content: &str) -> LlmMessage {
    LlmMessage {
        role: crate::ai::llm::Role::Assistant,
        content: Some(content.to_string()),
        tool_calls: Vec::new(),
        tool_call_id: None,
        name: None,
    }
}

#[test]
fn strip_cited_markers_removes_markers_and_leading_space() {
    assert_eq!(
        strip_cited_markers("Spacing is 8px [e1] and grids use it [e2]."),
        "Spacing is 8px and grids use it."
    );
    // Case-insensitive `e`, multi-digit ids; non-markers are left untouched.
    assert_eq!(
        strip_cited_markers("A [E12] then [x] and [e] stay."),
        "A then [x] and [e] stay."
    );
    assert_eq!(strip_cited_markers("no markers here"), "no markers here");
}

#[test]
fn prepare_history_strips_stale_markers_from_carried_turns() {
    // SUS-1 backstop in the core: a `[eN]` carried into a later turn can't survive
    // to re-validate against an unrelated fresh span.
    let history = vec![
        LlmMessage::user("what is spacing?"),
        assistant_msg("Spacing is 8px [e1] and grids use it [e2]."),
    ];
    let out = prepare_history(&history);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].content.as_deref(), Some("what is spacing?"));
    assert_eq!(
        out[1].content.as_deref(),
        Some("Spacing is 8px and grids use it.")
    );
}

#[test]
fn prepare_history_windows_to_char_budget_keeping_most_recent() {
    // H1: bound history so system + history + evidence can't overflow a local
    // window. Each turn is ~5k chars, so only the newest that fit the 12k budget
    // survive; the oldest drop.
    let big = "x".repeat(5_000);
    let history: Vec<LlmMessage> = (0..6)
        .map(|i| assistant_msg(&format!("{i}{big}")))
        .collect();
    let out = prepare_history(&history);
    assert!(
        out.len() < history.len(),
        "oversized history must be windowed"
    );
    assert!(!out.is_empty());
    // The newest turn is always retained.
    assert_eq!(out.last().unwrap().content, history.last().unwrap().content);
}

#[test]
fn prepare_history_keeps_newest_turn_even_when_it_exceeds_budget() {
    // Never send empty history just because the last turn alone is huge.
    let huge = assistant_msg(&"y".repeat(MAX_HISTORY_CHARS + 5_000));
    let out = prepare_history(std::slice::from_ref(&huge));
    assert_eq!(out.len(), 1);
}

#[test]
fn folder_scoped_search_flows_through_the_loop() {
    let v = vault();
    // The model discovers folders, scopes a search to Research, then reads a span —
    // the folder path must flow through dispatch to a verified citation.
    let mock = MockLlmClient::new(
        vec![
            tool_call("c0", "list_folders", "{}"),
            tool_call(
                "c1",
                "search_notes",
                r#"{"query":"components","folder":"Research"}"#,
            ),
            tool_call(
                "c2",
                "read_note_span",
                r#"{"rel_path":"Research/widgets.md","start_line":1,"end_line":2}"#,
            ),
            final_turn(),
        ],
        "Widgets are small components [e1].",
    );
    let events = run(v.path(), &mock, &Guards::default());
    assert!(events
        .iter()
        .any(|e| matches!(e, ChatEvent::Searching { query, .. } if query == "components")));
    assert!(events.iter().any(|e| matches!(
        e,
        ChatEvent::Citation { rel_path, .. } if rel_path == "Research/widgets.md"
    )));
    assert!(matches!(events.last(), Some(ChatEvent::Done)));
}

// ── §4 token-aware context budgeting (PA-029) ───────────────────────────
// The char guards can't see that CJK/symbol-dense text tokenises ~4× denser
// than Latin, so the assembled prompt can overflow a small local window and be
// silently front-truncated — dropping the grounding, breaking cited recall.
// `fit_prompt_to_window` budgets the assembled prompt in *tokens* before send.

fn input_budget(window: usize) -> usize {
    window - ANSWER_RESERVE_TOKENS - PROMPT_OVERHEAD_TOKENS
}

fn local_input_budget() -> usize {
    input_budget(LOCAL_CONTEXT_WINDOW_TOKENS)
}

fn evidence_round(round: usize, body: String) -> [LlmMessage; 2] {
    [
        LlmMessage::assistant_tool_calls(vec![ToolCall {
            id: format!("c{round}"),
            name: "search_notes".into(),
            arguments: "{}".into(),
        }]),
        LlmMessage::tool_result(format!("c{round}"), "search_notes", body),
    ]
}

#[test]
fn estimate_tokens_counts_dense_scripts_far_heavier_than_latin() {
    // Latin ~4 chars/token; ASCII symbol runs ~1 token/char. Non-ASCII
    // scalars are weighted by their UTF-8 BYTE length: byte-level BPE
    // (Qwen/Llama via Ollama) falls back to one token per byte for scalars
    // with no merge rule, so 配 (3 bytes) is 3 tokens, not 1 — the upper
    // bound that keeps a dense-script prompt from slipping ~3× past the
    // window. (These were 100 and 100 under the flat 1-token/scalar weight.)
    assert_eq!(estimate_tokens(&"a".repeat(100)), 25);
    assert_eq!(estimate_tokens(&"配".repeat(100)), 300);
    assert_eq!(estimate_tokens(&"#".repeat(100)), 100);
}

#[test]
fn estimate_tokens_weights_rare_script_scalars_by_utf8_bytes() {
    // 𒀀 (U+12000, cuneiform) is a 4-byte scalar: byte-fallback BPE emits up
    // to one token PER BYTE for scalars with no merge rules (rare CJK
    // extensions, cuneiform, tag blocks, some emoji/ZWJ), so the estimate
    // must say 4 tokens/scalar — 1/scalar would under-budget ~4×.
    assert_eq!(estimate_tokens(&"\u{12000}".repeat(100)), 400);
    // Byte-weight boundary sanity: Latin-1 = 2 bytes, BMP CJK = 3 bytes.
    assert_eq!(estimate_tokens("é"), 2);
    assert_eq!(estimate_tokens("界"), 3);
}

#[test]
fn context_window_tokens_clamps_local_models_only() {
    assert_eq!(
        context_window_tokens(crate::ai::DEFAULT_LOCAL_MODEL),
        Some(LOCAL_CONTEXT_WINDOW_TOKENS)
    );
    assert_eq!(context_window_tokens("anthropic/claude-sonnet-4.5"), None);
}

#[test]
fn fit_prompt_to_window_is_inert_for_a_cloud_model_with_unknown_window() {
    // A cloud model whose window the client could not report is left untouched
    // (inert-with-reason, never guessed): the char guards remain its cost ceiling,
    // so budgeting never INCREASES what a cloud call would have sent.
    let messages = vec![
        LlmMessage::system("grounding"),
        LlmMessage::user("配".repeat(1_000_000)),
    ];
    let out = fit_prompt_to_window(&messages, "anthropic/claude-sonnet-4.5", None);
    assert!(!out.lost);
    assert_eq!(out.messages, messages);
}

#[test]
fn fit_prompt_to_window_budgets_a_cloud_model_against_its_reported_window() {
    // A small-window cloud model with dense CJK evidence: the catalogue-reported
    // window clamps exactly like the local one — oldest drops, grounding stays.
    let mut messages = vec![
        LlmMessage::system(SYSTEM_PROMPT),
        LlmMessage::user("question"),
    ];
    for round in 0..6 {
        messages.extend(evidence_round(
            round,
            format!("round{round} {}", "配".repeat(8_000)),
        ));
    }
    let out = fit_prompt_to_window(&messages, "vendor/small-cloud", Some(32_768));

    assert!(out.lost, "an over-window prompt must report coverage loss");
    assert_eq!(out.messages[0].content.as_deref(), Some(SYSTEM_PROMPT));
    let joined: String = out
        .messages
        .iter()
        .filter_map(|m| m.content.as_deref())
        .collect();
    assert!(
        joined.contains("round5"),
        "the newest evidence must survive"
    );
    assert!(!joined.contains("round0"), "the oldest evidence must drop");
    assert!(total_tokens(&out.messages) <= input_budget(32_768));
}

#[test]
fn fit_prompt_to_window_leaves_a_large_cloud_window_untouched() {
    // A large-window cloud model (the common case) is not trimmed — budgeting
    // must never make a cloud prompt smaller than the char guards already allow,
    // only ever smaller than the window requires.
    let mut messages = vec![
        LlmMessage::system(SYSTEM_PROMPT),
        LlmMessage::user("question"),
    ];
    messages.extend(evidence_round(0, "配".repeat(8_000)));

    let out = fit_prompt_to_window(&messages, "vendor/big-cloud", Some(1_000_000));

    assert!(!out.lost);
    assert_eq!(out.messages, messages);
}

#[test]
fn fit_prompt_to_window_prefers_the_reported_window_over_the_curated_default() {
    // The client-reported window is authoritative: it is the window the provider
    // will actually enforce (the local client reports the `num_ctx` it sends).
    // A host that sizes its local window smaller must see the tighter clamp.
    let mut messages = vec![
        LlmMessage::system(SYSTEM_PROMPT),
        LlmMessage::user("question"),
    ];
    messages.extend(evidence_round(0, "配".repeat(20_000)));

    let out = fit_prompt_to_window(&messages, crate::ai::DEFAULT_LOCAL_MODEL, Some(8_192));

    assert!(out.lost);
    assert!(total_tokens(&out.messages) <= input_budget(8_192));
}

#[test]
fn local_budget_window_is_the_shared_ollama_num_ctx() {
    // Anti-drift tripwire: the token budget and the `num_ctx` the shell sends to
    // Ollama are the SAME constant (crate::ai::local::OLLAMA_NUM_CTX), so the two
    // can never disagree about the window Ollama enforces.
    assert_eq!(
        LOCAL_CONTEXT_WINDOW_TOKENS,
        crate::ai::local::OLLAMA_NUM_CTX as usize
    );
}

#[test]
fn fit_prompt_to_window_drops_oldest_keeping_grounding_and_newest() {
    let mut messages = vec![
        LlmMessage::system(SYSTEM_PROMPT),
        LlmMessage::user("question"),
    ];
    for round in 0..6 {
        messages.extend(evidence_round(
            round,
            format!("round{round} {}", "配".repeat(8_000)),
        ));
    }
    let out = fit_prompt_to_window(&messages, crate::ai::DEFAULT_LOCAL_MODEL, None);

    assert!(out.lost, "an over-window prompt must report coverage loss");
    assert_eq!(out.messages[0].role, Role::System);
    assert_eq!(out.messages[0].content.as_deref(), Some(SYSTEM_PROMPT));
    assert!(out
        .messages
        .iter()
        .any(|m| m.content.as_deref() == Some("question")));
    let joined: String = out
        .messages
        .iter()
        .filter_map(|m| m.content.as_deref())
        .collect();
    assert!(
        joined.contains("round5"),
        "the newest evidence must survive"
    );
    assert!(!joined.contains("round0"), "the oldest evidence must drop");
    assert!(total_tokens(&out.messages) <= local_input_budget());
}

#[test]
fn fit_prompt_to_window_head_truncates_a_single_oversized_evidence() {
    // One span larger than the whole window: grounding is the hard invariant, so
    // the span is head-truncated with an explicit marker, never grounding.
    let mut messages = vec![
        LlmMessage::system(SYSTEM_PROMPT),
        LlmMessage::user("question"),
    ];
    messages.extend(evidence_round(0, "配".repeat(60_000)));

    let out = fit_prompt_to_window(&messages, crate::ai::DEFAULT_LOCAL_MODEL, None);

    assert!(out.lost);
    assert_eq!(out.messages[0].content.as_deref(), Some(SYSTEM_PROMPT));
    let evidence = out
        .messages
        .iter()
        .rev()
        .find(|m| m.role == Role::Tool)
        .unwrap();
    assert!(evidence
        .content
        .as_deref()
        .unwrap()
        .contains("trimmed to fit"));
    assert!(total_tokens(&out.messages) <= local_input_budget());
}

#[test]
fn fit_prompt_to_window_trims_symbol_dense_content() {
    // Symbol-dense ASCII tokenises ~1 token/char, so it overflows even though its
    // char count sits comfortably under the char guards.
    let mut messages = vec![
        LlmMessage::system(SYSTEM_PROMPT),
        LlmMessage::user("question"),
    ];
    messages.extend(evidence_round(0, "#".repeat(40_000)));

    let out = fit_prompt_to_window(&messages, crate::ai::DEFAULT_LOCAL_MODEL, None);

    assert!(out.lost);
    assert_eq!(out.messages[0].content.as_deref(), Some(SYSTEM_PROMPT));
    assert!(total_tokens(&out.messages) <= local_input_budget());
}

#[test]
fn fit_prompt_to_window_trims_rare_script_content_the_old_estimate_under_budgeted() {
    // 10_000 cuneiform scalars (4 bytes each): the old 1-token/scalar
    // estimate said ~10k tokens — comfortably under the local budget, so
    // the prompt was sent whole while byte-fallback BPE emits up to ~40k
    // tokens and Ollama silently front-truncates the grounding. The
    // byte-weighted estimate sees the real overflow, trims, and reports
    // the coverage loss instead.
    let mut messages = vec![
        LlmMessage::system(SYSTEM_PROMPT),
        LlmMessage::user("question"),
    ];
    messages.extend(evidence_round(0, "\u{12000}".repeat(10_000)));

    let out = fit_prompt_to_window(&messages, crate::ai::DEFAULT_LOCAL_MODEL, None);

    assert!(out.lost, "rare-script overflow must report coverage loss");
    assert_eq!(out.messages[0].content.as_deref(), Some(SYSTEM_PROMPT));
    assert!(total_tokens(&out.messages) <= local_input_budget());
}

#[test]
fn fit_prompt_to_window_preserves_tool_call_result_pairing() {
    let mut messages = vec![LlmMessage::system(SYSTEM_PROMPT), LlmMessage::user("q")];
    for round in 0..6 {
        messages.extend(evidence_round(round, "配".repeat(8_000)));
    }
    let out = fit_prompt_to_window(&messages, crate::ai::DEFAULT_LOCAL_MODEL, None).messages;

    for (i, message) in out.iter().enumerate() {
        if message.role == Role::Tool {
            let prev = &out[i - 1];
            let paired = prev.role == Role::Tool
                || (prev.role == Role::Assistant && !prev.tool_calls.is_empty());
            assert!(paired, "orphaned tool result at index {i}");
        }
    }
}

#[test]
fn local_run_reports_budget_loss_and_never_front_truncates_grounding() {
    let vault = tempfile::tempdir().unwrap();
    let provider = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 16_000_000_000,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 10_000_000_000,
        },
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::new(),
    };
    let services = SkillServices::new(
        &skills,
        &environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    );
    let llm = MockLlmClient::new(vec![final_turn()], "answer");
    let guards = Guards::default();
    let session = ChatSession {
        root: vault.path(),
        model: crate::ai::DEFAULT_LOCAL_MODEL,
        provider: &provider,
        llm: &llm,
        skill_services: &services,
        guards: &guards,
    };
    let mut messages = vec![
        LlmMessage::system(SYSTEM_PROMPT),
        LlmMessage::user("question"),
    ];
    messages.extend(evidence_round(0, "配".repeat(50_000)));
    let mut active_skills = ActiveSkills::new(guards.max_iterations);
    let mut writes = WriteSession::new(1).unwrap();
    let mut youtube_session = YoutubeToolSession::new_with_update_session(
        services.capture_cancellation.clone(),
        services.extractor_updates.clone(),
    );
    let mut registry = EvidenceRegistry::new();
    let mut coverage = CoverageAcc::default();
    let mut sink = VecSink::default();

    block_on(session.collect_evidence(
        &mut messages,
        &mut active_skills,
        &mut writes,
        &mut youtube_session,
        &mut RunPlan::default(),
        &mut registry,
        &mut coverage,
        &mut open_gate(),
        &mut sink,
    ))
    .unwrap();

    assert!(
        coverage.truncated,
        "budget loss must be recorded so the Coverage footer surfaces it"
    );
    let sent = &llm.completion_requests()[0];
    assert_eq!(
        sent[0].role,
        Role::System,
        "grounding must stay first, never front-truncated"
    );
    assert_eq!(sent[0].content.as_deref(), Some(SYSTEM_PROMPT));
    assert!(total_tokens(sent) <= local_input_budget());
}

/// Drive one `collect_evidence` turn against `model` with `llm`, over a prompt
/// holding one dense 50k-char evidence round, and return what the client was
/// sent plus the accumulated coverage. Shared by the cloud-window pair below.
fn run_budgeted_turn(model: &str, llm: &MockLlmClient) -> (Vec<Vec<LlmMessage>>, CoverageAcc) {
    let vault = tempfile::tempdir().unwrap();
    let provider = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 16_000_000_000,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 10_000_000_000,
        },
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::new(),
    };
    let services = SkillServices::new(
        &skills,
        &environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    );
    let guards = Guards::default();
    let session = ChatSession {
        root: vault.path(),
        model,
        provider: &provider,
        llm,
        skill_services: &services,
        guards: &guards,
    };
    let mut messages = vec![
        LlmMessage::system(SYSTEM_PROMPT),
        LlmMessage::user("question"),
    ];
    messages.extend(evidence_round(0, "配".repeat(50_000)));
    let mut active_skills = ActiveSkills::new(guards.max_iterations);
    let mut writes = WriteSession::new(1).unwrap();
    let mut youtube_session = YoutubeToolSession::new_with_update_session(
        services.capture_cancellation.clone(),
        services.extractor_updates.clone(),
    );
    let mut registry = EvidenceRegistry::new();
    let mut coverage = CoverageAcc::default();
    let mut sink = VecSink::default();

    block_on(session.collect_evidence(
        &mut messages,
        &mut active_skills,
        &mut writes,
        &mut youtube_session,
        &mut RunPlan::default(),
        &mut registry,
        &mut coverage,
        &mut open_gate(),
        &mut sink,
    ))
    .unwrap();

    (llm.completion_requests(), coverage)
}

#[test]
fn cloud_run_with_known_window_reports_budget_loss_and_keeps_grounding() {
    // The issue-#22 gap PA-029 left open: a small-window CLOUD model faced with a
    // dense-CJK prompt. With the catalogue-reported window wired through the
    // client, the same deterministic trim + explicit coverage loss applies.
    let llm = MockLlmClient::new(vec![final_turn()], "answer").with_context_window(32_768);
    let (requests, coverage) = run_budgeted_turn("vendor/small-cloud", &llm);

    assert!(
        coverage.truncated,
        "budget loss must be recorded so the Coverage footer surfaces it"
    );
    let sent = &requests[0];
    assert_eq!(
        sent[0].role,
        Role::System,
        "grounding must stay first, never front-truncated"
    );
    assert_eq!(sent[0].content.as_deref(), Some(SYSTEM_PROMPT));
    assert!(total_tokens(sent) <= input_budget(32_768));
}

#[test]
fn cloud_run_with_unknown_window_stays_inert_under_the_char_guards() {
    // No catalogue entry (a hand-typed id, or the cache was never warmed): the
    // client reports no window, so budgeting leaves the prompt untouched rather
    // than guessing — the char guards remain the cloud cost ceiling.
    let llm = MockLlmClient::new(vec![final_turn()], "answer");
    let (requests, coverage) = run_budgeted_turn("vendor/uncatalogued-cloud", &llm);

    assert!(!coverage.truncated);
    let sent = &requests[0];
    assert!(
        sent.iter()
            .filter_map(|m| m.content.as_deref())
            .any(|c| c.chars().count() == 50_000),
        "an unbudgeted cloud prompt must be sent whole"
    );
}

// ── §4 bounded retry for idempotent tool-decision turns (PA-029) ────────
// A single transient 429/5xx/dropped connection during an idempotent tool-DECIDING
// `complete` turn must not abort the whole run. Exactly one bounded retry; never a
// non-transient failure, a user-stopped turn, or the streamed answer turn. The retry
// sits before tool dispatch, so it can never double-execute a tool.

struct RetryEnv {
    _vault: tempfile::TempDir,
    provider: KeywordRetriever,
    skills: SkillRegistry,
    environment: SkillEnvironment,
    guards: Guards,
}

fn retry_env() -> RetryEnv {
    let vault = tempfile::tempdir().unwrap();
    let provider = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let environment = SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 16_000_000_000,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 10_000_000_000,
        },
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::new(),
    };
    RetryEnv {
        _vault: vault,
        provider,
        skills,
        environment,
        guards: Guards::default(),
    }
}

fn tool_decision_request() -> LlmRequest {
    LlmRequest {
        model: "test-model".into(),
        messages: vec![LlmMessage::system("system"), LlmMessage::user("q")],
        tools: Vec::new(),
    }
}

/// A [`RetryDelay`] double that records every pause it was asked to await instead of
/// sleeping — so a test can prove the backoff seam is exercised without real time
/// passing (the recorded durations also confirm the core hands over the right value).
#[derive(Default)]
struct RecordingDelay {
    awaited: Mutex<Vec<Duration>>,
}

#[async_trait]
impl RetryDelay for RecordingDelay {
    async fn delay(&self, duration: Duration) {
        self.awaited.lock().unwrap().push(duration);
    }
}

impl RecordingDelay {
    fn awaited(&self) -> Vec<Duration> {
        self.awaited.lock().unwrap().clone()
    }
}

#[test]
fn tool_turn_awaits_injected_backoff_once_before_a_transient_retry() {
    let env = retry_env();
    let delay = RecordingDelay::default();
    let services = SkillServices::new(
        &env.skills,
        &env.environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    )
    .with_retry_delay(&delay);
    let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
        CoreError::Llm("openrouter returned 429 Too Many Requests".into()),
    ]);
    let session = ChatSession {
        root: env._vault.path(),
        model: "test-model",
        provider: &env.provider,
        llm: &llm,
        skill_services: &services,
        guards: &env.guards,
    };

    block_on(session.complete_tool_turn(&tool_decision_request(), &mut VecSink::default()))
        .unwrap();

    assert_eq!(llm.completion_requests().len(), 2, "retried exactly once");
    assert_eq!(
        delay.awaited(),
        vec![RETRY_BACKOFF],
        "the retry awaits the injected backoff exactly once, at the policy value"
    );
}

#[test]
fn tool_turn_does_not_await_backoff_for_a_non_transient_failure() {
    let env = retry_env();
    let delay = RecordingDelay::default();
    let services = SkillServices::new(
        &env.skills,
        &env.environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    )
    .with_retry_delay(&delay);
    let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
        CoreError::Llm("openrouter returned 400 Bad Request: bad model".into()),
    ]);
    let session = ChatSession {
        root: env._vault.path(),
        model: "test-model",
        provider: &env.provider,
        llm: &llm,
        skill_services: &services,
        guards: &env.guards,
    };

    let result =
        block_on(session.complete_tool_turn(&tool_decision_request(), &mut VecSink::default()));

    assert!(result.is_err(), "a 400 is permanent — no retry");
    assert_eq!(llm.completion_requests().len(), 1);
    assert!(
        delay.awaited().is_empty(),
        "a non-retryable failure never pauses for backoff"
    );
}

#[test]
fn tool_turn_retries_a_single_transient_failure_then_succeeds() {
    let env = retry_env();
    let services = SkillServices::new(
        &env.skills,
        &env.environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    );
    let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
        CoreError::Llm("openrouter returned 429 Too Many Requests".into()),
    ]);
    let session = ChatSession {
        root: env._vault.path(),
        model: "test-model",
        provider: &env.provider,
        llm: &llm,
        skill_services: &services,
        guards: &env.guards,
    };

    let completion =
        block_on(session.complete_tool_turn(&tool_decision_request(), &mut VecSink::default()))
            .unwrap();

    assert!(completion.content.is_some());
    assert_eq!(
        llm.completion_requests().len(),
        2,
        "one transient failure is retried exactly once"
    );
}

#[test]
fn tool_turn_retries_a_dropped_connection() {
    let env = retry_env();
    let services = SkillServices::new(
        &env.skills,
        &env.environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    );
    let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
        CoreError::Llm(
            "request to openrouter failed: error sending request: connection reset by peer".into(),
        ),
    ]);
    let session = ChatSession {
        root: env._vault.path(),
        model: "test-model",
        provider: &env.provider,
        llm: &llm,
        skill_services: &services,
        guards: &env.guards,
    };

    block_on(session.complete_tool_turn(&tool_decision_request(), &mut VecSink::default()))
        .unwrap();

    assert_eq!(llm.completion_requests().len(), 2);
}

#[test]
fn tool_turn_does_not_retry_a_non_transient_failure() {
    let env = retry_env();
    let services = SkillServices::new(
        &env.skills,
        &env.environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    );
    let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
        CoreError::Llm("openrouter returned 400 Bad Request: bad model".into()),
    ]);
    let session = ChatSession {
        root: env._vault.path(),
        model: "test-model",
        provider: &env.provider,
        llm: &llm,
        skill_services: &services,
        guards: &env.guards,
    };

    let result =
        block_on(session.complete_tool_turn(&tool_decision_request(), &mut VecSink::default()));

    assert!(result.is_err(), "a 400 is permanent — no retry");
    assert_eq!(llm.completion_requests().len(), 1);
}

#[test]
fn tool_turn_does_not_retry_when_the_run_is_cancelled() {
    let env = retry_env();
    let cancellation = CaptureCancellation::default();
    cancellation.cancel();
    let services = SkillServices::new(
        &env.skills,
        &env.environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    )
    .with_capture_cancellation(cancellation);
    let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
        CoreError::Llm("openrouter returned 503 Service Unavailable".into()),
    ]);
    let session = ChatSession {
        root: env._vault.path(),
        model: "test-model",
        provider: &env.provider,
        llm: &llm,
        skill_services: &services,
        guards: &env.guards,
    };

    let result =
        block_on(session.complete_tool_turn(&tool_decision_request(), &mut VecSink::default()));

    assert!(result.is_err(), "a cancelled run must not retry");
    assert_eq!(
        llm.completion_requests().len(),
        1,
        "cancellation short-circuits the retry"
    );
}

/// A client whose streamed tool turn fails transiently, optionally after
/// putting a live preview on screen. The failure is retryable and the run is
/// not cancelled, so the emission guard is the only thing that can stop a
/// retry — which makes these two tests a direct measurement of it.
struct StreamingToolLlm {
    previews_before_failing: bool,
    attempts: std::sync::atomic::AtomicUsize,
}

impl StreamingToolLlm {
    fn new(previews_before_failing: bool) -> Self {
        Self {
            previews_before_failing,
            attempts: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn attempts(&self) -> usize {
        self.attempts.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait]
impl LlmClient for StreamingToolLlm {
    async fn complete(&self, _req: &LlmRequest) -> CoreResult<Completion> {
        panic!("a client that streams tool turns must not fall back to the buffered one")
    }

    async fn complete_tool_streaming(
        &self,
        _req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<Completion> {
        self.attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.previews_before_failing {
            sink.send(ChatEvent::NoteEditPreview {
                id: "call-1".into(),
                rel_path: None,
                kind: None,
                body: "half a note".into(),
                complete: false,
            });
        }
        Err(CoreError::Llm(
            "openrouter returned 429 Too Many Requests".into(),
        ))
    }

    async fn complete_streaming(
        &self,
        _req: &LlmRequest,
        _sink: &mut dyn EventSink,
    ) -> CoreResult<String> {
        unreachable!("the tool turn fails before any answer is streamed")
    }
}

fn run_streamed_tool_turn(llm: &StreamingToolLlm) -> (CoreResult<Completion>, VecSink) {
    let env = retry_env();
    let services = SkillServices::new(
        &env.skills,
        &env.environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    );
    let session = ChatSession {
        root: env._vault.path(),
        model: "test-model",
        provider: &env.provider,
        llm,
        skill_services: &services,
        guards: &env.guards,
    };
    let mut sink = VecSink::default();
    let result = block_on(session.complete_tool_turn(&tool_decision_request(), &mut sink));
    (result, sink)
}

#[test]
fn a_streamed_tool_turn_is_never_retried_once_it_has_emitted() {
    // The retry was only ever safe because the turn published nothing. Now
    // that it streams live previews, replaying it would stream a second copy
    // of a half-composed note over the first — the user would watch their
    // note rewind. So a transient, retryable failure is NOT retried here.
    let llm = StreamingToolLlm::new(true);

    let (result, sink) = run_streamed_tool_turn(&llm);

    assert!(result.is_err(), "the failure is surfaced, not swallowed");
    assert_eq!(llm.attempts(), 1, "emitted, so no replay");
    assert_eq!(
        sink.events
            .iter()
            .filter(|event| matches!(event, ChatEvent::NoteEditPreview { .. }))
            .count(),
        1,
        "exactly one preview reached the user"
    );
}

#[test]
fn a_streamed_tool_turn_that_failed_before_emitting_is_still_retried_once() {
    // The guard keys on what the user can already see, not on whether the turn
    // was streamed. A pre-first-event failure is as invisible as the buffered
    // turn's was, so the one bounded retry survives.
    let llm = StreamingToolLlm::new(false);

    let (result, sink) = run_streamed_tool_turn(&llm);

    assert!(result.is_err(), "both attempts failed");
    assert_eq!(llm.attempts(), 2, "retried exactly once");
    // The round beacon (`PlanningRound`) is emitted by `collect_evidence` BEFORE
    // this call, so it is outside the retry guard by construction rather than by
    // statement order — the turn itself publishes nothing at all. That pairing is
    // what keeps the retry alive: put any emission back inside the loop and
    // `sink.emitted` latches, the retry above silently stops happening, and the
    // `attempts == 2` assertion goes red.
    assert!(
        sink.events.is_empty(),
        "the turn published nothing across BOTH attempts, got {:?}",
        sink.events
    );
}

#[test]
fn streamed_answer_turn_is_never_retried() {
    // The first `complete` returns no tool calls, so the loop proceeds straight to
    // the streamed answer, which fails transiently. Streaming is outside the retry
    // path, so it is attempted exactly once and surfaces a terminal error.
    let vault = vault();
    let mock = MockLlmClient::new(vec![final_turn()], "answer").with_streaming_failure(
        CoreError::Llm("openrouter returned 503 Service Unavailable".into()),
    );

    let events = run(vault.path(), &mock, &Guards::default());

    assert_eq!(
        mock.streaming_attempts(),
        1,
        "the streamed answer turn must not be retried"
    );
    assert!(events
        .iter()
        .any(|event| matches!(event, ChatEvent::Error { .. })));
    assert_eq!(count(&events, |event| matches!(event, ChatEvent::Done)), 0);
}

// ── §5 the run says it is working across a model round-trip (#126) ──────
// An answered `ask_user` was followed by NOTHING for a whole provider
// round-trip — and by two of them on a provider that does not stream tool
// turns, which re-runs the turn buffered. The pane went on showing the last
// phase word it was handed, so the user watched "searching" for the fifteen
// seconds the model spent composing. Not a correctness bug; a stale phase
// word is still a dishonest one.

/// The fixture skill's question, answered by whoever the run was given.
const ASK_USER_ARGS: &str = r#"{"question":"Continue?","options":[{"id":"continue","label":"Continue","description":null,"imageDataUri":null}],"multi_select":false}"#;

/// Picks the first option, like a user who clicked one.
struct AnsweringPrompt;

#[async_trait]
impl UserPrompt for AnsweringPrompt {
    async fn ask(&self, elicitation: Elicitation) -> CoreResult<Option<Vec<String>>> {
        Ok(Some(vec![elicitation.options[0].id.clone()]))
    }
}

/// A whole run with the fixture skill preloaded (so `ask_user` is granted)
/// and every question answered — the shape the fifteen seconds was measured
/// on.
fn run_answered_question(llm: &dyn LlmClient) -> Vec<ChatEvent> {
    let env = retry_env();
    let services = SkillServices::new(
        &env.skills,
        &env.environment,
        &AnsweringPrompt,
        &UnavailableNoteWriter,
        1,
    )
    .with_approval(
        unattended_policy(),
        &TEST_APPROVAL_PROMPT,
        &TEST_APPROVAL_CLASSIFIER,
    );
    let mut sink = VecSink::default();
    block_on(run_chat(
        "ask me what to do",
        &[],
        vec![FIXTURE_SKILL_ID.into()],
        env._vault.path(),
        "test-model",
        &env.provider,
        llm,
        &services,
        &mut sink,
        &env.guards,
    ))
    .unwrap();
    sink.events
}

#[test]
fn an_answered_question_is_followed_by_a_beacon_rather_than_silence() {
    let llm = MockLlmClient::new(
        vec![tool_call("prompt", "ask_user", ASK_USER_ARGS), final_turn()],
        "done",
    );

    let events = run_answered_question(&llm);

    let settled = events
        .iter()
        .position(|event| {
            matches!(event, ChatEvent::ToolResult { id, status, .. }
                if id == "prompt" && *status == ToolStatus::Ok)
        })
        .expect("the answered question settles");
    assert!(
        matches!(
            events.get(settled + 1),
            Some(ChatEvent::PlanningRound { round: 2, .. })
        ),
        "a full provider round-trip starts here, and nothing else can be \
         emitted during it — so without a beacon the pane keeps showing \
         whichever phase word it last had. It names its round, so the second \
         one cannot read as the run starting over. Got: {:?}",
        &events[settled..],
    );
    assert!(
        matches!(events.last(), Some(ChatEvent::Done)),
        "the run still finishes, so the assertion above is about a real run"
    );
}

/// A provider that does not stream tool turns: the streamed attempt carries
/// nothing, the real [`ToolTurnReader`] settles that as `NotStreamed`, and
/// the turn is re-run buffered — the shell's fallback, in
/// `app/desktop/src-tauri/src/ai.rs`. Two round-trips, and neither publishes
/// anything of its own.
struct UnstreamableToolLlm {
    completions: Mutex<VecDeque<Completion>>,
    round_trips: std::sync::atomic::AtomicUsize,
}

impl UnstreamableToolLlm {
    fn new(completions: Vec<Completion>) -> Self {
        Self {
            completions: Mutex::new(completions.into()),
            round_trips: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn round_trips(&self) -> usize {
        self.round_trips.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait]
impl LlmClient for UnstreamableToolLlm {
    async fn complete(&self, _req: &LlmRequest) -> CoreResult<Completion> {
        self.round_trips
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self
            .completions
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(final_turn))
    }

    async fn complete_tool_streaming(
        &self,
        req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<Completion> {
        self.round_trips
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // Read the empty turn through the real reader, so the `NotStreamed`
        // verdict is that module's own rather than one this double invented.
        let mut reader = ToolTurnReader::new();
        assert!(
            reader.push_bytes(b"data: [DONE]\n", sink)?,
            "the terminator stops the read"
        );
        match reader.finish(sink)? {
            StreamedToolTurn::Completed(_) => {
                panic!("a turn that carried nothing must ask for the buffered fallback")
            }
            StreamedToolTurn::NotStreamed => self.complete(req).await,
        }
    }

    async fn complete_streaming(
        &self,
        _req: &LlmRequest,
        _sink: &mut dyn EventSink,
    ) -> CoreResult<String> {
        unreachable!("this test settles the tool turn and never reaches the answer")
    }
}

#[test]
fn a_turn_the_provider_reruns_buffered_publishes_nothing_between_its_round_trips() {
    let env = retry_env();
    let services = SkillServices::new(
        &env.skills,
        &env.environment,
        &NoUserPrompt,
        &UnavailableNoteWriter,
        1,
    );
    let llm = UnstreamableToolLlm::new(vec![final_turn()]);
    let session = ChatSession {
        root: env._vault.path(),
        model: "test-model",
        provider: &env.provider,
        llm: &llm,
        skill_services: &services,
        guards: &env.guards,
    };
    let mut sink = VecSink::default();

    block_on(session.complete_tool_turn(&tool_decision_request(), &mut sink)).unwrap();

    assert_eq!(
        llm.round_trips(),
        2,
        "the worse case the issue names: this turn really did run twice"
    );
    assert!(
        sink.events.is_empty(),
        "the caller's single `PlanningRound` covers both round-trips precisely \
         because the pair publishes nothing of its own, got {:?}",
        sink.events
    );
}
