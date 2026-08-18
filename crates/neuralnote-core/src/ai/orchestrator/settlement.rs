//! Timeline settlement: one story for the model and one for the user, never two
//! that disagree.

use crate::ai::approval::ApprovalResolution;
use crate::ai::events::{ChatEvent, EventSink, ToolStatus};
use crate::ai::llm::{LlmMessage, ToolCall};
use crate::ai::plan::RunPlan;
use crate::ai::tool_registry;
use crate::ai::tools::{self, ToolOutcome};
use std::time::Instant;

/// Bound on the `detail` text crossing the event wire. A tool result can be a
/// whole transcript; the disclosure is a peek at one, not a copy of it.
const MAX_TOOL_DETAIL_CHARS: usize = 600;

/// The [`ChatEvent::ToolResult`] payload for one settled call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ToolSettlement {
    status: ToolStatus,
    summary: Option<String>,
    detail: Option<String>,
}

impl ToolSettlement {
    pub(super) fn status(&self) -> ToolStatus {
        self.status
    }
}

/// Why a declared call never reached the dispatcher. Closed on purpose: each
/// variant both answers the model and settles the timeline node, so a new
/// short-circuit cannot be added that leaves a node spinning forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SkippedCall {
    StalePlaylistBatch,
    PlaylistCancelled,
    EvidenceBudgetSpent,
}

impl SkippedCall {
    /// The `role:"tool"` content the model reads. The protocol still needs a
    /// result for every declared call, so the model is told the call was skipped
    /// rather than left waiting on one that never comes.
    const fn tool_result_content(self) -> &'static str {
        match self {
            Self::StalePlaylistBatch => {
                r#"{"error":{"kind":"stale_playlist_batch","message":"skipped: the playlist work item for this assistant batch has already resolved"}}"#
            }
            Self::PlaylistCancelled => {
                r#"{"error":{"kind":"capture_cancelled","message":"skipped: playlist capture was cancelled before this call"}}"#
            }
            Self::EvidenceBudgetSpent => r#"{"error":"skipped: evidence budget reached"}"#,
        }
    }

    /// The same story in the user's words, for the timeline node.
    const fn reason(self) -> &'static str {
        match self {
            Self::StalePlaylistBatch => "skipped: this playlist item had already finished",
            Self::PlaylistCancelled => "skipped: the run was stopped before this call ran",
            Self::EvidenceBudgetSpent => "skipped: the run reached its evidence budget",
        }
    }

    fn settlement(self) -> ToolSettlement {
        ToolSettlement {
            // The call never ran, so this is the orchestrator declining it — not a
            // tool failure and not a user denial.
            status: ToolStatus::Rejected,
            summary: None,
            detail: Some(self.reason().to_string()),
        }
    }
}

/// A declared call the approval gate refused.
///
/// Like [`SkippedCall`], each variant both answers the model and settles the
/// timeline node, so a refusal can never leave a node spinning forever. And like
/// a skip, a refusal is **not** run-cancellation: one result is still pushed for
/// this call, and the rest of the batch stays gated. Ending the turn on a denial
/// is the tempting shortcut and it breaks the protocol invariant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RefusedCall {
    /// The gate asked and did not get a yes, carrying **which** kind of no it
    /// was. Deliberately not collapsed: "the user declined" is a claim about a
    /// person, and it is false for a prompt that expired unanswered or a window
    /// that closed. The gate distinguishes these on the wire already; this is the
    /// step that used to throw the distinction away.
    Denied(ApprovalResolution),
    /// Refused without asking: a vault escape, an invalid path, arguments that
    /// never parsed, or a subject the user has already declined twice. Validation
    /// and confinement, not authorisation — so this happens in every mode,
    /// `Yolo` included.
    HardDenied(String),
}

impl RefusedCall {
    /// The `role:"tool"` content the model reads and recovers from.
    ///
    /// The three refusals read differently to the model too, and that is not
    /// cosmetic: "the user declined" invites a reworded retry aimed at changing
    /// their mind, while "nobody answered" and "the session ended" do not.
    pub(super) fn tool_result_content(&self) -> String {
        let message = match self {
            Self::Denied(resolution) => Self::refusal_message(*resolution),
            Self::HardDenied(detail) => detail,
        };
        serde_json::json!({ "error": message }).to_string()
    }

    /// The same story in the user's words, for the timeline node. `Denied` (the
    /// user refused) and `Rejected` (the orchestrator refused) are different
    /// stories and must render differently — and so are the three refusals.
    pub(super) fn settlement(&self) -> ToolSettlement {
        match self {
            Self::Denied(resolution) => ToolSettlement {
                status: Self::refusal_status(*resolution),
                summary: None,
                detail: Some(Self::refusal_detail(*resolution).to_string()),
            },
            Self::HardDenied(detail) => ToolSettlement {
                status: ToolStatus::Rejected,
                summary: None,
                detail: Some(detail.clone()),
            },
        }
    }

    /// Exhaustive, no wildcard arm, so a new [`ApprovalResolution`] has to be
    /// classified here before it compiles. `Approved` and `Unavailable` cannot
    /// reach a refusal — the first is the other decision, the second precedes a
    /// prompt rather than settling one — so they fall to the most conservative
    /// status rather than being waved through.
    const fn refusal_status(resolution: ApprovalResolution) -> ToolStatus {
        match resolution {
            ApprovalResolution::Denied => ToolStatus::Denied,
            ApprovalResolution::TimedOut => ToolStatus::TimedOut,
            ApprovalResolution::Cancelled => ToolStatus::Cancelled,
            ApprovalResolution::Approved | ApprovalResolution::Unavailable => ToolStatus::Denied,
        }
    }

    /// The user-facing sentence. All three end by saying nothing was written,
    /// because that is the fact the user most needs and it holds in every case.
    const fn refusal_detail(resolution: ApprovalResolution) -> &'static str {
        match resolution {
            ApprovalResolution::TimedOut => "The request expired unanswered. Nothing was written.",
            ApprovalResolution::Cancelled => {
                "The run ended before this was answered. Nothing was written."
            }
            ApprovalResolution::Denied
            | ApprovalResolution::Approved
            | ApprovalResolution::Unavailable => "Denied. Nothing was written.",
        }
    }

    /// The model-facing sentence, composed in Rust from the resolution — never
    /// model prose echoed back.
    const fn refusal_message(resolution: ApprovalResolution) -> &'static str {
        match resolution {
            ApprovalResolution::TimedOut => {
                "the approval request expired without an answer, so it did not run"
            }
            ApprovalResolution::Cancelled => {
                "the session ended before this was approved, so it did not run"
            }
            ApprovalResolution::Denied
            | ApprovalResolution::Approved
            | ApprovalResolution::Unavailable => "the user declined this action, so it did not run",
        }
    }
}

/// Answer the model and settle the timeline node for a call that never ran — in
/// one place, so the two accounts can never drift apart.
pub(super) fn settle_skipped(
    messages: &mut Vec<LlmMessage>,
    sink: &mut dyn EventSink,
    dispatched: &Dispatched,
    skipped: SkippedCall,
) {
    let call = dispatched.call;
    messages.push(LlmMessage::tool_result(
        &call.id,
        &call.name,
        skipped.tool_result_content(),
    ));
    emit_tool_result(sink, dispatched, skipped.settlement());
}

/// Announce a declared call before anything can go wrong with it. The title comes
/// from the Rust-side table in [`tool_registry`] — never from the model, and never
/// composed by the UI.
///
/// The step affiliation is read off `plan` **here**, at dispatch, because that is
/// when it is true. Resolving it later — at render, or from the plan's final state
/// — would re-parent nodes every time a step moved.
pub(super) fn emit_tool_call<'a>(
    sink: &mut dyn EventSink,
    call: &'a ToolCall,
    plan: &RunPlan,
) -> Dispatched<'a> {
    sink.send(ChatEvent::ToolCall {
        id: call.id.clone(),
        name: call.name.clone(),
        title: tool_registry::title_for(&call.name).to_string(),
        arguments: call.arguments.clone(),
        step_id: plan.running_step_id().map(str::to_string),
    });
    Dispatched {
        call,
        at: Instant::now(),
    }
}

/// A call that has been announced: which call it was, and when.
///
/// Returned by [`emit_tool_call`] and required by every settlement helper, which
/// buys two invariants for one parameter. The settling event can only carry the
/// id of the call that was actually dispatched — "exactly one `ToolResult` per
/// `ToolCall`, correlated on `id`" stops depending on two call sites passing the
/// same string. And `duration_ms` can only ever measure dispatch → settlement,
/// never whichever clock happened to be in scope.
///
/// Reading a monotonic clock is a measurement, not a timer: the core still owns
/// no waiting.
#[must_use = "a dispatched call must be settled, and its settlement needs this"]
pub(super) struct Dispatched<'a> {
    call: &'a ToolCall,
    at: Instant,
}

impl Dispatched<'_> {
    /// Milliseconds since dispatch, saturating rather than wrapping. A run long
    /// enough to overflow `u64` milliseconds cannot happen, but a silent wrap
    /// would report a fast call, which is the one reading that would mislead.
    fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.at.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

pub(super) fn emit_tool_result(
    sink: &mut dyn EventSink,
    dispatched: &Dispatched,
    settlement: ToolSettlement,
) {
    sink.send(ChatEvent::ToolResult {
        id: dispatched.call.id.clone(),
        status: settlement.status,
        summary: settlement.summary,
        detail: settlement.detail,
        duration_ms: dispatched.elapsed_ms(),
    });
}

/// Why the active playlist item cannot continue, if this call is what ended it.
///
/// Both a refusal and a failure stop the item — a capture that never ran and one
/// that ran and came apart leave the item equally unable to proceed. But the
/// recorded reason is read back to the user in the run summary, so it has to
/// tell the true story rather than calling every non-delivery a rejection (#116).
///
/// Exhaustive, no wildcard arm: a new [`ToolOutcome`] must decide here whether
/// it ends the item before it compiles.
pub(super) fn playlist_failure_reason(outcome: &ToolOutcome, tool: &str) -> Option<String> {
    match outcome {
        ToolOutcome::Rejected => Some(format!("tool '{tool}' was rejected")),
        ToolOutcome::Failed { message } => Some(format!("tool '{tool}' failed: {message}")),
        // A run the user stopped does not FAIL its work item, and recording it
        // as failed would advance past the item and stamp the false story into
        // the run summary the user reads back. The cancellation path already
        // owns this: `cancel_playlist_remaining` marks this item and every one
        // behind it `Cancelled`, from the batch loop on the next call or from
        // `playlist_preflight` on the next turn.
        ToolOutcome::Cancelled
        | ToolOutcome::Listed
        | ToolOutcome::Searched { .. }
        | ToolOutcome::Read { .. }
        | ToolOutcome::Action => None,
    }
}

/// Read a dispatched result in the timeline's vocabulary. Every summary here is
/// composed from the structured [`ToolOutcome`], never from model prose.
pub(super) fn settlement_for(result: &tools::ToolResult) -> ToolSettlement {
    let (status, summary) = match &result.outcome {
        ToolOutcome::Searched { hit_count, .. } => {
            (ToolStatus::Ok, Some(format!("{hit_count} spans")))
        }
        ToolOutcome::Read {
            rel_path,
            start_line,
            end_line,
        } => (
            ToolStatus::Ok,
            Some(format!("{rel_path}:{start_line}–{end_line}")),
        ),
        ToolOutcome::Listed | ToolOutcome::Action => (ToolStatus::Ok, None),
        // The two refusals-that-are-not are kept apart here and nowhere else:
        // `Rejected` says the system protected the user, `Error` says something
        // broke (#116). A summary would only repeat the disclosure below.
        ToolOutcome::Rejected => (ToolStatus::Rejected, None),
        ToolOutcome::Failed { .. } => (ToolStatus::Error, None),
        // …and the third, which is neither: the run ended under the call. The
        // status already exists and already renders as "run ended first"; it
        // simply had no producer on this path until one could tell a user's Stop
        // from a vault that broke.
        ToolOutcome::Cancelled => (ToolStatus::Cancelled, None),
    };
    ToolSettlement {
        status,
        summary,
        detail: disclosure(&result.content),
    }
}

/// The bounded disclosure text for a settled call. A rejection's own sentence
/// reads better than the JSON envelope the model receives, so unwrap it when it
/// is there. Absent detail stays absent rather than becoming a blank line.
fn disclosure(content: &str) -> Option<String> {
    let text = serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|value| value.get("error")?.as_str().map(str::to_string))
        .unwrap_or_else(|| content.to_string());
    let bounded = truncate_chars(text.trim(), MAX_TOOL_DETAIL_CHARS);
    (!bounded.is_empty()).then_some(bounded)
}

/// Truncate on a char boundary, so a multi-byte character is never split.
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod settlement_tests {
    use super::*;
    use crate::ai::events::VecSink;
    use std::collections::BTreeSet;

    fn call(name: &str) -> ToolCall {
        ToolCall {
            id: "c1".into(),
            name: name.into(),
            arguments: "{}".into(),
        }
    }

    #[test]
    fn a_timeout_is_not_reported_as_a_user_denial() {
        // THE regression this split exists for. All three refusals mean the call
        // did not run, and exactly one of them means a person decided that. The
        // UI reads the status, so a timeout that arrives as `Denied` renders as
        // "denied by you" to a user who never saw the sheet.
        //
        // What goes red: make `refusal_status` return `ToolStatus::Denied` for
        // every resolution — the shape this shipped in — and all three
        // assertions below fail at once.
        let expected = [
            (ApprovalResolution::Denied, ToolStatus::Denied),
            (ApprovalResolution::TimedOut, ToolStatus::TimedOut),
            (ApprovalResolution::Cancelled, ToolStatus::Cancelled),
        ];
        for (resolution, status) in expected {
            assert_eq!(
                RefusedCall::Denied(resolution).settlement().status,
                status,
                "{resolution:?} settled as the wrong status"
            );
        }
        // Distinct in the user's words and in the model's, not only in the enum:
        // an identical sentence under three statuses would leave the timeline
        // saying "Denied" beneath a `timedOut` glyph.
        let details: BTreeSet<String> = expected
            .iter()
            .map(|(resolution, _)| {
                RefusedCall::Denied(*resolution)
                    .settlement()
                    .detail
                    .expect("a refusal always explains itself")
            })
            .collect();
        assert_eq!(
            details.len(),
            3,
            "two refusals tell the user the same story"
        );
        let messages: BTreeSet<String> = expected
            .iter()
            .map(|(resolution, _)| RefusedCall::Denied(*resolution).tool_result_content())
            .collect();
        assert_eq!(
            messages.len(),
            3,
            "two refusals tell the model the same story"
        );
        // Only the genuine refusal may blame the user. The other two must not,
        // because the model reads this and a false "the user declined" invites a
        // retry aimed at changing a mind that was never made up.
        for resolution in [ApprovalResolution::TimedOut, ApprovalResolution::Cancelled] {
            let message = RefusedCall::Denied(resolution).tool_result_content();
            assert!(!message.contains("declined"), "{resolution:?}: {message}");
        }
    }

    #[test]
    fn a_refusal_never_claims_something_was_written() {
        // The one fact that holds across every refusal, stated once so a future
        // reworded sentence cannot quietly drop it.
        for resolution in [
            ApprovalResolution::Denied,
            ApprovalResolution::TimedOut,
            ApprovalResolution::Cancelled,
        ] {
            let detail = RefusedCall::Denied(resolution)
                .settlement()
                .detail
                .expect("a refusal always explains itself");
            assert!(detail.contains("Nothing was written"), "{detail}");
        }
    }

    #[test]
    fn every_skipped_call_both_answers_the_model_and_settles_the_node() {
        // The two accounts must never drift: the model is told the call was
        // skipped, and the node stops spinning. Both, for every reason.
        for skipped in [
            SkippedCall::StalePlaylistBatch,
            SkippedCall::PlaylistCancelled,
            SkippedCall::EvidenceBudgetSpent,
        ] {
            let mut messages = Vec::new();
            let mut sink = VecSink::default();
            let call = call("search_notes");
            let dispatched = Dispatched {
                call: &call,
                at: Instant::now(),
            };

            settle_skipped(&mut messages, &mut sink, &dispatched, skipped);

            assert_eq!(messages.len(), 1, "the model needs one result per call");
            assert!(messages[0]
                .content
                .as_deref()
                .expect("a tool result always carries content")
                .contains("skipped"));
            // Matched field by field rather than compared whole: `duration_ms` is a
            // real measurement, so pinning it to a number would be asserting the
            // speed of the test machine.
            let [ChatEvent::ToolResult {
                id,
                status,
                summary,
                detail,
                duration_ms: _,
            }] = sink.events.as_slice()
            else {
                panic!(
                    "a skipped call settles its node exactly once: {:?}",
                    sink.events
                );
            };
            assert_eq!(id, "c1");
            assert_eq!(*status, ToolStatus::Rejected);
            assert_eq!(*summary, None);
            assert_eq!(detail.as_deref(), Some(skipped.reason()));
        }
    }

    #[test]
    fn a_skipped_reason_never_repeats_across_causes() {
        // Three different stories — "already finished", "stopped", "out of
        // budget" — must read differently, or the node explains nothing.
        let reasons = [
            SkippedCall::StalePlaylistBatch.reason(),
            SkippedCall::PlaylistCancelled.reason(),
            SkippedCall::EvidenceBudgetSpent.reason(),
        ];
        let distinct: std::collections::BTreeSet<&str> = reasons.into_iter().collect();
        assert_eq!(distinct.len(), reasons.len());
    }

    #[test]
    fn a_search_settles_with_its_span_count_and_a_read_with_its_range() {
        let searched = settlement_for(&tools::ToolResult {
            content: r#"{"query":"x"}"#.into(),
            outcome: ToolOutcome::Searched {
                query: "x".into(),
                hit_count: 12,
                truncated: false,
                skipped_files: 0,
                notes_read: Vec::new(),
            },
            control: tools::ToolControl::Continue,
        });
        assert_eq!(searched.status, ToolStatus::Ok);
        assert_eq!(searched.summary, Some("12 spans".into()));

        let read = settlement_for(&tools::ToolResult {
            content: "{}".into(),
            outcome: ToolOutcome::Read {
                rel_path: "Notes/A.md".into(),
                start_line: 12,
                end_line: 28,
            },
            control: tools::ToolControl::Continue,
        });
        assert_eq!(read.summary, Some("Notes/A.md:12–28".into()));
    }

    #[test]
    fn a_rejection_discloses_its_own_sentence_not_the_json_envelope() {
        let settlement = settlement_for(&tools::ToolResult {
            content: r#"{"error":"unknown tool 'nope'"}"#.into(),
            outcome: ToolOutcome::Rejected,
            control: tools::ToolControl::Continue,
        });

        assert_eq!(settlement.status, ToolStatus::Rejected);
        assert_eq!(settlement.detail, Some("unknown tool 'nope'".into()));
    }

    #[test]
    fn a_failed_call_settles_as_an_error_and_still_discloses_its_reason() {
        let settlement = settlement_for(&tools::ToolResult {
            content: r#"{"error":"search failed: io error: the volume disappeared"}"#.into(),
            outcome: ToolOutcome::Failed {
                message: "search failed: io error: the volume disappeared".into(),
            },
            control: tools::ToolControl::Continue,
        });

        assert_eq!(settlement.status, ToolStatus::Error);
        assert_eq!(
            settlement.detail,
            Some("search failed: io error: the volume disappeared".into())
        );
    }

    #[test]
    fn a_playlist_item_records_why_it_stopped_not_merely_that_it_did() {
        // Both stories end the item — a capture that never ran and one that ran
        // and came apart leave it equally unable to proceed. But the reason is
        // read back to the user in the run summary, so calling every
        // non-delivery a rejection buries the actual cause (#116).
        let refused = playlist_failure_reason(&ToolOutcome::Rejected, "fetch_captions")
            .expect("a refusal ends the item");
        let failed = playlist_failure_reason(
            &ToolOutcome::Failed {
                message: "Sign in to confirm you're not a bot".into(),
            },
            "fetch_captions",
        )
        .expect("a failure ends the item too");

        assert!(refused.contains("rejected"), "{refused}");
        assert!(
            failed.contains("Sign in to confirm you're not a bot"),
            "the item must record what actually went wrong: {failed}"
        );
        assert_ne!(refused, failed);
        // A call that delivered leaves the item running.
        assert_eq!(
            playlist_failure_reason(&ToolOutcome::Action, "write_note"),
            None
        );
    }

    #[test]
    fn a_disclosure_is_bounded_and_never_splits_a_character() {
        // A tool result can be a whole transcript. The disclosure is a peek.
        let long = "é".repeat(MAX_TOOL_DETAIL_CHARS + 50);
        let bounded = disclosure(&long).expect("long content still discloses");

        assert_eq!(bounded.chars().count(), MAX_TOOL_DETAIL_CHARS + 1);
        assert!(bounded.ends_with('…'));
        assert!(bounded.starts_with('é'), "a multi-byte char must survive");
    }

    #[test]
    fn empty_content_discloses_nothing_rather_than_a_blank_line() {
        assert_eq!(disclosure(""), None);
        assert_eq!(disclosure("   "), None);
    }
}
