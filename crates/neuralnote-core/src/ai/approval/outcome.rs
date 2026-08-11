//! What the gate decides, the vocabulary it says it in, and the token that proves
//! a decision was made.

use crate::ai::approval::gated::GatedTool;
use crate::ai::approval::subject::HardDeny;
use crate::ai::llm::ToolCall;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// How long an approval prompt stays live before it resolves itself.
///
/// Shorter than the elicitation path's 300s on purpose: a security sheet sitting
/// for five minutes is stale consent. Rust is the only expiry authority — no
/// paused state is serialised, so the run stays a live future parked on a
/// channel and an approval cannot survive a restart, which is correct rather than
/// a limitation.
pub const APPROVAL_TIMEOUT_SECS: u32 = 120;

/// Why the user is being asked. A closed enum, never free text: the prompt's copy
/// is compiled in on both sides, so a security question's wording can never be
/// model-authored (`ask_user` lets the model write its own question text, which
/// is exactly why approvals do not reuse it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ApprovalReason {
    /// The mode is "ask me", where everything is asked.
    ModeAlwaysAsk,
    /// Approve-for-me: this operation cannot be taken back, so it stays on the
    /// unconditional-ask list the judge cannot override.
    Irreversible,
    /// Approve-for-me: this is not the kind of call that may ever run unattended.
    NotEligible,
    /// The judge answered "ask".
    JudgeAsked,
    /// The judge errored, timed out, or returned something unparseable.
    JudgeUnavailable,
    /// The active provider cannot run the judge, so the mode falls back to asking.
    ProviderUnsupported,
    /// The same subject was already declined once in this run.
    PreviouslyDenied,
}

/// How an approval settled.
///
/// A deliberate departure from `Elicit`, which emits no follow-up because
/// presentation state is client-side. For a security prompt that is wrong: a
/// timeout or a window close must be visible, or the UI leaves a security sheet
/// on screen that silently no-ops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ApprovalResolution {
    Approved,
    Denied,
    TimedOut,
    Cancelled,
    /// The judge could not be reached, so the user was asked instead — emitted
    /// *before* the prompt, so the timeline explains the pause.
    Unavailable,
}

/// Why automatic checking stopped for the rest of a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ApprovalDegradedReason {
    /// The active provider cannot run the judge (§9.5.2). Emitted once per run,
    /// not once per call.
    ProviderUnsupported,
    /// Two consecutive judge failures in one run.
    JudgeUnreliable,
}

/// The user's answer to an approval prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalAnswer {
    Approved,
    Denied,
    /// The prompt expired.
    TimedOut,
    /// The window closed or the run was stopped.
    Cancelled,
}

impl ApprovalAnswer {
    /// Cancel, timeout, and close all resolve to deny. Only an explicit yes runs.
    pub const fn approves(self) -> bool {
        matches!(self, Self::Approved)
    }

    pub const fn resolution(self) -> ApprovalResolution {
        match self {
            Self::Approved => ApprovalResolution::Approved,
            Self::Denied => ApprovalResolution::Denied,
            Self::TimedOut => ApprovalResolution::TimedOut,
            Self::Cancelled => ApprovalResolution::Cancelled,
        }
    }
}

/// A call that has been through the gate.
///
/// `dispatch` takes one of these, so **"no call reaches execution without a
/// decision" is a compile error to violate** rather than a convention. There are
/// exactly two constructors: [`ApprovedCall::ungated`], which provably cannot
/// authorise a gated tool, and a private one only
/// [`decide`](crate::ai::approval::decide) can reach.
///
/// The invariant survives `Yolo` intact: under YOLO the decision is simply an
/// immediate yes, but it is still a decision, and it is still the only way to
/// build this value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovedCall {
    call_id: String,
    name: String,
    arguments: String,
    /// `None` for a tool the gate does not cover.
    gated: Option<GatedTool>,
}

impl ApprovedCall {
    /// A call whose tool is **not** in the gated set needs no approval decision,
    /// so it may be built directly. Returns `None` for every [`GatedTool`] — this
    /// constructor provably cannot authorise a gated call, which is what keeps
    /// [`decide`](crate::ai::approval::decide) the single door for everything the
    /// gate covers.
    pub fn ungated(call: &ToolCall) -> Option<Self> {
        if GatedTool::from_name(&call.name).is_some() {
            return None;
        }
        Some(Self {
            call_id: call.id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
            gated: None,
        })
    }

    /// The private constructor. Reachable only from inside `ai::approval`.
    pub(in crate::ai::approval) fn granted(call: &ToolCall, tool: GatedTool) -> Self {
        Self {
            call_id: call.id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
            gated: Some(tool),
        }
    }

    pub fn call_id(&self) -> &str {
        &self.call_id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn arguments(&self) -> &str {
        &self.arguments
    }

    /// The gated tool this authorises, or `None` when the tool is not gated.
    pub fn gated_tool(&self) -> Option<GatedTool> {
        self.gated
    }
}

/// The gate's verdict for one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalDecision {
    /// Run it.
    Approved(ApprovedCall),
    /// The gate asked and did not get a yes. **Not a run-cancellation**: one
    /// result per declared call must still be pushed, and the remaining calls
    /// stay gated.
    ///
    /// It carries **which** non-yes it was, rather than collapsing them, because
    /// the caller renders it: a timeout and a closed window are not the user
    /// saying no, and telling them they refused something they never saw is the
    /// one account that is definitely wrong. The payload is never
    /// [`ApprovalResolution::Approved`] (that is the `Approved` arm) and never
    /// [`ApprovalResolution::Unavailable`] (which precedes a prompt rather than
    /// settling one).
    Denied(ApprovalResolution),
    /// Refused without asking — a vault escape, an invalid path, or arguments
    /// that never parsed. Becomes a `reject()` tool result the model reads and
    /// recovers from.
    HardDenied(HardDeny),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str) -> ToolCall {
        ToolCall {
            id: "call-1".into(),
            name: name.into(),
            arguments: "{}".into(),
        }
    }

    #[test]
    fn the_ungated_constructor_refuses_every_gated_tool() {
        for tool in crate::ai::approval::gated::ALL_GATED_TOOLS {
            assert_eq!(
                ApprovedCall::ungated(&call(tool.name())),
                None,
                "{} must not be constructible without a decision",
                tool.name()
            );
        }
    }

    #[test]
    fn the_ungated_constructor_accepts_the_read_only_tools() {
        for name in [
            "list_notes",
            "list_folders",
            "search_notes",
            "read_note_span",
            "skill_step",
            "ask_user",
        ] {
            let approved = ApprovedCall::ungated(&call(name)).expect("not gated");
            assert_eq!(approved.name(), name);
            assert_eq!(approved.call_id(), "call-1");
            assert_eq!(approved.arguments(), "{}");
            assert_eq!(approved.gated_tool(), None);
        }
    }

    #[test]
    fn an_unregistered_tool_name_is_ungated_so_dispatch_can_reject_it() {
        // The model can invent a name. That call is rejected by the dispatcher
        // with a message it reads — it must not be stopped at the gate, which
        // would replace a recoverable tool error with a security prompt.
        assert!(ApprovedCall::ungated(&call("definitely_not_a_tool")).is_some());
    }

    #[test]
    fn every_non_approval_answer_denies() {
        assert!(ApprovalAnswer::Approved.approves());
        for answer in [
            ApprovalAnswer::Denied,
            ApprovalAnswer::TimedOut,
            ApprovalAnswer::Cancelled,
        ] {
            assert!(!answer.approves(), "{answer:?} must not approve");
        }
    }

    #[test]
    fn answers_map_onto_the_wire_resolutions() {
        assert_eq!(
            ApprovalAnswer::Approved.resolution(),
            ApprovalResolution::Approved
        );
        assert_eq!(
            ApprovalAnswer::Denied.resolution(),
            ApprovalResolution::Denied
        );
        assert_eq!(
            ApprovalAnswer::TimedOut.resolution(),
            ApprovalResolution::TimedOut
        );
        assert_eq!(
            ApprovalAnswer::Cancelled.resolution(),
            ApprovalResolution::Cancelled
        );
    }

    #[test]
    fn the_approval_timeout_is_shorter_than_the_elicitation_one() {
        // 120s, not the elicitation path's 300s: a security sheet sitting for five
        // minutes is stale consent.
        assert_eq!(APPROVAL_TIMEOUT_SECS, 120);
    }

    #[test]
    fn the_wire_vocabulary_serialises_as_camel_case() {
        assert_eq!(
            serde_json::to_value(ApprovalReason::ProviderUnsupported).unwrap(),
            "providerUnsupported"
        );
        assert_eq!(
            serde_json::to_value(ApprovalResolution::TimedOut).unwrap(),
            "timedOut"
        );
        assert_eq!(
            serde_json::to_value(ApprovalDegradedReason::JudgeUnreliable).unwrap(),
            "judgeUnreliable"
        );
    }
}
