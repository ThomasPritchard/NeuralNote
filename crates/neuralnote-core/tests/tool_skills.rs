mod support;

use async_trait::async_trait;
use futures::executor::block_on;
use neuralnote_core::ai::tools::{
    self, ToolContext, ToolOutcome, TOOL_ASK_USER, TOOL_SKILL_STEP, TOOL_USE_SKILL, TOOL_WRITE_NOTE,
};
use neuralnote_core::ai::{
    ActiveSkills, ChatEvent, Elicitation, EventSink, EvidenceRegistry, HardwareSpec,
    KeywordRetriever, Requirement, SkillEnvironment, SkillManifest, SkillRegistry, UserPrompt,
    WriteSession, FIXTURE_SKILL_ID,
};
use neuralnote_core::CoreResult;
use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use support::FsBackend;

#[derive(Clone, Default)]
struct SharedSink(Arc<Mutex<Vec<ChatEvent>>>);

impl EventSink for SharedSink {
    fn send(&mut self, event: ChatEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[derive(Default)]
struct ScriptedPrompt {
    answers: Mutex<VecDeque<CoreResult<Option<Vec<String>>>>>,
    elicitation_count: Mutex<usize>,
}

impl ScriptedPrompt {
    fn push(&self, answer: CoreResult<Option<Vec<String>>>) {
        self.answers.lock().unwrap().push_back(answer);
    }

    fn elicitation_count(&self) -> usize {
        *self.elicitation_count.lock().unwrap()
    }
}

#[async_trait]
impl UserPrompt for ScriptedPrompt {
    async fn ask(&self, _elicitation: Elicitation) -> CoreResult<Option<Vec<String>>> {
        *self.elicitation_count.lock().unwrap() += 1;
        self.answers.lock().unwrap().pop_front().unwrap_or(Ok(None))
    }
}

fn hardware(free_disk_bytes: u64) -> HardwareSpec {
    HardwareSpec {
        total_ram_bytes: 16_000_000_000,
        cpu_cores: 8,
        cpu_brand: "test".into(),
        gpu_label: None,
        arch: "aarch64".into(),
        os: "macos".into(),
        free_disk_bytes,
    }
}

fn environment(free_disk_bytes: u64) -> SkillEnvironment {
    SkillEnvironment {
        hardware: hardware(free_disk_bytes),
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::new(),
    }
}

struct Harness {
    vault: tempfile::TempDir,
    retriever: KeywordRetriever,
    registry: SkillRegistry,
    environment: SkillEnvironment,
    active: ActiveSkills,
    writes: WriteSession,
    sink: SharedSink,
    prompt: ScriptedPrompt,
}

impl Harness {
    fn new(registry: SkillRegistry, environment: SkillEnvironment) -> Self {
        let vault = tempfile::tempdir().unwrap();
        let retriever = KeywordRetriever::new(vault.path());
        Self {
            vault,
            retriever,
            registry,
            environment,
            active: ActiveSkills::new(8),
            writes: WriteSession::new(1).unwrap(),
            sink: SharedSink::default(),
            prompt: ScriptedPrompt::default(),
        }
    }

    fn built_in() -> Self {
        Self::new(
            SkillRegistry::built_in(&[]).unwrap(),
            environment(10_000_000_000),
        )
    }

    fn allowed(&self) -> BTreeSet<String> {
        tools::advertised_tool_names(&tools::tool_schemas(&self.active.authorized_tools()))
    }

    fn call_with_allowed(
        &mut self,
        call_id: &str,
        name: &str,
        arguments: &str,
        allowed: &BTreeSet<String>,
    ) -> tools::ToolResult {
        let mut evidence = EvidenceRegistry::new();
        let mut context = ToolContext::new(
            self.vault.path(),
            &self.registry,
            &self.environment,
            &mut self.active,
            &FsBackend,
            &mut self.writes,
            &mut self.sink,
            allowed,
        );
        block_on(tools::dispatch(
            call_id,
            name,
            arguments,
            &self.retriever,
            &mut evidence,
            &self.prompt,
            &mut context,
        ))
    }

    fn call(&mut self, call_id: &str, name: &str, arguments: &str) -> tools::ToolResult {
        let allowed = self.allowed();
        self.call_with_allowed(call_id, name, arguments, &allowed)
    }

    fn events(&self) -> Vec<ChatEvent> {
        self.sink.0.lock().unwrap().clone()
    }
}

#[test]
fn use_skill_returns_full_instructions_emits_once_and_grants_declared_tools() {
    let mut harness = Harness::built_in();
    let instructions = harness
        .registry
        .lookup(FIXTURE_SKILL_ID)
        .unwrap()
        .instructions
        .clone();

    let first = harness.call(
        "call-1",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );
    let second = harness.call(
        "call-2",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );

    assert_eq!(first.content, instructions);
    assert_eq!(second.content, instructions);
    assert!(harness.active.contains(FIXTURE_SKILL_ID));
    assert_eq!(
        harness.active.authorized_tools(),
        BTreeSet::from([
            TOOL_ASK_USER.into(),
            TOOL_SKILL_STEP.into(),
            TOOL_WRITE_NOTE.into(),
        ])
    );
    assert_eq!(harness.active.max_iterations(1), 12);
    assert_eq!(
        harness
            .events()
            .iter()
            .filter(|event| matches!(event, ChatEvent::SkillActivated { .. }))
            .count(),
        1
    );
}

#[test]
fn use_skill_unknown_disabled_and_unmet_are_total_error_results() {
    let mut unknown = Harness::built_in();
    let result = unknown.call("c1", TOOL_USE_SKILL, r#"{"id":"missing"}"#);
    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("unknown skill"));

    let mut disabled = Harness::new(
        SkillRegistry::built_in(&[FIXTURE_SKILL_ID.into()]).unwrap(),
        environment(10_000),
    );
    let result = disabled.call(
        "c2",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );
    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("disabled"));

    let manifest = SkillManifest {
        id: "disk-heavy".into(),
        name: "Disk heavy".into(),
        version: "1".into(),
        description: "Needs disk".into(),
        icon: "disk".into(),
        instructions: "full instructions".into(),
        tools: vec![TOOL_SKILL_STEP.into()],
        requirements: vec![Requirement::FreeDiskSpace { min_bytes: 100 }],
        optional_requirements: Vec::new(),
        max_iterations: None,
        max_context_chars: None,
    };
    let mut unmet = Harness::new(
        SkillRegistry::new(vec![manifest], &[]).unwrap(),
        environment(99),
    );
    let result = unmet.call("c3", TOOL_USE_SKILL, r#"{"id":"disk-heavy"}"#);
    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("disk"));
}

#[test]
fn skill_dispatchers_reject_malformed_json_with_tool_specific_errors() {
    let mut harness = Harness::built_in();

    let use_skill = harness.call("malformed-use-skill", TOOL_USE_SKILL, "{");
    assert_eq!(use_skill.outcome, ToolOutcome::Rejected);
    assert!(use_skill.content.contains("invalid use_skill arguments"));

    harness.call(
        "activate",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );
    for (call_id, tool, expected_error) in [
        (
            "malformed-skill-step",
            TOOL_SKILL_STEP,
            "invalid skill_step arguments",
        ),
        (
            "malformed-ask-user",
            TOOL_ASK_USER,
            "invalid ask_user arguments",
        ),
        (
            "malformed-write-note",
            TOOL_WRITE_NOTE,
            "invalid write_note arguments",
        ),
    ] {
        let result = harness.call(call_id, tool, "{");
        assert_eq!(result.outcome, ToolOutcome::Rejected);
        assert!(result.content.contains(expected_error));
    }
}

#[test]
fn skill_step_requires_a_grant_then_emits_progress() {
    let mut harness = Harness::built_in();
    let result = harness.call("c1", TOOL_SKILL_STEP, r#"{"message":"Working"}"#);
    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("not active"));

    harness.call(
        "c2",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );
    let result = harness.call("c3", TOOL_SKILL_STEP, r#"{"message":"Working"}"#);
    assert_eq!(result.outcome, ToolOutcome::Action);
    assert!(harness
        .events()
        .iter()
        .any(|event| matches!(event, ChatEvent::SkillStep { message } if message == "Working")));
}

#[test]
fn skill_step_rejects_a_blank_message_without_emitting_progress() {
    let mut harness = Harness::built_in();
    harness.call(
        "activate",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );

    let result = harness.call(
        "blank-skill-step",
        TOOL_SKILL_STEP,
        r#"{"message":" \n\t"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result
        .content
        .contains("skill_step message cannot be empty"));
    assert!(!harness
        .events()
        .iter()
        .any(|event| matches!(event, ChatEvent::SkillStep { .. })));
}

#[test]
fn ask_user_rejects_model_authored_data_uri_images_without_eliciting_user() {
    let mut harness = Harness::built_in();
    harness.call(
        "activate",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );
    let result = harness.call(
        "prompt-data-uri",
        TOOL_ASK_USER,
        r#"{
            "question":"Choose",
            "options":[
                {
                    "id":"with-image",
                    "label":"With image",
                    "description":null,
                    "imageDataUri":"data:image/png;base64,iVBORw0KGgo="
                },
                {
                    "id":"without-image",
                    "label":"Without image",
                    "description":null,
                    "imageDataUri":null
                }
            ],
            "multi_select":false
        }"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result
        .content
        .contains("model-authored images are not allowed"));
    assert_eq!(harness.prompt.elicitation_count(), 0);
    assert!(!harness
        .events()
        .iter()
        .any(|event| matches!(event, ChatEvent::Elicit { .. })));
}

#[test]
fn ask_user_rejects_non_data_uri_images_without_eliciting_user() {
    let mut harness = Harness::built_in();
    harness.call(
        "activate",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );
    harness.prompt.push(Ok(Some(vec!["remote-image".into()])));

    let result = harness.call(
        "prompt-remote-image",
        TOOL_ASK_USER,
        r#"{
            "question":"Choose",
            "options":[
                {
                    "id":"remote-image",
                    "label":"Remote image",
                    "description":null,
                    "imageDataUri":"https://evil.example/x.png"
                }
            ],
            "multi_select":false
        }"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("remote-image"));
    assert!(result
        .content
        .contains("model-authored images are not allowed"));
    assert_eq!(harness.prompt.elicitation_count(), 0);
    assert!(!harness
        .events()
        .iter()
        .any(|event| matches!(event, ChatEvent::Elicit { .. })));
}

#[test]
fn ask_user_rejects_blank_questions_and_empty_options_without_eliciting_user() {
    let mut harness = Harness::built_in();
    harness.call(
        "activate",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );

    for (call_id, arguments) in [
        (
            "blank-question",
            r#"{
                "question":"  ",
                "options":[{
                    "id":"a",
                    "label":"Alpha",
                    "description":null,
                    "imageDataUri":null
                }],
                "multi_select":false
            }"#,
        ),
        (
            "empty-options",
            r#"{
                "question":"Choose",
                "options":[],
                "multi_select":false
            }"#,
        ),
    ] {
        let result = harness.call(call_id, TOOL_ASK_USER, arguments);
        assert_eq!(result.outcome, ToolOutcome::Rejected);
        assert!(result
            .content
            .contains("ask_user requires a question and at least one option"));
    }
    assert_eq!(harness.prompt.elicitation_count(), 0);
    assert!(!harness
        .events()
        .iter()
        .any(|event| matches!(event, ChatEvent::Elicit { .. })));
}

#[test]
fn ask_user_dispatch_validates_answers_and_returns_only_chosen_ids() {
    let mut harness = Harness::built_in();
    harness.call(
        "activate",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );
    let args = r#"{
        "question":"Choose",
        "options":[
            {"id":"a","label":"Alpha","description":"secret description","imageDataUri":null},
            {"id":"b","label":"Beta","description":null,"imageDataUri":null}
        ],
        "multi_select":false
    }"#;

    harness.prompt.push(Ok(Some(vec!["a".into()])));
    let answered = harness.call("prompt-1", TOOL_ASK_USER, args);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&answered.content).unwrap(),
        serde_json::json!({"chosen_ids":["a"]})
    );
    assert!(!answered.content.contains("Alpha"));
    assert!(!answered.content.contains("secret"));

    harness.prompt.push(Ok(Some(vec!["a".into(), "b".into()])));
    let wrong_arity = harness.call("prompt-2", TOOL_ASK_USER, args);
    assert_eq!(wrong_arity.outcome, ToolOutcome::Rejected);
    assert!(wrong_arity.content.contains("exactly one"));

    harness.prompt.push(Ok(Some(vec!["unknown".into()])));
    let unknown = harness.call("prompt-3", TOOL_ASK_USER, args);
    assert_eq!(unknown.outcome, ToolOutcome::Rejected);
    assert!(unknown.content.contains("not an offered option"));

    harness.prompt.push(Ok(None));
    let none = harness.call("prompt-4", TOOL_ASK_USER, args);
    assert_eq!(none.outcome, ToolOutcome::Rejected);
    assert!(none.content.contains("the user did not respond"));

    harness.prompt.push(Ok(Some(vec!["a".into(), "b".into()])));
    let multi = harness.call(
        "prompt-5",
        TOOL_ASK_USER,
        &args.replace(r#""multi_select":false"#, r#""multi_select":true"#),
    );
    assert_eq!(multi.outcome, ToolOutcome::Action);
}

#[test]
fn write_note_dispatch_reports_actual_create_and_not_atomic_existing() {
    let mut harness = Harness::built_in();
    fs::write(harness.vault.path().join("Name.md"), "old").unwrap();
    harness.call(
        "activate",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );

    let created = harness.call(
        "write-1",
        TOOL_WRITE_NOTE,
        r#"{"rel_path":"Name.md","content":"new","kind":"literature","work_item":0}"#,
    );
    assert_eq!(created.outcome, ToolOutcome::Action);
    assert!(created.content.contains("Name 2.md"));
    assert!(harness.events().iter().any(|event| matches!(
        event,
        ChatEvent::NoteWritten { rel_path, .. } if rel_path == "Name 2.md"
    )));

    let written_before = harness
        .events()
        .iter()
        .filter(|event| matches!(event, ChatEvent::NoteWritten { .. }))
        .count();
    let existing = harness.call(
        "write-2",
        TOOL_WRITE_NOTE,
        r#"{"rel_path":"Name.md","content":"ignored","kind":"atomic","work_item":0}"#,
    );
    assert!(existing.content.contains(r#""existed":true"#));
    let written_after = harness
        .events()
        .iter()
        .filter(|event| matches!(event, ChatEvent::NoteWritten { .. }))
        .count();
    assert_eq!(written_after, written_before);
}

#[test]
fn write_note_rejects_policy_failures_without_emitting_a_written_event() {
    let mut harness = Harness::built_in();
    harness.call(
        "activate",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );

    let result = harness.call(
        "write-outside-budget",
        TOOL_WRITE_NOTE,
        r#"{"rel_path":"Rejected.md","content":"never written","kind":"atomic","work_item":1}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    let content: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    let error = content["error"].as_str().unwrap();
    assert!(error.starts_with("write_note failed:"));
    assert!(error.contains("work item 1 is outside this run's 1 work items"));
    assert!(!harness.vault.path().join("Rejected.md").exists());
    assert!(!harness
        .events()
        .iter()
        .any(|event| matches!(event, ChatEvent::NoteWritten { .. })));
}

#[test]
fn catalogue_schema_is_base_only_until_skill_tools_are_granted() {
    let mut harness = Harness::built_in();
    let before = harness.allowed();
    assert!(before.contains(TOOL_USE_SKILL));
    assert!(!before.contains(TOOL_WRITE_NOTE));

    harness.call(
        "activate",
        TOOL_USE_SKILL,
        &format!(r#"{{"id":"{FIXTURE_SKILL_ID}"}}"#),
    );
    let after = harness.allowed();
    assert!(after.contains(TOOL_WRITE_NOTE));
    assert!(after.contains(TOOL_ASK_USER));
    assert!(after.contains(TOOL_SKILL_STEP));
}
