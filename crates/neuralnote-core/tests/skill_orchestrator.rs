mod support;

use async_trait::async_trait;
use futures::executor::block_on;
use neuralnote_core::ai::{
    run_chat, ChatEvent, Completion, Elicitation, EventSink, Guards, HardwareSpec,
    KeywordRetriever, LlmClient, LlmRequest, SkillEnvironment, SkillRegistry, SkillServices,
    ToolCall, ToolStatus, UndoLedger, UserPrompt, FIXTURE_SKILL_ID, YOUTUBE_DISTIL_SKILL_ID,
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
    let (policy, approval_prompt, approval_classifier) = support::unattended_approval();
    let services = SkillServices::new(&registry, &environment, &YesPrompt, &FsBackend, 1)
        .with_approval(policy, approval_prompt, approval_classifier);
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

/// Every call the model declared, in order: `(id, name, title)`.
fn announced_calls(events: &[ChatEvent]) -> Vec<(String, String, String)> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::ToolCall {
                id, name, title, ..
            } => Some((id.clone(), name.clone(), title.clone())),
            _ => None,
        })
        .collect()
}

fn settlements(events: &[ChatEvent]) -> Vec<(String, ToolStatus)> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::ToolResult { id, status, .. } => Some((id.clone(), *status)),
            _ => None,
        })
        .collect()
}

/// The invariant the timeline depends on: every declared call is announced once
/// and settles exactly once, and the settlement never precedes the announcement.
/// A node left unsettled spins forever, which is a silent failure.
fn assert_one_settlement_per_call(events: &[ChatEvent]) {
    let calls = announced_calls(events);
    let settled = settlements(events);
    assert_eq!(
        calls.len(),
        settled.len(),
        "announced {} calls but settled {}",
        calls.len(),
        settled.len()
    );
    for (id, _, _) in &calls {
        assert_eq!(
            settled
                .iter()
                .filter(|(settled_id, _)| settled_id == id)
                .count(),
            1,
            "call '{id}' did not settle exactly once"
        );
    }
    for (id, _) in &settled {
        assert!(
            calls.iter().any(|(call_id, _, _)| call_id == id),
            "settlement for '{id}' has no announced call"
        );
        let announced_at = events.iter().position(
            |event| matches!(event, ChatEvent::ToolCall { id: call_id, .. } if call_id == id),
        );
        let settled_at = events.iter().position(
            |event| matches!(event, ChatEvent::ToolResult { id: result_id, .. } if result_id == id),
        );
        assert!(
            announced_at < settled_at,
            "'{id}' settled before it was announced"
        );
    }
}

#[test]
fn list_notes_is_announced_and_settled_instead_of_vanishing() {
    // `list_notes` produced no user-facing event at all before Phase 2 — it hit a
    // no-op arm and died there, so the model could work invisibly.
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![tool_call("l1", "list_notes", "{}"), final_turn()]);

    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());

    assert_eq!(
        announced_calls(&events),
        [(
            "l1".to_string(),
            "list_notes".to_string(),
            "List notes".to_string()
        )]
    );
    assert_eq!(settlements(&events), [("l1".to_string(), ToolStatus::Ok)]);
    assert_one_settlement_per_call(&events);
}

#[test]
fn list_folders_is_announced_and_settled_instead_of_vanishing() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![tool_call("f1", "list_folders", "{}"), final_turn()]);

    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());

    assert_eq!(
        announced_calls(&events),
        [(
            "f1".to_string(),
            "list_folders".to_string(),
            "List folders".to_string()
        )]
    );
    assert_eq!(settlements(&events), [("f1".to_string(), ToolStatus::Ok)]);
}

#[test]
fn a_tool_name_the_model_invented_still_settles_under_a_rust_authored_title() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![
        tool_call("x1", "delete_everything", "{}"),
        final_turn(),
    ]);

    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());

    assert_eq!(
        announced_calls(&events),
        [(
            "x1".to_string(),
            "delete_everything".to_string(),
            "Unrecognised tool".to_string()
        )],
        "the label must come from our table, never from the name the model made up"
    );
    assert_eq!(
        settlements(&events),
        [("x1".to_string(), ToolStatus::Rejected)]
    );
    assert_one_settlement_per_call(&events);
}

#[test]
fn a_tool_that_runs_and_fails_still_settles_with_its_reason() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![
        tool_call(
            "r1",
            "read_note_span",
            r#"{"rel_path":"absent.md","start_line":1,"end_line":2}"#,
        ),
        final_turn(),
    ]);

    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());

    assert_one_settlement_per_call(&events);
    let detail = events
        .iter()
        .find_map(|event| match event {
            ChatEvent::ToolResult { id, detail, .. } if id == "r1" => detail.clone(),
            _ => None,
        })
        .expect("a failed read must carry its reason into the disclosure");
    assert!(
        detail.contains("could not read note span"),
        "unexpected detail: {detail}"
    );
}

#[test]
fn a_call_skipped_by_the_evidence_budget_still_settles() {
    // The second call in the batch never reaches the dispatcher. It must still
    // settle — otherwise its node spins forever with nothing coming.
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("n.md"), "# N\n\nalpha beta\n").unwrap();
    let llm = RecordingLlm::new(vec![
        parallel(vec![
            ToolCall {
                id: "s1".into(),
                name: "search_notes".into(),
                arguments: r#"{"query":"alpha"}"#.into(),
            },
            ToolCall {
                id: "s2".into(),
                name: "search_notes".into(),
                arguments: r#"{"query":"beta"}"#.into(),
            },
        ]),
        final_turn(),
    ]);
    let guards = Guards {
        max_spans: 1,
        ..Guards::default()
    };

    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &guards);

    assert_eq!(
        announced_calls(&events)
            .iter()
            .map(|(id, _, _)| id.clone())
            .collect::<Vec<_>>(),
        ["s1", "s2"]
    );
    assert_eq!(
        settlements(&events),
        [
            ("s1".to_string(), ToolStatus::Ok),
            ("s2".to_string(), ToolStatus::Rejected),
        ]
    );
    assert_one_settlement_per_call(&events);
}

#[test]
fn a_guard_tripped_run_reports_itself_partial_rather_than_leaving_it_to_be_inferred() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("n.md"), "# N\n\nalpha beta\n").unwrap();
    let llm = RecordingLlm::new(vec![
        tool_call("s1", "search_notes", r#"{"query":"alpha"}"#),
        tool_call("s2", "search_notes", r#"{"query":"beta"}"#),
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
            .filter(|event| matches!(event, ChatEvent::PartialRun { .. }))
            .count(),
        1,
        "a partial run is announced exactly once"
    );
}

#[test]
fn a_completed_run_never_claims_to_be_partial() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![tool_call("l1", "list_notes", "{}"), final_turn()]);

    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());

    assert!(!events
        .iter()
        .any(|event| matches!(event, ChatEvent::PartialRun { .. })));
}

#[test]
fn a_failed_preload_reports_the_activation_structurally_not_only_as_prose() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![final_turn()]);

    let (events, _) = run(
        vault.path(),
        &llm,
        vec![YOUTUBE_DISTIL_SKILL_ID.into()],
        &[],
        &Guards::default(),
    );

    let failure = events
        .iter()
        .find_map(|event| match event {
            ChatEvent::SkillActivationFailed {
                id,
                name,
                missing_binary,
                ..
            } => Some((id.clone(), name.clone(), missing_binary.clone())),
            _ => None,
        })
        .expect("a preload that could not activate must say so structurally");
    assert_eq!(failure.0, YOUTUBE_DISTIL_SKILL_ID);
    assert!(!failure.1.is_empty(), "the skill's own name, not its id");
    assert_eq!(
        failure.2,
        Some("yt-dlp".to_string()),
        "the install remedy comes from the requirement set, not from the sentence"
    );
}

#[test]
fn a_failed_use_skill_call_reports_the_activation_structurally() {
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![
        tool_call(
            "activate",
            "use_skill",
            &format!(r#"{{"id":"{YOUTUBE_DISTIL_SKILL_ID}"}}"#),
        ),
        final_turn(),
    ]);

    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());

    assert!(events.iter().any(|event| matches!(
        event,
        ChatEvent::SkillActivationFailed { id, missing_binary: Some(binary), .. }
            if id == YOUTUBE_DISTIL_SKILL_ID && binary == "yt-dlp"
    )));
    assert_one_settlement_per_call(&events);
}

#[test]
fn an_unknown_skill_id_reports_no_install_remedy() {
    // Only a genuinely missing binary earns the install action. An unknown skill
    // must not inherit one just because some other skill needs a binary.
    let vault = tempfile::tempdir().unwrap();
    let llm = RecordingLlm::new(vec![
        tool_call("activate", "use_skill", r#"{"id":"no-such-skill"}"#),
        final_turn(),
    ]);

    let (events, _) = run(vault.path(), &llm, Vec::new(), &[], &Guards::default());

    assert!(events.iter().any(|event| matches!(
        event,
        ChatEvent::SkillActivationFailed { id, name, missing_binary: None, .. }
            if id == "no-such-skill" && name == "no-such-skill"
    )));
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
