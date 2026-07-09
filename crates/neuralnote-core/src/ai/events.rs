//! The `ChatEvent` protocol — the Rust → UI contract for a chat run.
//!
//! A serde-tagged enum streamed over an [`EventSink`]. The tag is `type` and both
//! the tag values and every field are `camelCase`, matching the repo's event/IPC
//! convention (mirror the shape in `app/desktop/src/lib/types.ts`). The UI renders
//! the sequence as live steps: search → read → verify → cited answer.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

    fn json(event: &ChatEvent) -> serde_json::Value {
        serde_json::to_value(event).unwrap()
    }

    #[test]
    fn tags_events_by_type_in_camel_case() {
        assert_eq!(json(&ChatEvent::Done)["type"], "done");
        assert_eq!(json(&ChatEvent::Verifying)["type"], "verifying");
        assert_eq!(
            json(&ChatEvent::Searching {
                query: "widgets".into()
            })["type"],
            "searching"
        );
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
}
