mod support;

use async_trait::async_trait;
use futures::executor::block_on;
use neuralnote_core::ai::{
    run_chat, ChatEvent, Completion, Elicitation, EventSink, Guards, HardwareSpec,
    KeywordRetriever, LlmClient, LlmRequest, SkillEnvironment, SkillRegistry, SkillServices,
    ToolCall, UndoLedger, UserPrompt, FIXTURE_SKILL_ID, YOUTUBE_DISTIL_SKILL_ID,
};
use neuralnote_core::CoreResult;
use std::collections::{BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use support::FsBackend;

#[derive(Default)]
struct VecEventSink(Vec<ChatEvent>);

impl EventSink for VecEventSink {
    fn send(&mut self, event: ChatEvent) {
        self.0.push(event);
    }
}

struct YesPrompt;

#[async_trait]
impl UserPrompt for YesPrompt {
    async fn ask(&self, _elicitation: Elicitation) -> CoreResult<Option<Vec<String>>> {
        Ok(Some(vec!["continue".into()]))
    }
}

struct RecordingLlm {
    completions: Mutex<VecDeque<Completion>>,
    requests: Mutex<Vec<LlmRequest>>,
    answer: String,
}

impl RecordingLlm {
    fn new(completions: Vec<Completion>) -> Self {
        Self {
            completions: Mutex::new(completions.into()),
            requests: Mutex::new(Vec::new()),
            answer: "Finished.".into(),
        }
    }

    fn requests(&self) -> Vec<LlmRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl LlmClient for RecordingLlm {
    async fn complete(&self, request: &LlmRequest) -> CoreResult<Completion> {
        self.requests.lock().unwrap().push(request.clone());
        Ok(self
            .completions
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(final_turn))
    }

    async fn complete_streaming(
        &self,
        request: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<String> {
        self.requests.lock().unwrap().push(request.clone());
        sink.send(ChatEvent::Answer {
            delta: self.answer.clone(),
        });
        Ok(self.answer.clone())
    }
}

fn tool_call(id: &str, name: &str, arguments: &str) -> Completion {
    Completion {
        content: None,
        tool_calls: vec![ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: arguments.into(),
        }],
    }
}

fn parallel(calls: Vec<ToolCall>) -> Completion {
    Completion {
        content: None,
        tool_calls: calls,
    }
}

fn final_turn() -> Completion {
    Completion {
        content: Some("ready".into()),
        tool_calls: Vec::new(),
    }
}

fn environment() -> SkillEnvironment {
    SkillEnvironment {
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
    }
}

fn names(request: &LlmRequest) -> BTreeSet<String> {
    request
        .tools
        .iter()
        .filter_map(|schema| schema["function"]["name"].as_str().map(str::to_string))
        .collect()
}

fn run(
    root: &Path,
    llm: &RecordingLlm,
    active_skills: Vec<String>,
    disabled: &[String],
    guards: &Guards,
) -> (Vec<ChatEvent>, UndoLedger) {
    let retriever = KeywordRetriever::new(root);
    let registry = SkillRegistry::built_in(disabled).unwrap();
    let environment = environment();
    let services = SkillServices::new(&registry, &environment, &YesPrompt, &FsBackend, 1);
    let mut sink = VecEventSink::default();
    let ledger = block_on(run_chat(
        "run the fixture",
        &[],
        active_skills,
        root,
        "test-model",
        &retriever,
        llm,
        &services,
        &mut sink,
        guards,
    ))
    .unwrap();
    (sink.0, ledger)
}

#[test]
fn base_prompt_contains_only_the_compact_enabled_catalogue() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![final_turn()]);
    run(vault.path(), &llm, Vec::new(), &[], &Guards::default());

    let request = &llm.requests()[0];
    let system = request.messages[0].content.as_deref().unwrap();
    assert!(system.contains("fixture-note-workflow:"));
    assert!(!system.contains("# Fixture skill"));
    assert!(names(request).contains("use_skill"));
    assert!(!names(request).contains("write_note"));
}

#[test]
fn disabled_fixture_is_absent_from_catalogue_and_rejected_by_use_skill() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![
        tool_call(
            "activate",
            "use_skill",
            &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
        ),
        final_turn(),
    ]);
    let disabled = vec![FIXTURE_SKILL_ID.into()];

    let (events, _) = run(
        vault.path(),
        &llm,
        Vec::new(),
        &disabled,
        &Guards::default(),
    );
    let requests = llm.requests();
    let system = requests[0].messages[0].content.as_deref().unwrap();

    assert!(!system.contains(FIXTURE_SKILL_ID));
    assert!(requests
        .iter()
        .all(|request| !names(request).contains("write_note")));
    assert!(requests
        .iter()
        .any(|request| request.messages.iter().any(|message| {
            message.content.as_deref().is_some_and(|content| {
                content.contains(FIXTURE_SKILL_ID) && content.contains("disabled")
            })
        })));
    assert!(!events.iter().any(|event| matches!(
        event,
        ChatEvent::SkillActivated { id, .. } if id == FIXTURE_SKILL_ID
    )));
    assert!(events
        .iter()
        .any(|event| matches!(event, ChatEvent::Answer { .. })));
}

#[test]
fn youtube_use_skill_missing_ytdlp_surfaces_a_recoverable_error_without_activation() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![
        tool_call(
            "activate-youtube",
            "use_skill",
            &format!(r#"{{"id":"{YOUTUBE_DISTIL_SKILL_ID}"}}"#),
        ),
        final_turn(),
    ]);

    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());
    let requests = llm.requests();

    assert!(events.iter().any(|event| matches!(event, ChatEvent::Done)));
    assert!(!events
        .iter()
        .any(|event| matches!(event, ChatEvent::Error { .. })));
    assert!(!events
        .iter()
        .any(|event| matches!(event, ChatEvent::Answer { .. })));
    assert!(!events
        .iter()
        .any(|event| matches!(event, ChatEvent::Verifying)));
    assert!(!events.iter().any(|event| matches!(
        event,
        ChatEvent::SkillActivated { id, .. } if id == YOUTUBE_DISTIL_SKILL_ID
    )));
    assert_eq!(
        events
            .iter()
            .filter_map(|event| match event {
                ChatEvent::SkillStep { message } => Some(message.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>(),
        ["Skill 'youtube-distil' could not be activated: skill 'youtube-distil' is not eligible: unmet requirements: required binary 'yt-dlp' is missing from the app-data bin directory — continuing without it"]
    );
    assert!(requests
        .iter()
        .all(|request| !names(request).contains("fetch_video_info")));
    assert_eq!(requests.len(), 1);
}

#[test]
fn disabled_fixture_preload_surfaces_a_recoverable_error_without_activation() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![final_turn()]);
    let disabled = vec![FIXTURE_SKILL_ID.into()];

    let (events, _) = run(
        vault.path(),
        &llm,
        vec![FIXTURE_SKILL_ID.into()],
        &disabled,
        &Guards::default(),
    );
    let requests = llm.requests();

    assert!(events.iter().any(|event| matches!(event, ChatEvent::Done)));
    assert!(!events
        .iter()
        .any(|event| matches!(event, ChatEvent::Error { .. })));
    assert!(!events.iter().any(|event| matches!(
        event,
        ChatEvent::SkillActivated { id, .. } if id == FIXTURE_SKILL_ID
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        ChatEvent::SkillStep { message }
            if message.contains(FIXTURE_SKILL_ID)
                && message.contains(neuralnote_core::ai::SKILL_ACTIVATION_FAILURE_MARK)
                && message.contains("disabled")
    )));
    assert!(requests
        .iter()
        .all(|request| !names(request).contains("write_note")));
    assert!(requests[0].messages.iter().any(|message| {
        message.content.as_deref().is_some_and(|content| {
            content.contains(FIXTURE_SKILL_ID) && content.contains("disabled")
        })
    }));
}

#[test]
fn use_skill_grants_tools_only_on_the_subsequent_request() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![
        tool_call(
            "activate",
            "use_skill",
            &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
        ),
        final_turn(),
    ]);
    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());
    let requests = llm.requests();

    assert!(!names(&requests[0]).contains("write_note"));
    assert!(names(&requests[1]).contains("write_note"));
    assert!(events.iter().any(|event| matches!(
        event,
        ChatEvent::SkillActivated { id, .. } if id == FIXTURE_SKILL_ID
    )));
}

#[test]
fn preloaded_skill_uses_the_same_activation_and_is_ready_on_turn_one() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![final_turn()]);
    let (events, _) = run(
        vault.path(),
        &llm,
        vec![FIXTURE_SKILL_ID.into()],
        &[],
        &Guards::default(),
    );
    let request = &llm.requests()[0];

    assert!(names(request).contains("write_note"));
    assert!(request.messages.iter().any(|message| message
        .content
        .as_deref()
        .is_some_and(|content| content.contains("# Fixture skill"))));
    assert!(events.iter().any(|event| matches!(
        event,
        ChatEvent::SkillActivated { id, .. } if id == FIXTURE_SKILL_ID
    )));
}

#[test]
fn fixture_flow_emits_progress_elicitation_and_written_note_with_undo_entry() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![
        tool_call(
            "activate",
            "use_skill",
            &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
        ),
        tool_call("step", "skill_step", r#"{"message":"Preparing"}"#),
        tool_call(
            "prompt",
            "ask_user",
            r#"{"question":"Continue?","options":[{"id":"continue","label":"Continue","description":null,"imageDataUri":null}],"multi_select":false}"#,
        ),
        tool_call(
            "write",
            "write_note",
            r##"{"rel_path":"Fixture.md","content":"# Fixture","kind":"literature","work_item":0}"##,
        ),
        final_turn(),
    ]);
    let (events, ledger) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());

    let positions = |predicate: fn(&ChatEvent) -> bool| events.iter().position(predicate).unwrap();
    assert!(
        positions(|event| matches!(event, ChatEvent::SkillActivated { .. }))
            < positions(|event| matches!(event, ChatEvent::SkillStep { .. }))
    );
    assert!(
        positions(|event| matches!(event, ChatEvent::SkillStep { .. }))
            < positions(|event| matches!(event, ChatEvent::Elicit { .. }))
    );
    assert!(
        positions(|event| matches!(event, ChatEvent::Elicit { .. }))
            < positions(|event| matches!(event, ChatEvent::NoteWritten { .. }))
    );
    assert_eq!(ledger.entries().len(), 1);
    assert!(vault.path().join("Fixture.md").exists());
}

#[test]
fn skill_override_raises_the_absolute_iteration_ceiling() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![
        tool_call(
            "activate",
            "use_skill",
            &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
        ),
        tool_call("step-1", "skill_step", r#"{"message":"One"}"#),
        tool_call("step-2", "skill_step", r#"{"message":"Two"}"#),
        tool_call("step-3", "skill_step", r#"{"message":"Three"}"#),
        final_turn(),
    ]);
    let guards = Guards {
        max_iterations: 2,
        ..Guards::default()
    };
    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &guards);

    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, ChatEvent::SkillStep { .. }))
            .count(),
        3
    );
}

#[test]
fn newly_granted_tool_is_rejected_in_the_same_parallel_batch() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![
        parallel(vec![
            ToolCall {
                id: "activate".into(),
                name: "use_skill".into(),
                arguments: format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
            },
            ToolCall {
                id: "write".into(),
                name: "write_note".into(),
                arguments: r#"{"rel_path":"Must Not Exist.md","content":"x","kind":"literature","work_item":0}"#.into(),
            },
        ]),
        final_turn(),
    ]);
    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());

    assert!(!vault.path().join("Must Not Exist.md").exists());
    assert!(!events
        .iter()
        .any(|event| matches!(event, ChatEvent::NoteWritten { .. })));
    assert!(llm.requests()[1].messages.iter().any(|message| {
        message
            .content
            .as_deref()
            .is_some_and(|content| content.contains("write_note") && content.contains("not active"))
    }));
}
