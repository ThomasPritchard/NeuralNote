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
/// `Denied` is produced by the tool-approval gate — a user refusal, a timeout, a
/// cancel, or a closed window — which is what makes it distinguishable from an
/// orchestrator rejection. A call the gate refuses WITHOUT asking (a vault
/// escape, an invalid path) settles as `Rejected` instead: that is validation,
/// not a decision the user made.
///
/// `Error` still has no producer, on purpose. It arrives when `ToolOutcome` gains
/// a discriminant for "the tool ran and failed"; today every failure — malformed
/// arguments and runtime failure alike — is one `ToolOutcome::Rejected`, so
/// reporting `Error` would be a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ToolStatus {
    Ok,
    Error,
    Denied,
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
    /// The backend accepted the run and is preparing the first model request.
    Processing,
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
    Searching { query: String },
    /// `query` finished, yielding `hit_count` evidence spans.
    Retrieved { query: String, hit_count: u32 },
    /// A bounded line range of a note is being read into evidence.
    Reading {
        rel_path: String,
        start_line: u32,
        end_line: u32,
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
    /// A fatal, user-facing error ended the run.
    Error { message: String },
    /// The run completed successfully.
    Done,
}

/// Where [`ChatEvent`]s go. The host app implements this over a Tauri channel;
/// tests implement it over a `Vec`. `Send` so the orchestrator's future stays
/// `Send` (it can then run on the host's worker pool). `send` is infallible by
/// design — an event stream must not fail mid-run.
pub trait EventSink: Send {
    fn send(&mut self, event: ChatEvent);
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
                query: "widgets".into()
            })["type"],
            "searching"
        );
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
    fn tool_status_serialises_as_camel_case_over_all_four_states() {
        for (status, expected) in [
            (ToolStatus::Ok, "ok"),
            (ToolStatus::Error, "error"),
            (ToolStatus::Denied, "denied"),
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
            }),
            serde_json::json!({
                "type": "toolCall",
                "id": "call-1",
                "name": "search_notes",
                "title": "Search notes",
                "arguments": r#"{"query":"x"}"#,
            })
        );
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
            }),
            serde_json::json!({
                "type": "toolResult",
                "id": "call-1",
                "status": "rejected",
                "summary": null,
                "detail": "unknown tool 'nope'",
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
