//! Structured user questions shared by model- and implementation-authored tools.

use crate::ai::events::{ChatEvent, Elicitation, EventSink};
use crate::ai::llm::UserPrompt;
use serde_json::json;
use std::collections::BTreeSet;

/// Total result of one elicitation. Dispatch serialises this as a tool result, so
/// prompt-channel failures remain recoverable model context rather than hard errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElicitationOutcome {
    Answered { chosen_ids: Vec<String> },
    Rejected { error: String },
}

impl ElicitationOutcome {
    /// Model-facing JSON. Successful content deliberately contains only chosen ids;
    /// implementation-authored labels, descriptions, and images stay off-context.
    pub fn tool_result_content(&self) -> String {
        match self {
            Self::Answered { chosen_ids } => json!({ "chosen_ids": chosen_ids }).to_string(),
            Self::Rejected { error } => json!({ "error": error }).to_string(),
        }
    }
}

/// Emit a structured question, await the host, and validate the selected ids.
pub async fn elicit_user(
    prompt: &dyn UserPrompt,
    sink: &mut dyn EventSink,
    elicitation: Elicitation,
) -> ElicitationOutcome {
    if elicitation.options.is_empty() {
        return ElicitationOutcome::Rejected {
            error: "elicitation requires at least one offered option".into(),
        };
    }
    let mut offered = BTreeSet::new();
    for option in &elicitation.options {
        if option.id.trim().is_empty() {
            return ElicitationOutcome::Rejected {
                error: "offered option ids cannot be blank".into(),
            };
        }
        if !offered.insert(option.id.as_str()) {
            return ElicitationOutcome::Rejected {
                error: format!("offered option id '{}' is duplicated", option.id),
            };
        }
    }

    sink.send(ChatEvent::Elicit {
        id: elicitation.id.clone(),
        question: elicitation.question.clone(),
        options: elicitation.options.clone(),
        multi_select: elicitation.multi_select,
    });

    let choices = match prompt.ask(elicitation.clone()).await {
        Ok(Some(choices)) => choices,
        Ok(None) => {
            return ElicitationOutcome::Rejected {
                error: "the user did not respond".into(),
            }
        }
        Err(error) => {
            return ElicitationOutcome::Rejected {
                error: format!("could not ask the user: {error}"),
            }
        }
    };

    if !elicitation.multi_select && choices.len() != 1 {
        return ElicitationOutcome::Rejected {
            error: "single-select elicitation requires exactly one chosen option id".into(),
        };
    }

    let mut selected = BTreeSet::new();
    for choice in &choices {
        if !offered.contains(choice.as_str()) {
            return ElicitationOutcome::Rejected {
                error: format!("'{choice}' is not an offered option id"),
            };
        }
        if !selected.insert(choice.as_str()) {
            return ElicitationOutcome::Rejected {
                error: format!("option id '{choice}' was chosen more than once"),
            };
        }
    }

    ElicitationOutcome::Answered {
        chosen_ids: choices,
    }
}
