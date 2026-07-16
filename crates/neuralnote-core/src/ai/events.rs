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
    /// A create-only skill write succeeded at the actual collision-safe path.
    NoteWritten { rel_path: String, kind: NoteKind },
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
