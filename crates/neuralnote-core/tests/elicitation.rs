use async_trait::async_trait;
use futures::executor::block_on;
use neuralnote_core::ai::{
    elicit_user, ChatEvent, ElicitOption, Elicitation, ElicitationOutcome, EventSink, UserPrompt,
};
use neuralnote_core::{CoreError, CoreResult};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct SharedSink(Arc<Mutex<Vec<ChatEvent>>>);

impl EventSink for SharedSink {
    fn send(&mut self, event: ChatEvent) {
        self.0.lock().unwrap().push(event);
    }
}

struct ScriptedPrompt {
    answer: CoreResult<Option<Vec<String>>>,
    seen: Arc<Mutex<Vec<Elicitation>>>,
    events: Arc<Mutex<Vec<ChatEvent>>>,
}

struct UnexpectedPrompt;

#[async_trait]
impl UserPrompt for UnexpectedPrompt {
    async fn ask(&self, _elicitation: Elicitation) -> CoreResult<Option<Vec<String>>> {
        panic!("invalid offered options must be rejected before prompting")
    }
}

#[async_trait]
impl UserPrompt for ScriptedPrompt {
    async fn ask(&self, elicitation: Elicitation) -> CoreResult<Option<Vec<String>>> {
        assert!(
            self.events.lock().unwrap().iter().any(
                |event| matches!(event, ChatEvent::Elicit { id, .. } if id == &elicitation.id)
            ),
            "Elicit must be emitted before UserPrompt::ask is awaited"
        );
        self.seen.lock().unwrap().push(elicitation);
        self.answer.clone()
    }
}

fn option(id: &str, label: &str) -> ElicitOption {
    ElicitOption {
        id: id.into(),
        label: label.into(),
        description: Some(format!("description for {label}")),
        image_data_uri: Some(format!("data:image/png;base64,{id}")),
    }
}

fn elicitation(multi_select: bool) -> Elicitation {
    Elicitation {
        id: "prompt-1".into(),
        question: "Choose".into(),
        options: vec![option("a", "Alpha"), option("b", "Beta")],
        multi_select,
    }
}

fn run(answer: CoreResult<Option<Vec<String>>>, multi_select: bool) -> ElicitationOutcome {
    let mut sink = SharedSink::default();
    let prompt = ScriptedPrompt {
        answer,
        seen: Arc::new(Mutex::new(Vec::new())),
        events: sink.0.clone(),
    };

    block_on(elicit_user(&prompt, &mut sink, elicitation(multi_select)))
}

#[test]
fn answered_single_select_emits_before_awaiting_and_returns_one_id() {
    assert_eq!(
        run(Ok(Some(vec!["a".into()])), false),
        ElicitationOutcome::Answered {
            chosen_ids: vec!["a".into()]
        }
    );
}

#[test]
fn answered_multi_select_returns_every_chosen_id() {
    assert_eq!(
        run(Ok(Some(vec!["a".into(), "b".into()])), true),
        ElicitationOutcome::Answered {
            chosen_ids: vec!["a".into(), "b".into()]
        }
    );
}

#[test]
fn single_select_rejects_zero_or_multiple_answers() {
    for choices in [Vec::new(), vec!["a".into(), "b".into()]] {
        assert!(matches!(
            run(Ok(Some(choices)), false),
            ElicitationOutcome::Rejected { error } if error.contains("exactly one")
        ));
    }
}

#[test]
fn unknown_option_id_is_rejected() {
    assert!(matches!(
        run(Ok(Some(vec!["not-offered".into()])), false),
        ElicitationOutcome::Rejected { error } if error.contains("not an offered option")
    ));
}

#[test]
fn no_response_is_a_total_error_outcome() {
    assert_eq!(
        run(Ok(None), false),
        ElicitationOutcome::Rejected {
            error: "the user did not respond".into()
        }
    );
}

#[test]
fn prompt_seam_failure_is_a_total_error_outcome() {
    assert!(matches!(
        run(Err(CoreError::Io("prompt channel closed".into())), false),
        ElicitationOutcome::Rejected { error } if error.contains("prompt channel closed")
    ));
}

#[test]
fn implementation_authored_options_never_enter_model_facing_content() {
    let outcome = run(Ok(Some(vec!["b".into()])), false);
    let content = outcome.tool_result_content();

    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&content).unwrap(),
        serde_json::json!({ "chosen_ids": ["b"] })
    );
    for implementation_only in ["Alpha", "Beta", "description", "data:image"] {
        assert!(!content.contains(implementation_only));
    }
}

#[test]
fn blank_and_duplicate_offered_ids_are_rejected_before_emitting_or_prompting() {
    for options in [
        vec![option(" ", "Blank")],
        vec![option("same", "First"), option("same", "Second")],
    ] {
        let mut sink = SharedSink::default();
        let outcome = block_on(elicit_user(
            &UnexpectedPrompt,
            &mut sink,
            Elicitation {
                id: "invalid".into(),
                question: "Choose".into(),
                options,
                multi_select: false,
            },
        ));

        assert!(matches!(outcome, ElicitationOutcome::Rejected { .. }));
        assert!(sink.0.lock().unwrap().is_empty());
    }
}
