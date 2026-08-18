mod support;

use async_trait::async_trait;
use futures::executor::block_on;
use neuralnote_core::ai::tools::{
    self, ToolContext, ToolOutcome, TOOL_FETCH_CAPTIONS, TOOL_FETCH_VIDEO_INFO,
    TOOL_TRANSCRIBE_AUDIO,
};
use neuralnote_core::ai::{
    ActiveSkills, CaptionPayload, CaptionRequest, CaptureCancellation, ChatEvent, Elicitation,
    EventSink, EvidenceRegistry, HardwareSpec, KeywordRetriever, MetadataPayload, NoUserPrompt,
    PlaylistPayload, PotMode, SkillEnvironment, SkillRegistry, ThumbnailPayload, UserPrompt,
    VideoId, WriteSession, YoutubeAnnotation, YoutubeIo, YoutubeRequirementInstaller,
    YoutubeToolSession, YoutubeUrl,
};
use neuralnote_core::capture::{CaptureError, ModelPricing, PricingInput};
use std::collections::{BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use support::FsBackend;

struct InstallPrompt;

#[async_trait]
impl UserPrompt for InstallPrompt {
    async fn ask(
        &self,
        elicitation: Elicitation,
    ) -> neuralnote_core::CoreResult<Option<Vec<String>>> {
        assert!(elicitation.question.contains("compil"));
        Ok(Some(vec!["install".into()]))
    }
}

struct PanicPrompt;

#[async_trait]
impl UserPrompt for PanicPrompt {
    async fn ask(
        &self,
        _elicitation: Elicitation,
    ) -> neuralnote_core::CoreResult<Option<Vec<String>>> {
        panic!("unproven caption absence must not prompt for Whisper")
    }
}

#[derive(Default)]
struct RecordingInstaller(AtomicUsize);

#[async_trait]
impl YoutubeRequirementInstaller for RecordingInstaller {
    async fn install_whisper_bundle(
        &self,
        sink: &mut dyn EventSink,
        _cancellation: &CaptureCancellation,
    ) -> Result<(), CaptureError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        sink.send(ChatEvent::SkillStep {
            message: "Compiling locally".into(),
        });
        Ok(())
    }
}

#[derive(Default)]
struct NoopSink;

impl EventSink for NoopSink {
    fn send(&mut self, _event: ChatEvent) {}
}

const URL: &str = "https://www.youtube.com/watch?v=iG9CE55wbtY";
const VTT: &[u8] = b"WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nHello &amp; welcome\n";

fn metadata(subtitles: &str, automatic: &str) -> Vec<u8> {
    format!(
        r#"{{
            "id":"iG9CE55wbtY",
            "title":"Do schools kill creativity?",
            "uploader":"TED",
            "duration":123,
            "subtitles":{subtitles},
            "automatic_captions":{automatic},
            "future_secret":{{"path":"/tmp/extractor-secret"}}
        }}"#
    )
    .into_bytes()
}

struct ScriptedYoutubeIo {
    metadata: Mutex<VecDeque<Result<MetadataPayload, CaptureError>>>,
    captions: Mutex<VecDeque<Result<CaptionPayload, CaptureError>>>,
    caption_pot_modes: Mutex<Vec<PotMode>>,
    transcriptions: Mutex<VecDeque<Result<CaptionPayload, CaptureError>>>,
    /// Answered on every call rather than popped, because the preview asks for a
    /// thumbnail once per lookup and a script that ran dry would fail the test
    /// for the wrong reason.
    thumbnail: Mutex<Result<ThumbnailPayload, CaptureError>>,
    updates: AtomicUsize,
    update_failure: Mutex<Option<CaptureError>>,
    transcribe_calls: AtomicUsize,
    thumbnail_calls: AtomicUsize,
    cancel_during_transcription: std::sync::atomic::AtomicBool,
    cancel_during_update: Mutex<Option<CaptureCancellation>>,
}

impl ScriptedYoutubeIo {
    fn new(metadata_json: Vec<u8>) -> Self {
        Self::with_metadata_result(Ok(MetadataPayload {
            json: metadata_json,
            annotations: Vec::new(),
        }))
    }

    fn with_metadata_result(result: Result<MetadataPayload, CaptureError>) -> Self {
        Self {
            metadata: Mutex::new(VecDeque::from([result])),
            captions: Mutex::new(VecDeque::new()),
            caption_pot_modes: Mutex::new(Vec::new()),
            transcriptions: Mutex::new(VecDeque::new()),
            thumbnail: Mutex::new(Err(CaptureError::ThumbnailRejected("unused".into()))),
            updates: AtomicUsize::new(0),
            update_failure: Mutex::new(None),
            transcribe_calls: AtomicUsize::new(0),
            thumbnail_calls: AtomicUsize::new(0),
            cancel_during_transcription: std::sync::atomic::AtomicBool::new(false),
            cancel_during_update: Mutex::new(None),
        }
    }

    fn set_thumbnail(&self, value: Result<ThumbnailPayload, CaptureError>) {
        *self.thumbnail.lock().unwrap() = value;
    }

    fn fail_updates(&self, error: CaptureError) {
        *self.update_failure.lock().unwrap() = Some(error);
    }

    fn push_caption(&self, value: Result<CaptionPayload, CaptureError>) {
        self.captions.lock().unwrap().push_back(value);
    }

    fn push_transcription(&self, value: Result<CaptionPayload, CaptureError>) {
        self.transcriptions.lock().unwrap().push_back(value);
    }

    fn cancel_during_transcription(&self) {
        self.cancel_during_transcription
            .store(true, Ordering::SeqCst);
    }

    fn cancel_during_update(&self, cancellation: CaptureCancellation) {
        *self.cancel_during_update.lock().unwrap() = Some(cancellation);
    }
}

#[async_trait]
impl YoutubeIo for ScriptedYoutubeIo {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        self.metadata
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted metadata response")
    }

    async fn fetch_caption_vtt(
        &self,
        request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        self.caption_pot_modes.lock().unwrap().push(request.pot);
        self.captions
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted caption response")
    }

    async fn enumerate_playlist(&self, _url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        Err(CaptureError::PlaylistInvalid("unused".into()))
    }

    async fn fetch_thumbnail(&self, _video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        self.thumbnail_calls.fetch_add(1, Ordering::SeqCst);
        match &*self.thumbnail.lock().unwrap() {
            Ok(payload) => Ok(payload.clone()),
            Err(error) => Err(error.clone()),
        }
    }

    async fn transcribe_audio(
        &self,
        _url: &YoutubeUrl,
        _model: &str,
        cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        self.transcribe_calls.fetch_add(1, Ordering::SeqCst);
        if self
            .cancel_during_transcription
            .swap(false, Ordering::SeqCst)
        {
            cancellation.cancel();
        }
        self.transcriptions
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted transcription response")
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        self.updates.fetch_add(1, Ordering::SeqCst);
        if let Some(cancellation) = self.cancel_during_update.lock().unwrap().take() {
            cancellation.cancel();
        }
        match self.update_failure.lock().unwrap().clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn environment(whisper_installed: bool) -> SkillEnvironment {
    let bin = PathBuf::from("/app-data/bin");
    let assets = PathBuf::from("/app-data/assets");
    let mut files = BTreeSet::new();
    if whisper_installed {
        files.insert(bin.join("whisper-cli"));
        files.insert(assets.join("ggml-small.en.bin"));
    }
    SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 16_000_000_000,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 2_000_000_000,
        },
        app_data_bin_dir: bin,
        available_binaries: files,
    }
}

fn call(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    environment: &SkillEnvironment,
    name: &str,
    arguments: &str,
) -> tools::ToolResult {
    call_with_pricing(
        io,
        session,
        environment,
        name,
        arguments,
        &PricingInput::Local,
    )
}

fn call_with_pricing(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    environment: &SkillEnvironment,
    name: &str,
    arguments: &str,
    pricing: &PricingInput,
) -> tools::ToolResult {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let mut active = ActiveSkills::new(8);
    let mut writes = WriteSession::new(1).unwrap();
    let mut sink = NoopSink;
    let allowed = BTreeSet::from([name.to_string()]);
    let mut evidence = EvidenceRegistry::new();
    let mut context = ToolContext::new(
        vault.path(),
        &skills,
        environment,
        &mut active,
        &FsBackend,
        &mut writes,
        &mut sink,
        &allowed,
    )
    .with_youtube(io, session)
    .with_pricing(pricing);

    block_on(tools::dispatch(
        &support::approve_unattended(vault.path(), &tool_call("youtube-call", name, arguments)),
        &retriever,
        &mut evidence,
        &NoUserPrompt,
        &mut context,
    ))
}

fn tool_call(id: &str, name: &str, arguments: &str) -> neuralnote_core::ai::ToolCall {
    neuralnote_core::ai::ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: arguments.into(),
    }
}

/// Like [`call`], but keeps the events instead of dropping them — for the
/// assertions that are about what reached the user, not what reached the model.
fn call_collecting_events(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    environment: &SkillEnvironment,
    name: &str,
    arguments: &str,
) -> (tools::ToolResult, Vec<ChatEvent>) {
    #[derive(Default)]
    struct CollectingSink(Vec<ChatEvent>);
    impl EventSink for CollectingSink {
        fn send(&mut self, event: ChatEvent) {
            self.0.push(event);
        }
    }

    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let mut active = ActiveSkills::new(8);
    let mut writes = WriteSession::new(1).unwrap();
    let mut sink = CollectingSink::default();
    let allowed = BTreeSet::from([name.to_string()]);
    let mut evidence = EvidenceRegistry::new();
    let pricing = PricingInput::Local;
    let result = {
        let mut context = ToolContext::new(
            vault.path(),
            &skills,
            environment,
            &mut active,
            &FsBackend,
            &mut writes,
            &mut sink,
            &allowed,
        )
        .with_youtube(io, session)
        .with_pricing(&pricing);

        block_on(tools::dispatch(
            &support::approve_unattended(vault.path(), &tool_call("youtube-call", name, arguments)),
            &retriever,
            &mut evidence,
            &NoUserPrompt,
            &mut context,
        ))
    };
    (result, sink.0)
}

fn transcript_sources(events: &[ChatEvent]) -> Vec<(String, Option<String>)> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::TranscriptSource { label, rel_path } => {
                Some((label.clone(), rel_path.clone()))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn fetched_captions_report_their_provenance_on_the_wire() {
    // Provenance used to reach the UI only by regexing `captions:` out of the
    // model's prose. The tool that obtained the transcript now reports it.
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(
        transcript_sources(&events),
        [(value["provenance"].as_str().unwrap().to_string(), None)],
        "the label on the wire must be the one the tool reported to the model"
    );
    assert_eq!(transcript_sources(&events)[0].0, "captions:en");
}

#[test]
fn a_whisper_transcription_reports_its_provenance_on_the_wire() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();
    prove_caption_absence(&io, &mut session);
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));

    let (result, events) = call_collecting_events(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(
        transcript_sources(&events),
        [("whisper:small.en".to_string(), None)]
    );
}

#[test]
fn a_failed_caption_fetch_reports_no_transcript_source() {
    // No transcript was obtained, so naming a source would be a claim about
    // where text that does not exist came from.
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    support::assert_tool_failed(&result.outcome);
    assert_eq!(transcript_sources(&events), []);
}

fn prove_caption_absence(io: &dyn YoutubeIo, session: &mut YoutubeToolSession) {
    let result = call(
        io,
        session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    // Caption absence is the awkward case in the #116 split: the fetch ran and
    // yielded nothing, which is neither "NeuralNote refused" nor a breakage. Of
    // the two available stories it is a failure — NeuralNote declined nothing —
    // and `next_action: offer_whisper` is what keeps it recoverable.
    support::assert_tool_failed(&result.outcome);
    assert_eq!(value["error"]["kind"], "captions_absent");
    assert_eq!(value["error"]["next_action"], "offer_whisper");
}

fn call_with_installer(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    installer: &dyn YoutubeRequirementInstaller,
    prompt: &dyn UserPrompt,
) -> tools::ToolResult {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let mut active = ActiveSkills::new(8);
    let mut writes = WriteSession::new(1).unwrap();
    let mut sink = NoopSink;
    let allowed = BTreeSet::from([TOOL_TRANSCRIBE_AUDIO.to_string()]);
    let mut evidence = EvidenceRegistry::new();
    let environment = environment(false);
    let pricing = PricingInput::Local;
    let mut context = ToolContext::new(
        vault.path(),
        &skills,
        &environment,
        &mut active,
        &FsBackend,
        &mut writes,
        &mut sink,
        &allowed,
    )
    .with_youtube(io, session)
    .with_youtube_requirements(installer)
    .with_pricing(&pricing);
    block_on(tools::dispatch(
        &support::approve_unattended(
            vault.path(),
            &tool_call(
                "install-call",
                TOOL_TRANSCRIBE_AUDIO,
                &format!(r#"{{"url":"{URL}"}}"#),
            ),
        ),
        &retriever,
        &mut evidence,
        prompt,
        &mut context,
    ))
}

#[test]
fn fetch_video_info_returns_only_validated_projection() {
    let io = ScriptedYoutubeIo::new(metadata(
        r#"{"en":[{"ext":"vtt","url":"https://captions.example/private"}]}"#,
        "{}",
    ));
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["video_id"], "iG9CE55wbtY");
    assert_eq!(value["title"], "Do schools kill creativity?");
    assert_eq!(
        value["caption_inventory"]["human"],
        serde_json::json!(["en"])
    );
    assert!(!result.content.contains("captions.example"));
    assert!(!result.content.contains("future_secret"));
    assert!(!result.content.contains("/tmp/"));
}

#[test]
fn fetch_video_info_surfaces_metadata_annotations() {
    let io = ScriptedYoutubeIo::with_metadata_result(Ok(MetadataPayload {
        json: metadata("{}", "{}"),
        annotations: vec![YoutubeAnnotation::SubtitleListingWithheld],
    }));
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["annotations"].as_array().unwrap().len(), 1);
    assert_eq!(value["caption_inventory"]["genuinely_absent"], false);
    assert!(value["annotations"][0]
        .as_str()
        .unwrap()
        .contains("PO-token warning"));
}

#[test]
fn withheld_subtitle_listing_cannot_unlock_whisper_from_empty_maps() {
    let io = ScriptedYoutubeIo::with_metadata_result(Ok(MetadataPayload {
        json: metadata("{}", "{}"),
        annotations: vec![YoutubeAnnotation::SubtitleListingWithheld],
    }));
    let mut session = YoutubeToolSession::default();
    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    support::assert_tool_failed(&result.outcome);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["error"]["next_action"], "surface");
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("caption listing was withheld"));
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("absence is unproven"));
    assert!(!session.can_transcribe(&YoutubeUrl::new(URL).unwrap()));
}

#[test]
fn host_failure_details_are_bounded_and_never_expose_paths_to_the_model() {
    let secret = format!("/private/tmp/neuralnote-secret\n{}", "x".repeat(2_000));
    let io =
        ScriptedYoutubeIo::with_metadata_result(Err(CaptureError::MetadataUnavailable(secret)));
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    support::assert_tool_failed(&result.outcome);
    assert!(result.content.contains("metadata_unavailable"));
    assert!(!result.content.contains("/private/tmp"));
    assert!(result.content.len() < 1_000);
}

#[test]
fn youtube_tools_reject_malformed_arguments_and_non_youtube_urls() {
    for tool in [
        TOOL_FETCH_VIDEO_INFO,
        TOOL_FETCH_CAPTIONS,
        TOOL_TRANSCRIBE_AUDIO,
    ] {
        let malformed = call(
            &ScriptedYoutubeIo::new(metadata("{}", "{}")),
            &mut YoutubeToolSession::default(),
            &environment(true),
            tool,
            "{not-json",
        );
        assert_eq!(malformed.outcome, ToolOutcome::Rejected, "{tool}");
        assert!(malformed.content.contains("arguments"), "{tool}");

        let invalid_url = call(
            &ScriptedYoutubeIo::new(metadata("{}", "{}")),
            &mut YoutubeToolSession::default(),
            &environment(true),
            tool,
            r#"{"url":"https://example.com/not-youtube"}"#,
        );
        assert_eq!(invalid_url.outcome, ToolOutcome::Rejected, "{tool}");
        assert!(invalid_url.content.contains("invalid_source"), "{tool}");
    }

    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let shell_suffix = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(true),
        TOOL_FETCH_VIDEO_INFO,
        r#"{"url":"https://www.youtube.com/watch?v=x $(rm -rf ~)"}"#,
    );
    assert_eq!(shell_suffix.outcome, ToolOutcome::Rejected);
    assert!(shell_suffix.content.contains("invalid_source"));
    assert_eq!(io.metadata.lock().unwrap().len(), 1);
}

#[test]
fn captions_surface_invalid_language_inventory_and_vtt_without_fallback() {
    let invalid_language = call(
        &ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}")),
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":""}}"#),
    );
    // `invalid_source`: `lang` is the model's own argument and nothing has been
    // fetched yet, so this is a refusal, not unusable data (#116).
    assert_eq!(invalid_language.outcome, ToolOutcome::Rejected);
    assert!(invalid_language.content.contains("invalid_source"));

    let unavailable_language = call(
        &ScriptedYoutubeIo::new(metadata(r#"{"fr":[{"ext":"vtt"}]}"#, "{}")),
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );
    assert!(unavailable_language.content.contains("invalid_metadata"));
    assert!(!unavailable_language.content.contains("offer_whisper"));

    let invalid_vtt = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    invalid_vtt.push_caption(Ok(CaptionPayload {
        vtt: b"not webvtt".to_vec(),
        annotations: Vec::new(),
    }));
    let result = call(
        &invalid_vtt,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );
    assert!(result.content.contains("invalid_vtt"));
    assert!(result.content.contains("surface"));
}

#[test]
fn pre_cancelled_transcription_never_reaches_the_host() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let cancellation = CaptureCancellation::default();
    let mut session = YoutubeToolSession::new(cancellation.clone());
    prove_caption_absence(&io, &mut session);
    cancellation.cancel();

    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert!(result.content.contains("cancelled"));
    assert_eq!(io.transcribe_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn empty_and_windows_host_errors_have_safe_model_messages() {
    for (detail, forbidden) in [("", "never-present"), (r"C:\secret\token.txt", "secret")] {
        let io = ScriptedYoutubeIo::with_metadata_result(Err(CaptureError::MetadataUnavailable(
            detail.into(),
        )));
        let result = call(
            &io,
            &mut YoutubeToolSession::default(),
            &environment(false),
            TOOL_FETCH_VIDEO_INFO,
            &format!(r#"{{"url":"{URL}"}}"#),
        );
        let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
        assert!(!value["error"]["message"]
            .as_str()
            .unwrap()
            .contains(forbidden));
        assert!(!value["error"]["message"].as_str().unwrap().is_empty());
    }
}

#[test]
fn fetch_captions_parses_vtt_and_returns_rendered_source_record() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: vec![YoutubeAnnotation::PotUnavailable],
    }));
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["provenance"], "captions:en");
    assert!(value["transcript"]
        .as_str()
        .unwrap()
        .contains("[00:00:00](https://youtu.be/iG9CE55wbtY?t=0) Hello & welcome"));
    assert!(!result.content.contains("WEBVTT"));
    assert_eq!(value["annotations"].as_array().unwrap().len(), 1);
    assert_eq!(value["cost_estimate"]["display"], "free — runs locally");
    assert_eq!(value["cost_estimate"]["wordCount"], 3);
}

#[test]
fn pricing_failure_preserves_completed_caption_result_with_an_annotation() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let pricing = PricingInput::Hosted(ModelPricing {
        model: "provider/model".into(),
        input_usd_per_token: f64::NAN,
    });
    let result = call_with_pricing(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
        &pricing,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert!(value["transcript"].as_str().unwrap().contains("Hello"));
    assert!(value["cost_estimate"].is_null());
    assert!(value["annotations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|annotation| annotation
            .as_str()
            .unwrap()
            .contains("cost estimate unavailable (invalid_metadata)")));
}

#[test]
fn pricing_failure_preserves_completed_transcription_with_an_annotation() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();
    prove_caption_absence(&io, &mut session);
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let pricing = PricingInput::Hosted(ModelPricing {
        model: "provider/model".into(),
        input_usd_per_token: f64::INFINITY,
    });
    let result = call_with_pricing(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
        &pricing,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert!(value["transcript"].as_str().unwrap().contains("Hello"));
    assert!(value["cost_estimate"].is_null());
    assert!(value["annotations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|annotation| annotation
            .as_str()
            .unwrap()
            .contains("cost estimate unavailable (invalid_metadata)")));
}

#[test]
fn pot_failure_retries_without_sidecar_and_surfaces_annotation() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Err(CaptureError::PotUnavailable(
        "bgutil provider timed out".into(),
    )));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    let annotations = value["annotations"].as_array().unwrap();
    assert_eq!(annotations.len(), 1);
    assert!(annotations[0]
        .as_str()
        .unwrap()
        .contains("continued without POT"));
    assert_eq!(io.updates.load(Ordering::SeqCst), 0);
    assert_eq!(
        *io.caption_pot_modes.lock().unwrap(),
        [PotMode::Prefer, PotMode::Disabled]
    );
}

#[test]
fn caption_retry_composes_extractor_update_then_plain_without_pot() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Err(CaptureError::ExtractorStale("stale extractor".into())));
    io.push_caption(Err(CaptureError::PotUnavailable("sidecar down".into())));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));

    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
    assert_eq!(
        *io.caption_pot_modes.lock().unwrap(),
        [PotMode::Prefer, PotMode::Prefer, PotMode::Disabled]
    );
    assert!(result.content.contains("continued without POT"));
}

#[test]
fn caption_retry_composes_plain_without_pot_then_extractor_update() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Err(CaptureError::PotUnavailable("sidecar down".into())));
    io.push_caption(Err(CaptureError::ExtractorStale("stale extractor".into())));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));

    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
    assert_eq!(
        *io.caption_pot_modes.lock().unwrap(),
        [PotMode::Prefer, PotMode::Disabled, PotMode::Disabled]
    );
    assert!(result.content.contains("continued without POT"));
}

#[test]
fn extractor_staleness_updates_and_retries_at_most_once() {
    let io = ScriptedYoutubeIo::new(Vec::new());
    *io.metadata.lock().unwrap() = VecDeque::from([
        Err(CaptureError::ExtractorStale(
            "nsig extraction failed".into(),
        )),
        Ok(MetadataPayload {
            json: metadata("{}", "{}"),
            annotations: Vec::new(),
        }),
    ]);
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
}

#[test]
fn exhausted_internal_extractor_retry_is_surfaced_not_offered_again() {
    let io = ScriptedYoutubeIo::new(Vec::new());
    *io.metadata.lock().unwrap() = VecDeque::from([
        Err(CaptureError::ExtractorStale("first failure".into())),
        Err(CaptureError::ExtractorStale("retry still stale".into())),
    ]);
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    support::assert_tool_failed(&result.outcome);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["error"]["kind"], "extractor_stale");
    assert_eq!(value["error"]["next_action"], "surface");
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
}

#[test]
fn only_genuine_caption_absence_unlocks_whisper_for_that_source() {
    let absent = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();
    let absent_result = call(
        &absent,
        &mut session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );
    support::assert_tool_failed(&absent_result.outcome);
    assert!(absent_result.content.contains("captions_absent"));
    assert!(session.can_transcribe(&YoutubeUrl::new(URL).unwrap()));

    absent.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let transcript = call(
        &absent,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );
    assert_eq!(transcript.outcome, ToolOutcome::Action);
    assert!(transcript.content.contains("whisper:small.en"));
    assert!(transcript
        .content
        .contains("[00:00:00](https://youtu.be/iG9CE55wbtY?t=0) Hello & welcome"));

    let denied = call(
        &absent,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        r#"{"url":"https://youtu.be/different"}"#,
    );
    assert_eq!(denied.outcome, ToolOutcome::Rejected);
    assert!(denied.content.contains("requirement_missing"));
    assert!(denied.content.contains("surface"));
    assert_eq!(absent.transcribe_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn blocked_caption_fetch_is_terminal_and_never_unlocks_whisper() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Err(CaptureError::YoutubeBlocked(
        "Sign in to confirm you're not a bot".into(),
    )));
    let mut session = YoutubeToolSession::default();
    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    support::assert_tool_failed(&result.outcome);
    assert!(result.content.contains("youtube_blocked"));
    assert!(result.content.contains("terminal"));
    assert!(!session.can_transcribe(&YoutubeUrl::new(URL).unwrap()));
}

#[test]
fn block_latches_for_the_run_and_prevents_further_youtube_io() {
    let metadata_json = metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}");
    let io = ScriptedYoutubeIo::new(metadata_json.clone());
    io.metadata.lock().unwrap().push_back(Ok(MetadataPayload {
        json: metadata_json,
        annotations: Vec::new(),
    }));
    io.push_caption(Err(CaptureError::YoutubeBlocked(
        "Sign in to confirm you're not a bot".into(),
    )));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let mut session = YoutubeToolSession::default();

    let first = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );
    let second = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    support::assert_tool_failed(&first.outcome);
    support::assert_tool_failed(&second.outcome);
    assert!(second.content.contains("youtube_blocked"));
    assert_eq!(io.metadata.lock().unwrap().len(), 1);
    assert_eq!(io.captions.lock().unwrap().len(), 1);
}

#[test]
fn transcribe_requires_the_optional_whisper_bundle() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();

    let result = call(
        &io,
        &mut session,
        &environment(false),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("requirement_missing"));
    assert_eq!(io.transcribe_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn missing_whisper_bundle_is_installed_after_implementation_authored_consent() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();
    prove_caption_absence(&io, &mut session);
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let installer = RecordingInstaller::default();

    let result = call_with_installer(&io, &mut session, &installer, &InstallPrompt);

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(installer.0.load(Ordering::SeqCst), 1);
    assert!(result.content.contains("whisper:small.en"));
}

#[test]
fn unproven_caption_absence_never_prompts_or_installs_whisper() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();
    let installer = RecordingInstaller::default();

    let result = call_with_installer(&io, &mut session, &installer, &PanicPrompt);

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result
        .content
        .contains("caption absence has not been proven"));
    assert_eq!(installer.0.load(Ordering::SeqCst), 0);
}

#[test]
fn cancellation_between_transcription_attempts_prevents_update_and_retry() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.push_transcription(Err(CaptureError::ExtractorStale(
        "audio extraction went stale".into(),
    )));
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    io.cancel_during_transcription();
    let cancellation = CaptureCancellation::default();
    let mut session = YoutubeToolSession::new(cancellation);
    prove_caption_absence(&io, &mut session);

    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Cancelled);
    assert!(result.content.contains("cancelled"));
    assert_eq!(io.transcribe_calls.load(Ordering::SeqCst), 1);
    assert_eq!(io.updates.load(Ordering::SeqCst), 0);
    // The guard keys on the cancellation FLAG, so it cannot know whether the
    // attempt it interrupted was healthy. Whatever that attempt reported has to
    // travel with the cancellation or it is gone for good.
    assert!(
        result.content.contains("audio extraction went stale"),
        "the interrupted attempt's own error must survive: {}",
        result.content
    );
}

#[test]
fn a_transcription_crash_that_coincides_with_a_stop_still_names_the_crash() {
    // The silent-failure case. `whisper-cli` dies, and the user presses Stop a
    // few milliseconds later — or the other way round; from here they are the
    // same instant. The cancellation guard fires on the flag, not the cause, and
    // it used to drop the error binding entirely (`Err(_error) if …`), so a real
    // crash left NO trace: not in the tool result, not in the timeline, nowhere.
    // That is the one thing this codebase does not do with failures.
    //
    // The outcome is Cancelled — the run ended, NeuralNote did not refuse and
    // did not break — but the account it carries has to be the whole account.
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.push_transcription(Err(CaptureError::TranscriptionFailed(
        "whisper-cli exited with signal 11".into(),
    )));
    io.cancel_during_transcription();
    let cancellation = CaptureCancellation::default();
    let mut session = YoutubeToolSession::new(cancellation);
    prove_caption_absence(&io, &mut session);

    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Cancelled);
    assert!(result.content.contains("cancelled"), "{}", result.content);
    assert!(
        result.content.contains("whisper-cli exited with signal 11"),
        "a crash that raced the Stop must not vanish: {}",
        result.content
    );
    assert_eq!(io.transcribe_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn cancellation_during_extractor_update_prevents_transcription_retry() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.push_transcription(Err(CaptureError::ExtractorStale(
        "audio extraction went stale".into(),
    )));
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let cancellation = CaptureCancellation::default();
    io.cancel_during_update(cancellation.clone());
    let mut session = YoutubeToolSession::new(cancellation);
    prove_caption_absence(&io, &mut session);

    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Cancelled);
    assert!(result.content.contains("cancelled"));
    assert_eq!(io.transcribe_calls.load(Ordering::SeqCst), 1);
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
    // Same rule one branch over: the staleness that PROMPTED the update is the
    // only account of why this call went nowhere beyond "the run ended".
    assert!(
        result.content.contains("audio extraction went stale"),
        "the error that triggered the update must survive: {}",
        result.content
    );
}

/// Every `ToolProgress` in order, paired with the call id it is keyed to. The id
/// matters as much as the message: progress that lands on the wrong node renders
/// on the wrong row.
fn tool_progress(events: &[ChatEvent]) -> Vec<(String, String)> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::ToolProgress { id, message } => Some((id.clone(), message.clone())),
            _ => None,
        })
        .collect()
}

fn progress_messages(events: &[ChatEvent]) -> Vec<String> {
    tool_progress(events)
        .into_iter()
        .map(|(_, message)| message)
        .collect()
}

/// The one preview this run emitted, unwrapped into the fields a card renders.
type PreviewFields = (String, String, Option<u64>, Option<String>, Option<String>);

fn only_preview(events: &[ChatEvent]) -> PreviewFields {
    let previews: Vec<&ChatEvent> = events
        .iter()
        .filter(|event| matches!(event, ChatEvent::VideoPreview { .. }))
        .collect();
    assert_eq!(
        previews.len(),
        1,
        "expected exactly one preview: {previews:?}"
    );
    match previews[0] {
        ChatEvent::VideoPreview {
            video_id,
            title,
            duration_secs,
            channel,
            thumbnail_data_uri,
        } => (
            video_id.clone(),
            title.clone(),
            *duration_secs,
            channel.clone(),
            thumbnail_data_uri.clone(),
        ),
        other => unreachable!("filtered to previews, got {other:?}"),
    }
}

fn jpeg_bytes() -> Vec<u8> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut buffer, image::ImageFormat::Jpeg)
        .unwrap();
    buffer.into_inner()
}

#[test]
fn a_long_transcription_says_what_it_is_doing_before_it_starts() {
    // Whisper can run for minutes with nothing on the channel between the
    // `ToolCall` and the `ToolResult`, which is indistinguishable from a hang.
    // The tool now narrates itself from inside.
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let mut session = YoutubeToolSession::default();
    prove_caption_absence(&io, &mut session);

    let (result, events) = call_collecting_events(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let progress = tool_progress(&events);
    assert!(
        !progress.is_empty() && progress.iter().all(|(id, _)| id == "youtube-call"),
        "progress must key to the call it belongs to: {progress:?}"
    );
    let messages = progress_messages(&events);
    assert!(
        messages
            .iter()
            .any(|message| message.contains("local transcription")),
        "the availability check is its own wait: {messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|message| message.contains("Whisper") && message.contains("small.en")),
        "the long wait must name what is running: {messages:?}"
    );
}

#[test]
fn a_silent_caption_retry_becomes_a_visible_one() {
    // A retry that says nothing is indistinguishable from a longer silence,
    // which is the exact complaint this work exists to fix.
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Err(CaptureError::ExtractorStale("stale extractor".into())));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let messages = progress_messages(&events);
    assert!(
        messages.iter().any(|message| message.contains("yt-dlp")),
        "the extractor update is a wait of its own: {messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|message| message.to_lowercase().contains("retrying")),
        "the retry must read as a retry: {messages:?}"
    );
}

#[test]
fn a_pot_fallback_retry_reaches_the_user_and_not_only_the_model() {
    // The fallback used to land in `session.annotate`, which reaches the model
    // and the tool result but never the person watching the rail.
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Err(CaptureError::PotUnavailable("sidecar down".into())));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let messages = progress_messages(&events);
    assert!(
        messages.iter().any(|message| message.contains("POT")),
        "the POT fallback must be visible on the timeline: {messages:?}"
    );
}

#[test]
fn a_video_lookup_narrates_its_first_attempt_and_not_only_its_retry() {
    // The lookup shells out to yt-dlp against YouTube, so its FIRST attempt is
    // already a wait worth narrating. Announcing only the retry would leave the
    // opening tool of a distil run silent for its whole duration on the ordinary
    // path — and would say nothing at all where the caption fetch beside it
    // announces every attempt it makes.
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(io.updates.load(Ordering::SeqCst), 0);
    let messages = progress_messages(&events);
    assert!(
        messages
            .iter()
            .any(|message| message.contains("Looking up the video")),
        "the ordinary path must narrate too, not only the retry: {messages:?}"
    );
}

#[test]
fn a_failed_extractor_update_is_told_to_the_user_and_not_only_the_model() {
    // `update_extractor` annotated the session and said nothing else, so a
    // yt-dlp self-update that failed was a silent wait followed by a second
    // failure the user could not account for.
    let io = ScriptedYoutubeIo::new(Vec::new());
    io.fail_updates(CaptureError::ExtractorStale("yt-dlp -U exited 1".into()));
    *io.metadata.lock().unwrap() = VecDeque::from([
        Err(CaptureError::ExtractorStale(
            "nsig extraction failed".into(),
        )),
        Ok(MetadataPayload {
            json: metadata("{}", "{}"),
            annotations: Vec::new(),
        }),
    ]);

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let messages = progress_messages(&events);
    assert!(
        messages
            .iter()
            .any(|message| message.contains("Updating yt-dlp")),
        "the update announces itself on entry, not only on failure: {messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|message| message.contains("extractor_stale")),
        "a failed update is a failure, and failures are never silent: {messages:?}"
    );
}

#[test]
fn a_failed_extractor_update_never_claims_the_retry_uses_a_new_extractor() {
    // `ToolProgress` is last-writer-wins by contract, so a failure announced and
    // then immediately followed by another line is a failure the user never sees.
    // Worse, the line that replaced it used to read "with the updated extractor"
    // — asserting the update landed at the exact moment it had not.
    let io = ScriptedYoutubeIo::new(Vec::new());
    io.fail_updates(CaptureError::ExtractorStale("yt-dlp -U exited 1".into()));
    *io.metadata.lock().unwrap() = VecDeque::from([
        Err(CaptureError::ExtractorStale(
            "nsig extraction failed".into(),
        )),
        Ok(MetadataPayload {
            json: metadata("{}", "{}"),
            annotations: Vec::new(),
        }),
    ]);

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let messages = progress_messages(&events);
    assert!(
        !messages
            .iter()
            .any(|message| message.contains("updated extractor")),
        "nothing may claim an update that failed: {messages:?}"
    );
    // And the surviving line — the one the user is actually left looking at —
    // has to carry the failure, not merely avoid contradicting it.
    let last = messages.last().expect("the retry narrates itself");
    assert!(
        last.contains("extractor_stale") && last.contains("current"),
        "the line left standing must say the retry runs on the old binary: {last}"
    );
}

#[test]
fn a_successful_extractor_update_says_so_on_the_line_that_survives() {
    // The other half of the same contract: when the update DOES land, the line
    // left standing must say so, or the honest-failure wording above would just
    // be a pessimistic constant.
    let io = ScriptedYoutubeIo::new(Vec::new());
    *io.metadata.lock().unwrap() = VecDeque::from([
        Err(CaptureError::ExtractorStale(
            "nsig extraction failed".into(),
        )),
        Ok(MetadataPayload {
            json: metadata("{}", "{}"),
            annotations: Vec::new(),
        }),
    ]);

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
    let messages = progress_messages(&events);
    let last = messages.last().expect("the retry narrates itself");
    assert!(
        last.contains("updated extractor"),
        "an update that landed must be reported as one: {last}"
    );
}

#[test]
fn a_transcription_retry_after_an_extractor_update_narrates_itself() {
    // The third retry path. Its two existing tests both arm a cancellation that
    // diverts before this branch, so the narration added here was never actually
    // reached by a test — a line of code asserting it informs the user, with
    // nothing proving it runs.
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.push_transcription(Err(CaptureError::ExtractorStale(
        "audio extraction went stale".into(),
    )));
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let mut session = YoutubeToolSession::default();
    prove_caption_absence(&io, &mut session);

    let (result, events) = call_collecting_events(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(io.transcribe_calls.load(Ordering::SeqCst), 2);
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
    let messages = progress_messages(&events);
    assert!(
        messages
            .iter()
            .any(|message| message.contains("Retrying the transcription")),
        "the retry that actually happened must be visible: {messages:?}"
    );
}

#[test]
fn a_video_lookup_previews_the_video_it_found() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.set_thumbnail(Ok(ThumbnailPayload {
        media_type: "image/jpeg".into(),
        bytes: jpeg_bytes(),
    }));

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let (video_id, title, duration, channel, thumbnail) = only_preview(&events);
    assert_eq!(video_id, "iG9CE55wbtY");
    assert_eq!(title, "Do schools kill creativity?");
    assert_eq!(duration, Some(123));
    assert_eq!(channel.as_deref(), Some("TED"));
    // Same transport as `ElicitOption::image_data_uri`: the webview never talks
    // to Google, so it needs no third-party network allowlist.
    assert!(
        thumbnail
            .as_deref()
            .is_some_and(|uri| uri.starts_with("data:image/jpeg;base64,")),
        "{thumbnail:?}"
    );
    assert_eq!(io.thumbnail_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn a_thumbnail_that_times_out_still_leaves_a_preview_standing() {
    // The degraded path, and the likely one. A timeout arrives from the host as
    // a rejected thumbnail; the card renders text-only rather than not at all.
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.set_thumbnail(Err(CaptureError::ThumbnailRejected(
        "thumbnail request failed: operation timed out".into(),
    )));

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let (_, title, _, _, thumbnail) = only_preview(&events);
    assert_eq!(title, "Do schools kill creativity?");
    assert_eq!(thumbnail, None);
}

#[test]
fn an_oversized_thumbnail_never_reaches_the_channel() {
    // The byte cap runs before any decode, so an oversized payload is refused
    // without being parsed and never bloats the event channel.
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.set_thumbnail(Ok(ThumbnailPayload {
        media_type: "image/jpeg".into(),
        bytes: vec![0xFF; neuralnote_core::capture::MAX_THUMBNAIL_BYTES + 1],
    }));

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let (_, _, _, _, thumbnail) = only_preview(&events);
    assert_eq!(thumbnail, None);
}

#[test]
fn a_thumbnail_failure_of_any_kind_never_fails_the_video_lookup() {
    // Playlist selection escalates a non-`ThumbnailRejected` error to a failed
    // tool call. The preview must not: it is a nice-to-have hanging off a lookup
    // that has already succeeded, so EVERY error degrades to no image.
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.set_thumbnail(Err(CaptureError::MetadataUnavailable(
        "the image host answered with nonsense".into(),
    )));

    let (result, events) = call_collecting_events(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["video_id"], "iG9CE55wbtY");
    let (_, _, _, _, thumbnail) = only_preview(&events);
    assert_eq!(thumbnail, None);
}
