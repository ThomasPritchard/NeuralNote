//! The `ChatEvent` protocol — the Rust → UI contract for a chat run.
//!
//! A serde-tagged enum streamed over an [`EventSink`]. The tag is `type` and both
//! the tag values and every field are `camelCase`, matching the repo's event/IPC
//! convention (mirror the shape in `app/desktop/src/lib/types.ts`). The UI renders
//! the sequence as live steps: search → read → verify → cited answer.
//!
//! Model-authored image payloads are rejected by the tool dispatcher. Trusted
//! implementation-authored thumbnails are decoded and bounded before they cross
//! this event boundary; the webview CSP remains a second line of defence.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ai::approval::{
    ApprovalDegradedReason, ApprovalReason, ApprovalResolution, ApprovalRule, GatedTool,
};
use crate::ai::plan::{PlanStep, StepStatus};
use crate::ai::write_policy::NoteKind;

/// One selectable answer shown by an [`Elicitation`]. Images stay data URIs so a
/// webview never needs a third-party network allowlist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ElicitOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    // Populated only by implementation-owned paths after image validation.
    pub image_data_uri: Option<String>,
}

/// A structured question the core asks through the host-provided prompt seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Elicitation {
    pub id: String,
    pub question: String,
    pub options: Vec<ElicitOption>,
    pub multi_select: bool,
}

/// How a dispatched tool call settled. Mirrors [`crate::ai::tools::ToolOutcome`]'s
/// discriminant but is the UI-facing vocabulary: `Rejected` (bad args/path — the
/// orchestrator refused) and `Denied` (the user refused) are different stories and
/// must render differently.
///
/// The three ways the approval gate can settle a call it ASKED about are three
/// separate statuses — `Denied`, `TimedOut`, `Cancelled` — and the split is the
/// point. All three mean "the call did not run", but they attribute it to three
/// different parties: the user said no, nobody answered inside 120s, or the run
/// went away underneath the question. Folding them into `Denied` tells a user who
/// never saw the sheet that they refused something, which is the one account that
/// is definitely false. `ApprovalResolution` already distinguishes them on the
/// wire — §9.2 says it exists precisely so a timeout or a window close is visible
/// — so collapsing here threw the distinction away at the last step.
///
/// A call the gate refuses WITHOUT asking (a vault escape, an invalid path)
/// settles as `Rejected` instead: that is validation, not a decision anyone made.
///
/// `ApprovalResolution::Unavailable` has no counterpart here and needs none: it is
/// emitted *before* a prompt, to explain the pause, and is always followed by one
/// of the three above.
///
/// What goes red if these are re-collapsed:
/// `a_timeout_is_not_reported_as_a_user_denial`, in `orchestrator.rs`'s
/// `settlement_tests`, which is where the mapping from `ApprovalResolution` to
/// this enum actually lives.
///
/// `Error` is produced by `ToolOutcome::Failed` — a call that reached the vault,
/// the network, or the extractor and came apart there (#116). It used to have no
/// producer, because `ToolOutcome` could not tell that apart from a call the
/// dispatcher refused; both arrived as one `Rejected`, and the timeline told the
/// user NeuralNote had declined work it had in fact attempted.
///
/// The dividing line is whether anything was tried. Malformed arguments, an
/// unknown or unauthorised tool, a path outside the vault, a URL outside the
/// playlist the user picked: all `Rejected`, because the system protected the
/// user and nothing is broken. Everything past that point is `Error`.
///
/// What goes red if they are re-collapsed:
/// `a_malformed_argument_call_is_refused_and_never_collapses_into_a_failure`,
/// in `orchestrator.rs`'s `tests`, which asserts the two settle differently in
/// one run rather than merely asserting each in isolation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ToolStatus {
    Ok,
    Error,
    /// The user was asked and said no.
    Denied,
    /// The user was asked and the prompt expired unanswered.
    TimedOut,
    /// The user was asked and the run ended — window closed, or stopped — before
    /// an answer could be honoured.
    Cancelled,
    Rejected,
}

/// One event in a chat run's stream. Emitted in causal order; a run ends with
/// either [`ChatEvent::Done`] (success) or [`ChatEvent::Error`] (surfaced failure)
/// — never silently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ChatEvent {
    /// The run has been accepted and is preparing its first model request.
    ///
    /// Emitted AT MOST ONCE per run, at the top of the orchestrator — never
    /// twice, and not at all when setting up the write session fails, which
    /// surfaces [`ChatEvent::Error`] and returns before this point. The per-round
    /// beacon is [`ChatEvent::PlanningRound`], which carries a round number and
    /// therefore cannot reset the phase backwards the way a repeated `Processing`
    /// did.
    Processing,
    /// A tool-deciding round-trip is starting. Emitted once per round, before the
    /// model request goes out, through the raw sink and before the retry guard in
    /// `orchestrator::collect` wraps it — counting it would disable the one
    /// bounded retry that turn is allowed.
    ///
    /// It replaces the per-round `Processing` that used to keep the phase word
    /// from going stale during a turn that can take fifteen seconds and emits
    /// nothing else (#126); unlike `Processing` it says *which* round, so a
    /// repeat cannot read as a fresh start.
    PlanningRound {
        /// 1-based. The first tool-deciding turn is round 1.
        round: u32,
        /// The ceiling as computed for THIS round.
        ///
        /// Re-read every emission and it CAN GROW mid-run: activating a skill
        /// raises the ceiling ([`ActiveSkills::max_iterations`](crate::ai::skills::ActiveSkills::max_iterations)
        /// folds each active skill's declared cap over the base). The UI must
        /// render the latest pair and never cache the denominator.
        max_rounds: u32,
    },
    /// The provider is alive and has sent nothing else. Forwarded from an SSE
    /// comment line (OpenRouter sends `: OPENROUTER PROCESSING`), which the
    /// stream classifier used to resolve to "ignorable" and drop.
    ///
    /// Carries no payload on purpose: it says "the socket is alive", not
    /// "progress happened". It refreshes the transport-liveness signal and must
    /// NOT reset a stall detector, which watches for progress.
    Keepalive,
    /// A long-running tool reporting from inside itself, keyed to the
    /// [`ChatEvent::ToolCall`] it belongs to so it renders on that node rather
    /// than on a separate surface.
    ///
    /// `message` is Rust-composed, never model prose — the same rule
    /// [`ChatEvent::ToolCall`]'s `title` follows. Repeatable; the UI shows the
    /// latest.
    ToolProgress {
        /// The [`ChatEvent::ToolCall`] id.
        id: String,
        message: String,
    },
    /// A skill became active and granted its declared tools.
    SkillActivated { id: String, name: String },
    /// A user-facing progress update emitted by an active skill.
    SkillStep { message: String },
    /// A structured question is ready for the host to present. Answered or dormant
    /// presentation state is tracked client-side; no follow-up wire event is emitted.
    Elicit {
        id: String,
        question: String,
        options: Vec<ElicitOption>,
        multi_select: bool,
    },
    /// A skill the user asked for could not be activated. `missing_binary` is the
    /// only structured remedy the UI offers, so it is the only structured field;
    /// it is derived from the skill's requirement set, never parsed back out of
    /// `message` (a wording change must not silently disable the remedy).
    SkillActivationFailed {
        id: String,
        name: String,
        /// The human sentence, for display only — no longer load-bearing.
        message: String,
        missing_binary: Option<String>,
    },
    /// The model requested a tool call. Emitted BEFORE dispatch, so a call that is
    /// rejected, denied, fails, or is cancelled still appears on the timeline
    /// rather than vanishing. Exactly one [`ChatEvent::ToolResult`] follows it.
    ToolCall {
        /// The provider's call id — the correlation key for every later event.
        id: String,
        /// The registered tool name (one of the `TOOL_*` constants in `ai/tools.rs`).
        name: String,
        /// A human label from the Rust-side table in [`crate::ai::tool_registry`].
        /// NEVER model prose — that is the coupling this event exists to kill.
        title: String,
        /// The raw arguments JSON exactly as the model emitted it. The UI parses it
        /// defensively for the detail line; it is never trusted to be valid JSON.
        arguments: String,
        /// The [`ChatEvent::Plan`] step that was [`StepStatus::Running`] at the
        /// moment this call was DISPATCHED — the key the timeline nests tool
        /// nodes under their step by.
        ///
        /// Stamped at dispatch, never resolved at render: the affiliation is a
        /// fact about when the call happened, so a later
        /// [`ChatEvent::PlanStepStatus`] must not re-parent a node that already
        /// went out. That is also why the `update_plan` call which declares the
        /// plan is itself unaffiliated — it was dispatched before the plan
        /// existed.
        ///
        /// `None` is ordinary, not a failure: no plan was declared (the common
        /// case), or no step is running right now. It is never a synthetic step,
        /// and never an empty string — an unaffiliated node renders on the rail
        /// exactly as it did before plans existed.
        ///
        /// It plays **no part in settlement**: a [`ChatEvent::ToolResult`]
        /// correlates on `id` alone, and carries no step of its own.
        step_id: Option<String>,
    },
    /// The call settled. Exactly one per [`ChatEvent::ToolCall`], always emitted —
    /// including on rejection and cancellation, so no node is left spinning forever.
    ToolResult {
        id: String,
        status: ToolStatus,
        /// A Rust-composed one-liner ("12 spans"), never model prose.
        summary: Option<String>,
        /// Bounded result or error text for the disclosure. Truncated Rust-side.
        detail: Option<String>,
        /// Wall-clock time from dispatch to settlement. Measured with `Instant`,
        /// which the core already treats as a measurement rather than a timer.
        /// Never optional: the orchestrator always knows how long it waited, and
        /// a call that never ran waited approximately nothing rather than an
        /// unknown amount.
        ///
        /// **It is time-to-settle, not time-in-the-tool.** The approval gate sits
        /// between dispatch and settlement, so a gated call the user leaves
        /// sitting reports the human's thinking time too — up to the gate's
        /// 120-second budget. Anything rendering this beside a tool name has to
        /// say "took", never "spent working".
        duration_ms: u64,
    },
    /// How a transcript was actually obtained, reported by the tool that obtained
    /// it — so provenance is read off the wire, never scraped out of model prose.
    TranscriptSource {
        label: String,
        rel_path: Option<String>,
    },
    /// The run ended having completed only part of its work. The orchestrator knows
    /// this authoritatively (cancellation, evidence/iteration guards), so the UI
    /// never has to infer it from an answer that merely mentions "cancelled".
    PartialRun { reason: String },
    /// A create-only skill write succeeded at the actual collision-safe path.
    NoteWritten { rel_path: String, kind: NoteKind },
    /// A create-only write hit an existing note and wrote nothing (#108). Without
    /// it the no-op is invisible, which the "failures are never silent" rule forbids.
    NoteExists { rel_path: String, kind: NoteKind },
    /// A best-effort, partially-parsed view of a note the model is still
    /// composing. Rust owns the partial-JSON parse and emits a SEMANTIC preview,
    /// so the UI never sees half a JSON blob and never has to know the body
    /// arrived inside an escaped string.
    ///
    /// Emitted only for tools on [`crate::ai::tool_stream::PREVIEWABLE_TOOLS`] —
    /// arbitrary tool arguments are model-authored and not safe to render as prose.
    NoteEditPreview {
        /// The [`ChatEvent::ToolCall`] id, so the card upgrades in place into
        /// [`ChatEvent::NoteWritten`] rather than becoming a second node.
        id: String,
        /// Absent until the path member has finished arriving — half a path must
        /// never be shown as if it were the whole path.
        rel_path: Option<String>,
        kind: Option<NoteKind>,
        /// The note body composed SO FAR, already un-escaped.
        body: String,
        /// The arguments JSON has closed and parses. **The write has NOT happened
        /// yet** — the tool still has to be dispatched, and can still be rejected.
        complete: bool,
    },
    /// The preview is abandoned: the model never finished the call, the run was
    /// cancelled, or the arguments never became valid JSON. Exactly one of these
    /// follows any preview that does not go on to be written, so a half-composed
    /// diff is never left sitting there looking committed.
    NoteEditAbandoned { id: String, reason: String },
    /// The approval gate has asked the judge about a gated call and is waiting.
    /// Only `ApproveForMe` reaches this state; the other two modes go straight to
    /// their outcome. It must never be terminal — it resolves within the judge's
    /// budget, or *because* of it.
    ToolApprovalChecking { id: String },
    /// A gated call needs the user's decision before it can run.
    ToolApprovalRequested {
        /// The [`ChatEvent::ToolCall`] id, so the sheet attaches to that node.
        id: String,
        tool: GatedTool,
        /// The vault-relative path, **for the human**. Deliberately absent from
        /// the judge's input: a person can read a deceptive filename and is the
        /// right party to judge it; a classifier cannot.
        rel_path: Option<String>,
        /// A compiled-in reason, never free text and never model prose.
        reason: ApprovalReason,
        expires_in_secs: u32,
    },
    /// A gated call ran without asking, under a compiled-in rule.
    ///
    /// Emitted in **every** mode that auto-approves, YOLO included: the user can
    /// always see what ran unattended and on what authority. A skipped prompt
    /// that leaves no trace is the failure this event exists to prevent.
    ToolAutoApproved {
        id: String,
        tool: GatedTool,
        rule: ApprovalRule,
    },
    /// How an approval settled. Unlike [`ChatEvent::Elicit`], which emits no
    /// follow-up because presentation state is client-side, a security prompt
    /// must report its own end — otherwise a timeout or a window close leaves a
    /// security sheet on screen that silently no-ops.
    ToolApprovalResolved {
        id: String,
        decision: ApprovalResolution,
    },
    /// Automatic checking is off for the rest of this turn. Emitted once per run,
    /// not once per call.
    ToolApprovalDegraded { reason: ApprovalDegradedReason },
    /// A search is about to run for `query` (the live "searching…" cue).
    Searching {
        query: String,
        /// The [`ChatEvent::ToolCall`] that ran it — see [`ChatEvent::Retrieved`].
        call_id: Option<String>,
    },
    /// `query` finished, yielding `hit_count` evidence spans.
    ///
    /// `call_id` is the correlation key for all three retrieval cues. These cues
    /// are emitted BY the tool calls above them on the rail, so the timeline can
    /// enrich the tool node in place rather than render the same act twice. It
    /// does not do so yet — today the rail drops these cues — and this key is
    /// what makes that possible without guessing: tool calls run in parallel, so
    /// arrival order is not a correlation key, and inferring one from it would
    /// put the wrong query on the wrong node.
    ///
    /// `Option`, not `String`: the cues come from the retrieval layer and a path
    /// may have no dispatched call behind it. `None` means "no node to attach
    /// to" and renders exactly as it did before the key existed.
    Retrieved {
        query: String,
        hit_count: u32,
        call_id: Option<String>,
    },
    /// A bounded line range of a note is being read into evidence.
    Reading {
        rel_path: String,
        start_line: u32,
        end_line: u32,
        /// The [`ChatEvent::ToolCall`] that read it — see [`ChatEvent::Retrieved`].
        call_id: Option<String>,
    },
    /// Optional model reasoning tokens (surfaced only if the client streams them).
    Thinking { delta: String },
    /// The citation-verification phase has begun.
    Verifying,
    /// A candidate citation failed verification and was dropped (with the reason,
    /// so the drop is never silent).
    CitationDropped { reason: String },
    /// A chunk of the streamed final answer text.
    Answer { delta: String },
    /// The provider stopped at its output-token ceiling (`finish_reason: "length"`):
    /// the streamed answer is cut short, NOT complete. Surfaced so a truncated answer
    /// is never presented as whole. Moat-safe: a citation marker severed mid-token is
    /// already dropped by the verifier (an incomplete `[eN]` never parses), so this
    /// flags incompleteness without ever risking a wrong citation.
    AnswerTruncated,
    /// A verified citation backing the answer. `id` is the evidence handle the
    /// model cited; the rest locates and quotes the source.
    Citation {
        id: String,
        rel_path: String,
        start_line: u32,
        end_line: u32,
        text: String,
    },
    /// The coverage footer: what was searched/read and whether search limits
    /// clipped anything — so partial coverage is visible, never hidden.
    Coverage {
        searched_terms: Vec<String>,
        notes_read: Vec<String>,
        truncated: bool,
        skipped_files: u32,
    },
    /// The model declared the steps it intends to take, before acting on them.
    /// Emitted at most once per run: [`crate::ai::plan::RunPlan`] refuses a second
    /// declaration, so the UI never has to re-parent nodes already affiliated
    /// with a step id.
    ///
    /// Every declared step starts [`StepStatus::Pending`]; only departures from
    /// that arrive as [`ChatEvent::PlanStepStatus`].
    Plan { steps: Vec<PlanStep> },
    /// A declared step moved. `id` is the step's own id from [`ChatEvent::Plan`].
    PlanStepStatus { id: String, status: StepStatus },
    /// What the run cost. Emitted exactly once, immediately before whichever
    /// event ends the run — [`ChatEvent::Done`], or [`ChatEvent::Error`] when the
    /// run failed. A failed run still spent tokens, so it still reports them.
    ///
    /// The token counts are `Option` because a provider may report none — the
    /// local (Ollama) lane reports nothing unless asked, and a client that has
    /// not been taught to meter reports nothing at all. **An absent count must
    /// render as absent, never as `0`:** a zero here would read as a real
    /// measurement of a run that cost nothing. They are absent together or
    /// present together, because [`UsageMeter`](crate::ai::orchestrator) only
    /// totals a run in which *every* model call reported — a partial total is a
    /// wrong number, which is worse than no number.
    ///
    /// `elapsed_ms` is never optional: the run's own duration is always known.
    Usage {
        elapsed_ms: u64,
        tokens_in: Option<u32>,
        tokens_out: Option<u32>,
        model: String,
    },
    /// A fatal, user-facing error ended the run.
    Error { message: String },
    /// The run completed successfully.
    Done,
}

/// What one model call cost, as the provider reported it.
///
/// Deliberately **not** a [`ChatEvent`]: this is metering travelling from the
/// transport back to the orchestrator, not a UI event. The orchestrator totals
/// these and emits the single user-facing [`ChatEvent::Usage`].
///
/// Both counts are required. A provider either reported a usage frame or it did
/// not — [`EventSink::record_usage`] carries that distinction in its `Option`, so
/// there is no third state where half a measurement gets rendered as a whole one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenUsage {
    pub tokens_in: u32,
    pub tokens_out: u32,
}

/// Where [`ChatEvent`]s go. The host app implements this over a Tauri channel;
/// tests implement it over a `Vec`. `Send` so the orchestrator's future stays
/// `Send` (it can then run on the host's worker pool). `send` is infallible by
/// design — an event stream must not fail mid-run.
pub trait EventSink: Send {
    fn send(&mut self, event: ChatEvent);

    /// Report what one model call cost — `None` when the provider said nothing.
    ///
    /// This is the transport's only channel back to the orchestrator besides its
    /// return value, and it carries metering rather than a UI event, which is why
    /// it is a separate method taking a [`TokenUsage`] instead of a
    /// [`ChatEvent::Usage`]. An implementation must call it **once per completed
    /// model call**, passing `None` when the provider reported no usage: that is
    /// what lets the orchestrator tell "nothing reported" apart from "everything
    /// reported and the total is this".
    ///
    /// **The default discards, and that is the honest degradation.** A sink that
    /// does not meter — and a wrapper sink that forgets to forward — costs the
    /// footer its token counts, which then render as *absent*. It can never
    /// produce a wrong number, only no number. Every wrapper sink in this crate
    /// forwards; `usage_survives_the_whole_sink_stack` in `orchestrator.rs` is
    /// the test that proves the real stack still does.
    fn record_usage(&mut self, _usage: Option<TokenUsage>) {}
}

/// A test [`EventSink`] that collects every event for assertions.
#[cfg(test)]
#[derive(Debug, Default)]
pub struct VecSink {
    pub events: Vec<ChatEvent>,
}

#[cfg(test)]
impl EventSink for VecSink {
    fn send(&mut self, event: ChatEvent) {
        self.events.push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::write_policy::NoteKind;

    fn json(event: &ChatEvent) -> serde_json::Value {
        serde_json::to_value(event).unwrap()
    }

    #[test]
    fn tags_events_by_type_in_camel_case() {
        assert_eq!(json(&ChatEvent::Done)["type"], "done");
        assert_eq!(json(&ChatEvent::Processing)["type"], "processing");
        assert_eq!(json(&ChatEvent::Verifying)["type"], "verifying");
        assert_eq!(
            json(&ChatEvent::Searching {
                query: "widgets".into(),
                call_id: None,
            })["type"],
            "searching"
        );
    }

    #[test]
    fn planning_round_carries_both_numbers_in_camel_case() {
        // The denominator travels with every emission precisely because it can
        // grow mid-run, so the UI never has to remember one.
        let event = ChatEvent::PlanningRound {
            round: 2,
            max_rounds: 12,
        };
        assert_eq!(
            json(&event),
            serde_json::json!({ "type": "planningRound", "round": 2, "maxRounds": 12 })
        );
        assert_eq!(
            serde_json::from_value::<ChatEvent>(json(&event)).unwrap(),
            event
        );
    }

    #[test]
    fn keepalive_is_a_payload_free_camel_case_event() {
        // No payload on purpose: it says the socket is alive, not that progress
        // happened.
        assert_eq!(
            json(&ChatEvent::Keepalive),
            serde_json::json!({ "type": "keepalive" })
        );
    }

    #[test]
    fn tool_progress_is_keyed_to_the_call_it_reports_on() {
        assert_eq!(
            json(&ChatEvent::ToolProgress {
                id: "call-1".into(),
                message: "3 of 8 videos".into(),
            }),
            serde_json::json!({
                "type": "toolProgress",
                "id": "call-1",
                "message": "3 of 8 videos",
            })
        );
    }

    #[test]
    fn a_correlated_retrieval_cue_names_the_call_that_ran_it() {
        let event = ChatEvent::Retrieved {
            query: "widgets".into(),
            hit_count: 3,
            call_id: Some("call-7".into()),
        };
        assert_eq!(json(&event)["callId"], "call-7");
        assert_eq!(
            serde_json::from_value::<ChatEvent>(json(&event)).unwrap(),
            event
        );
    }

    #[test]
    fn an_uncorrelated_retrieval_cue_carries_a_null_call_id_not_an_empty_string() {
        // The degradation guarantee: a cue with no dispatched call behind it says
        // "no node to attach to" explicitly. An empty string would look like a
        // real id and attach the cue to nothing at all.
        for event in [
            ChatEvent::Searching {
                query: "widgets".into(),
                call_id: None,
            },
            ChatEvent::Retrieved {
                query: "widgets".into(),
                hit_count: 0,
                call_id: None,
            },
            ChatEvent::Reading {
                rel_path: "a/b.md".into(),
                start_line: 1,
                end_line: 2,
                call_id: None,
            },
        ] {
            let value = json(&event);
            assert_eq!(value["callId"], serde_json::Value::Null);
            assert_ne!(value["callId"], "");
            assert_eq!(serde_json::from_value::<ChatEvent>(value).unwrap(), event);
        }
    }

    #[test]
    fn answer_truncated_is_a_camel_case_unit_event() {
        // The provider-token-ceiling signal is a distinct, user-visible event — not a
        // silent drop and not conflated with search-coverage truncation.
        assert_eq!(json(&ChatEvent::AnswerTruncated)["type"], "answerTruncated");
    }

    #[test]
    fn renames_fields_to_camel_case() {
        let v = json(&ChatEvent::Reading {
            rel_path: "a/b.md".into(),
            start_line: 3,
            end_line: 5,
            call_id: None,
        });
        assert_eq!(v["relPath"], "a/b.md");
        assert_eq!(v["startLine"], 3);
        assert_eq!(v["endLine"], 5);
    }

    #[test]
    fn coverage_carries_all_footer_fields() {
        let v = json(&ChatEvent::Coverage {
            searched_terms: vec!["a".into(), "b".into()],
            notes_read: vec!["n.md".into()],
            truncated: true,
            skipped_files: 2,
        });
        assert_eq!(v["searchedTerms"], serde_json::json!(["a", "b"]));
        assert_eq!(v["notesRead"], serde_json::json!(["n.md"]));
        assert_eq!(v["truncated"], true);
        assert_eq!(v["skippedFiles"], 2);
    }

    #[test]
    fn citation_round_trips() {
        let event = ChatEvent::Citation {
            id: "e1".into(),
            rel_path: "n.md".into(),
            start_line: 1,
            end_line: 1,
            text: "hello".into(),
        };
        let back: ChatEvent = serde_json::from_value(json(&event)).unwrap();
        assert_eq!(back, event);
    }

    #[test]
    fn vec_sink_collects_in_order() {
        let mut sink = VecSink::default();
        sink.send(ChatEvent::Verifying);
        sink.send(ChatEvent::Done);
        assert_eq!(sink.events, vec![ChatEvent::Verifying, ChatEvent::Done]);
    }

    #[test]
    fn skill_events_use_the_frozen_camel_case_shape() {
        assert_eq!(
            json(&ChatEvent::SkillActivated {
                id: "fixture".into(),
                name: "Fixture skill".into(),
            }),
            serde_json::json!({
                "type": "skillActivated",
                "id": "fixture",
                "name": "Fixture skill",
            })
        );
        assert_eq!(
            json(&ChatEvent::SkillStep {
                message: "Preparing note".into(),
            }),
            serde_json::json!({
                "type": "skillStep",
                "message": "Preparing note",
            })
        );
    }

    #[test]
    fn elicitation_types_use_camel_case_and_preserve_nullable_fields() {
        let option = ElicitOption {
            id: "yes".into(),
            label: "Yes".into(),
            description: None,
            image_data_uri: Some("data:image/png;base64,abc".into()),
        };
        let elicitation = Elicitation {
            id: "prompt-1".into(),
            question: "Continue?".into(),
            options: vec![option.clone()],
            multi_select: false,
        };
        let value = serde_json::to_value(&elicitation).unwrap();

        assert_eq!(value["multiSelect"], false);
        assert_eq!(value["options"][0]["description"], serde_json::Value::Null);
        assert_eq!(
            value["options"][0]["imageDataUri"],
            "data:image/png;base64,abc"
        );

        assert_eq!(
            json(&ChatEvent::Elicit {
                id: elicitation.id,
                question: elicitation.question,
                options: elicitation.options,
                multi_select: elicitation.multi_select,
            }),
            serde_json::json!({
                "type": "elicit",
                "id": "prompt-1",
                "question": "Continue?",
                "options": [{
                    "id": "yes",
                    "label": "Yes",
                    "description": null,
                    "imageDataUri": "data:image/png;base64,abc",
                }],
                "multiSelect": false,
            })
        );
    }

    #[test]
    fn tool_status_serialises_as_camel_case_over_every_state() {
        // The three approval refusals are separate wire values, not one `denied`
        // with different prose: the UI keys its wording off the status, so
        // collapsing them here is what put "denied by you" under a timeout.
        for (status, expected) in [
            (ToolStatus::Ok, "ok"),
            (ToolStatus::Error, "error"),
            (ToolStatus::Denied, "denied"),
            (ToolStatus::TimedOut, "timedOut"),
            (ToolStatus::Cancelled, "cancelled"),
            (ToolStatus::Rejected, "rejected"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), expected);
        }
    }

    #[test]
    fn tool_call_carries_the_correlation_key_title_and_raw_arguments() {
        assert_eq!(
            json(&ChatEvent::ToolCall {
                id: "call-1".into(),
                name: "search_notes".into(),
                title: "Search notes".into(),
                arguments: r#"{"query":"x"}"#.into(),
                step_id: Some("s2".into()),
            }),
            serde_json::json!({
                "type": "toolCall",
                "id": "call-1",
                "name": "search_notes",
                "title": "Search notes",
                "arguments": r#"{"query":"x"}"#,
                "stepId": "s2",
            })
        );
    }

    #[test]
    fn an_unaffiliated_tool_call_keeps_its_step_id_null_rather_than_empty() {
        // No plan, or no step running: the honest answer is "this call belongs to
        // no step". An empty string would render as affiliation with a step whose
        // id is blank, which is a step that does not exist.
        let event = ChatEvent::ToolCall {
            id: "call-1".into(),
            name: "search_notes".into(),
            title: "Search notes".into(),
            arguments: "{}".into(),
            step_id: None,
        };
        let value = json(&event);
        assert_eq!(value["stepId"], serde_json::Value::Null);
        assert_ne!(value["stepId"], "");
        assert_eq!(serde_json::from_value::<ChatEvent>(value).unwrap(), event);
    }

    #[test]
    fn tool_result_keeps_absent_summary_and_detail_null_rather_than_empty() {
        // An absent summary must render as absent, never as an empty string that
        // reads like a real (blank) one-liner.
        assert_eq!(
            json(&ChatEvent::ToolResult {
                id: "call-1".into(),
                status: ToolStatus::Rejected,
                summary: None,
                detail: Some("unknown tool 'nope'".into()),
                duration_ms: 4,
            }),
            serde_json::json!({
                "type": "toolResult",
                "id": "call-1",
                "status": "rejected",
                "summary": null,
                "detail": "unknown tool 'nope'",
                "durationMs": 4,
            })
        );
    }

    #[test]
    fn skill_activation_failed_renames_the_missing_binary_field() {
        let value = json(&ChatEvent::SkillActivationFailed {
            id: "youtube-distil".into(),
            name: "YouTube distil".into(),
            message: "Skill could not be activated".into(),
            missing_binary: Some("yt-dlp".into()),
        });
        assert_eq!(value["type"], "skillActivationFailed");
        assert_eq!(value["missingBinary"], "yt-dlp");
        assert_eq!(
            json(&ChatEvent::SkillActivationFailed {
                id: "x".into(),
                name: "X".into(),
                message: "no".into(),
                missing_binary: None,
            })["missingBinary"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn transcript_source_carries_the_label_and_an_optional_note_path() {
        assert_eq!(
            json(&ChatEvent::TranscriptSource {
                label: "captions:en".into(),
                rel_path: None,
            }),
            serde_json::json!({
                "type": "transcriptSource",
                "label": "captions:en",
                "relPath": null,
            })
        );
    }

    #[test]
    fn partial_run_carries_its_reason() {
        assert_eq!(
            json(&ChatEvent::PartialRun {
                reason: "the run was stopped".into(),
            }),
            serde_json::json!({ "type": "partialRun", "reason": "the run was stopped" })
        );
    }

    #[test]
    fn note_exists_mirrors_note_written_and_round_trips() {
        // #108: a create-only write that hits an existing note used to emit nothing.
        // Its wire shape mirrors `noteWritten` so the UI can pair them.
        let event = ChatEvent::NoteExists {
            rel_path: "Notes/Name.md".into(),
            kind: NoteKind::Atomic,
        };
        assert_eq!(
            json(&event),
            serde_json::json!({
                "type": "noteExists",
                "relPath": "Notes/Name.md",
                "kind": "atomic",
            })
        );
        assert_eq!(
            serde_json::from_value::<ChatEvent>(json(&event)).unwrap(),
            event
        );
    }

    #[test]
    fn note_edit_preview_carries_the_call_id_and_keeps_unknown_fields_null() {
        // The id is the correlation key the card upgrades in place on, and an
        // absent path must serialise as absent — never as an empty string, which
        // would render as a real (blank) destination.
        assert_eq!(
            json(&ChatEvent::NoteEditPreview {
                id: "call-1".into(),
                rel_path: None,
                kind: None,
                body: "# Spaced".into(),
                complete: false,
            }),
            serde_json::json!({
                "type": "noteEditPreview",
                "id": "call-1",
                "relPath": null,
                "kind": null,
                "body": "# Spaced",
                "complete": false,
            })
        );
    }

    #[test]
    fn note_edit_preview_round_trips_a_settled_preview() {
        let event = ChatEvent::NoteEditPreview {
            id: "call-1".into(),
            rel_path: Some("Zettelkasten/Spaced repetition.md".into()),
            kind: Some(NoteKind::Atomic),
            body: "# Spaced Repetition\n\nBody.".into(),
            complete: true,
        };
        let value = json(&event);
        assert_eq!(value["relPath"], "Zettelkasten/Spaced repetition.md");
        assert_eq!(value["kind"], "atomic");
        assert_eq!(value["complete"], true);
        assert_eq!(serde_json::from_value::<ChatEvent>(value).unwrap(), event);
    }

    #[test]
    fn note_edit_abandoned_carries_the_call_id_and_a_reason() {
        let event = ChatEvent::NoteEditAbandoned {
            id: "call-1".into(),
            reason: "the model stopped before it finished composing this note".into(),
        };
        assert_eq!(
            json(&event),
            serde_json::json!({
                "type": "noteEditAbandoned",
                "id": "call-1",
                "reason": "the model stopped before it finished composing this note",
            })
        );
        assert_eq!(
            serde_json::from_value::<ChatEvent>(json(&event)).unwrap(),
            event
        );
    }

    #[test]
    fn the_approval_events_use_the_frozen_camel_case_shape() {
        use crate::ai::approval::{
            ApprovalDegradedReason, ApprovalReason, ApprovalResolution, ApprovalRule, GatedTool,
        };

        assert_eq!(
            json(&ChatEvent::ToolApprovalChecking {
                id: "call-1".into()
            }),
            serde_json::json!({ "type": "toolApprovalChecking", "id": "call-1" })
        );
        assert_eq!(
            json(&ChatEvent::ToolApprovalRequested {
                id: "call-1".into(),
                tool: GatedTool::WriteNote,
                rel_path: Some("Notes/New.md".into()),
                reason: ApprovalReason::ModeAlwaysAsk,
                expires_in_secs: 120,
            }),
            serde_json::json!({
                "type": "toolApprovalRequested",
                "id": "call-1",
                "tool": "writeNote",
                "relPath": "Notes/New.md",
                "reason": "modeAlwaysAsk",
                "expiresInSecs": 120,
            })
        );
        assert_eq!(
            json(&ChatEvent::ToolAutoApproved {
                id: "call-1".into(),
                tool: GatedTool::WriteNote,
                rule: ApprovalRule::Yolo,
            }),
            serde_json::json!({
                "type": "toolAutoApproved",
                "id": "call-1",
                "tool": "writeNote",
                "rule": "yolo",
            })
        );
        assert_eq!(
            json(&ChatEvent::ToolApprovalResolved {
                id: "call-1".into(),
                decision: ApprovalResolution::TimedOut,
            }),
            serde_json::json!({
                "type": "toolApprovalResolved",
                "id": "call-1",
                "decision": "timedOut",
            })
        );
        assert_eq!(
            json(&ChatEvent::ToolApprovalDegraded {
                reason: ApprovalDegradedReason::ProviderUnsupported,
            }),
            serde_json::json!({
                "type": "toolApprovalDegraded",
                "reason": "providerUnsupported",
            })
        );
    }

    #[test]
    fn an_approval_request_with_no_path_keeps_it_null_rather_than_empty() {
        use crate::ai::approval::{ApprovalReason, GatedTool};

        // A network fetch has no vault path. An empty string would render as a
        // real (blank) destination in the security sheet.
        let value = json(&ChatEvent::ToolApprovalRequested {
            id: "call-1".into(),
            tool: GatedTool::FetchCaptions,
            rel_path: None,
            reason: ApprovalReason::Irreversible,
            expires_in_secs: 120,
        });
        assert_eq!(value["relPath"], serde_json::Value::Null);
        assert_eq!(
            serde_json::from_value::<ChatEvent>(value).unwrap(),
            ChatEvent::ToolApprovalRequested {
                id: "call-1".into(),
                tool: GatedTool::FetchCaptions,
                rel_path: None,
                reason: ApprovalReason::Irreversible,
                expires_in_secs: 120,
            }
        );
    }

    #[test]
    fn plan_carries_its_declared_steps_in_the_frozen_camel_case_shape() {
        use crate::ai::plan::PlanStep;

        let event = ChatEvent::Plan {
            steps: vec![
                PlanStep {
                    id: "s1".into(),
                    label: "Search the vault".into(),
                },
                PlanStep {
                    id: "s2".into(),
                    label: "Read the best matches".into(),
                },
            ],
        };
        assert_eq!(
            json(&event),
            serde_json::json!({
                "type": "plan",
                "steps": [
                    { "id": "s1", "label": "Search the vault" },
                    { "id": "s2", "label": "Read the best matches" },
                ],
            })
        );
        assert_eq!(
            serde_json::from_value::<ChatEvent>(json(&event)).unwrap(),
            event
        );
    }

    #[test]
    fn plan_step_status_serialises_every_state_as_camel_case() {
        use crate::ai::plan::StepStatus;

        for (status, expected) in [
            (StepStatus::Pending, "pending"),
            (StepStatus::Running, "running"),
            (StepStatus::Done, "done"),
            (StepStatus::Skipped, "skipped"),
            (StepStatus::Failed, "failed"),
        ] {
            assert_eq!(
                json(&ChatEvent::PlanStepStatus {
                    id: "s1".into(),
                    status,
                }),
                serde_json::json!({
                    "type": "planStepStatus",
                    "id": "s1",
                    "status": expected,
                })
            );
        }
    }

    #[test]
    fn usage_renames_every_field_to_camel_case() {
        let event = ChatEvent::Usage {
            elapsed_ms: 24_100,
            tokens_in: Some(8_412),
            tokens_out: Some(611),
            model: "anthropic/claude-sonnet-4.5".into(),
        };
        assert_eq!(
            json(&event),
            serde_json::json!({
                "type": "usage",
                "elapsedMs": 24_100,
                "tokensIn": 8_412,
                "tokensOut": 611,
                "model": "anthropic/claude-sonnet-4.5",
            })
        );
        assert_eq!(
            serde_json::from_value::<ChatEvent>(json(&event)).unwrap(),
            event
        );
    }

    #[test]
    fn unreported_token_counts_stay_null_and_never_become_zero() {
        // The whole point of the phase: the local lane may report nothing, and a
        // `0` on the wire would render as a real measurement of a run that cost
        // nothing. The elapsed time is still known and still reported.
        let value = json(&ChatEvent::Usage {
            elapsed_ms: 812,
            tokens_in: None,
            tokens_out: None,
            model: "qwen3.5:9b".into(),
        });
        assert_eq!(value["tokensIn"], serde_json::Value::Null);
        assert_eq!(value["tokensOut"], serde_json::Value::Null);
        assert_ne!(value["tokensIn"], 0);
        assert_ne!(value["tokensOut"], 0);
        assert_eq!(value["elapsedMs"], 812);
    }

    #[test]
    fn a_sink_that_does_not_meter_discards_usage_rather_than_failing() {
        // The default `record_usage` is what keeps every existing sink compiling
        // and every unmetered client honest: no number, never a wrong one.
        let mut sink = VecSink::default();
        sink.record_usage(Some(TokenUsage {
            tokens_in: 10,
            tokens_out: 2,
        }));
        sink.record_usage(None);
        assert!(sink.events.is_empty());
    }

    #[test]
    fn note_written_uses_rel_path_and_lowercase_kind() {
        for (kind, expected) in [
            (NoteKind::Literature, "literature"),
            (NoteKind::Atomic, "atomic"),
            (NoteKind::Transcript, "transcript"),
        ] {
            let value = json(&ChatEvent::NoteWritten {
                rel_path: "Notes/Name.md".into(),
                kind,
            });
            assert_eq!(value["type"], "noteWritten");
            assert_eq!(value["relPath"], "Notes/Name.md");
            assert_eq!(value["kind"], expected);
        }
    }
}
