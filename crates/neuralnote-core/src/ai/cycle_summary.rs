//! Selection and validation for the administrative `skill_step` call.
//!
//! The model returns this call in the same completed batch as real work. This
//! module inspects that frozen batch in provider order, chooses at most one
//! bounded plain-text summary, and builds deterministic tool results. None of
//! the model-authored text participates in authorization or dispatch.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ai::activity_journal::CycleSummarySource;
use crate::ai::llm::ToolCall;
use crate::ai::tool_registry::{RegisteredTool, TOOL_SKILL_STEP};

const MAX_SUMMARY_SCALARS: usize = 320;
const MAX_PROTOCOL_ISSUES: usize = 8;
const GENERIC_FALLBACK: &str = "Continuing with the next step.";

/// Bounded, non-sensitive diagnostics for malformed administrative calls.
///
/// These variants never contain raw arguments, parser errors, provider ids, or
/// model prose. An arbitrary batch can therefore create only a small fixed
/// payload and cannot smuggle vault content into a diagnostic surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum CycleSummaryProtocolIssue {
    MalformedArguments,
    EmptyMessage,
    MultipleParagraphs,
    ControlCharacter,
    TooLong,
    Duplicate,
    Late,
    Missing,
    Additional { count: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SelectedCycleSummary {
    pub(super) source: CycleSummarySource,
    pub(super) message: String,
    pub(super) protocol_issues: Vec<CycleSummaryProtocolIssue>,
}

/// How one declared `skill_step` call should be answered in model history.
/// Administrative calls never enter the visible tool lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SkillStepDisposition {
    Accepted,
    Invalid,
    Duplicate,
    IgnoredNoWork,
}

impl SkillStepDisposition {
    pub(super) fn tool_result(self) -> String {
        match self {
            Self::Accepted => serde_json::json!({
                "ok": true,
                "status": "accepted"
            }),
            Self::Invalid => serde_json::json!({
                "ok": false,
                "status": "invalid",
                "error": "skill_step arguments did not satisfy the summary contract"
            }),
            Self::Duplicate => serde_json::json!({
                "ok": true,
                "status": "duplicate",
                "message": "the first valid skill_step was retained"
            }),
            Self::IgnoredNoWork => serde_json::json!({
                "ok": true,
                "status": "ignored",
                "message": "no real work accompanied this skill_step"
            }),
        }
        .to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CycleSummaryDecision {
    pub(super) summary: Option<SelectedCycleSummary>,
    /// One entry per provider call. `None` means the call is real work.
    pub(super) dispositions: Vec<Option<SkillStepDisposition>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillStepArgs {
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InvalidMessage {
    MalformedArguments,
    EmptyMessage,
    MultipleParagraphs,
    ControlCharacter,
    TooLong,
}

impl From<InvalidMessage> for CycleSummaryProtocolIssue {
    fn from(value: InvalidMessage) -> Self {
        match value {
            InvalidMessage::MalformedArguments => Self::MalformedArguments,
            InvalidMessage::EmptyMessage => Self::EmptyMessage,
            InvalidMessage::MultipleParagraphs => Self::MultipleParagraphs,
            InvalidMessage::ControlCharacter => Self::ControlCharacter,
            InvalidMessage::TooLong => Self::TooLong,
        }
    }
}

/// Inspect one completed provider batch without dispatching anything.
pub(super) fn select_cycle_summary(calls: &[ToolCall]) -> CycleSummaryDecision {
    let has_real_work = calls.iter().any(|call| call.name != TOOL_SKILL_STEP);
    let mut dispositions = vec![None; calls.len()];

    if !has_real_work {
        for (index, call) in calls.iter().enumerate() {
            if call.name == TOOL_SKILL_STEP {
                dispositions[index] = Some(if parse_message(&call.arguments).is_ok() {
                    SkillStepDisposition::IgnoredNoWork
                } else {
                    SkillStepDisposition::Invalid
                });
            }
        }
        return CycleSummaryDecision {
            summary: None,
            dispositions,
        };
    }

    let mut issues = BoundedIssues::default();
    let mut accepted = None;
    let mut saw_real_work = false;
    let mut saw_skill_step = false;

    for (index, call) in calls.iter().enumerate() {
        if call.name != TOOL_SKILL_STEP {
            saw_real_work = true;
            continue;
        }
        saw_skill_step = true;
        if saw_real_work {
            issues.push(CycleSummaryProtocolIssue::Late);
        }
        match parse_message(&call.arguments) {
            Ok(message) if accepted.is_none() => {
                accepted = Some(message);
                dispositions[index] = Some(SkillStepDisposition::Accepted);
            }
            Ok(_) => {
                issues.push(CycleSummaryProtocolIssue::Duplicate);
                dispositions[index] = Some(SkillStepDisposition::Duplicate);
            }
            Err(error) => {
                issues.push(error.into());
                dispositions[index] = Some(SkillStepDisposition::Invalid);
            }
        }
    }

    if !saw_skill_step {
        issues.push(CycleSummaryProtocolIssue::Missing);
    }

    let protocol_issues = issues.finish();
    let (source, message) = match accepted {
        Some(message) => (CycleSummarySource::Model, message),
        None => {
            let first_real = calls.iter().find(|call| call.name != TOOL_SKILL_STEP);
            let fallback = first_real
                .and_then(|call| RegisteredTool::from_name(&call.name))
                .and_then(RegisteredTool::fallback_summary)
                .unwrap_or(GENERIC_FALLBACK);
            (CycleSummarySource::Fallback, fallback.to_string())
        }
    };

    CycleSummaryDecision {
        summary: Some(SelectedCycleSummary {
            source,
            message,
            protocol_issues,
        }),
        dispositions,
    }
}

fn parse_message(arguments: &str) -> Result<String, InvalidMessage> {
    let args: SkillStepArgs =
        serde_json::from_str(arguments).map_err(|_| InvalidMessage::MalformedArguments)?;
    normalize_message(&args.message)
}

fn normalize_message(message: &str) -> Result<String, InvalidMessage> {
    if message
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
    {
        return Err(InvalidMessage::ControlCharacter);
    }

    let canonical = message.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = canonical.trim();
    if trimmed.is_empty() {
        return Err(InvalidMessage::EmptyMessage);
    }
    if trimmed.lines().any(|line| line.trim().is_empty()) {
        return Err(InvalidMessage::MultipleParagraphs);
    }

    let normalized = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() > MAX_SUMMARY_SCALARS {
        return Err(InvalidMessage::TooLong);
    }
    Ok(normalized)
}

#[derive(Default)]
struct BoundedIssues {
    issues: Vec<CycleSummaryProtocolIssue>,
    additional: u32,
}

impl BoundedIssues {
    fn push(&mut self, issue: CycleSummaryProtocolIssue) {
        if self.issues.len() < MAX_PROTOCOL_ISSUES {
            self.issues.push(issue);
        } else {
            self.additional = self.additional.saturating_add(1);
        }
    }

    fn finish(mut self) -> Vec<CycleSummaryProtocolIssue> {
        if self.additional > 0 {
            self.issues.push(CycleSummaryProtocolIssue::Additional {
                count: self.additional,
            });
        }
        self.issues
    }
}
