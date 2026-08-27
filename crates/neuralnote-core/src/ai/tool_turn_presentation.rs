//! Bounded presentation ordering for a streamed tool-deciding turn.
//!
//! Thinking and liveness continue to the user immediately. Semantic note
//! previews are coalesced by provider call id until the completed batch can be
//! inspected and its cycle summary emitted. This buffer changes presentation
//! order only; it never edits the provider completion or message history.

use std::collections::{BTreeMap, BTreeSet};

use crate::ai::events::{ChatEvent, EventSink, TokenUsage};
use crate::ai::llm::ToolCall;
use crate::ai::tool_registry::TOOL_SKILL_STEP;

/// A completed preview whose correlated tool did not deliver a note.
pub(super) const ABANDONED_NOT_COMMITTED: &str =
    "the note was not written, so this preview was not committed";

#[derive(Debug, Default)]
pub(super) struct ToolTurnPresentation {
    previews: BTreeMap<String, ChatEvent>,
}

impl ToolTurnPresentation {
    pub(super) fn sink<'a>(
        &'a mut self,
        inner: &'a mut dyn EventSink,
    ) -> ToolTurnPresentationSink<'a> {
        ToolTurnPresentationSink {
            presentation: self,
            inner,
        }
    }

    /// Publish one latest semantic preview per real call in provider-call order.
    pub(super) fn flush(
        &mut self,
        calls: &[ToolCall],
        sink: &mut dyn EventSink,
    ) -> BTreeSet<String> {
        let mut flushed = BTreeSet::new();
        for call in calls {
            if call.name == TOOL_SKILL_STEP {
                continue;
            }
            if let Some(preview) = self.previews.remove(&call.id) {
                sink.send(preview);
                flushed.insert(call.id.clone());
            }
        }
        // A preview without a matching completed call was never authoritative
        // enough to display. It is discarded, not guessed onto a nearby call.
        self.previews.clear();
        flushed
    }

    /// Drop an attempt that failed before any buffered preview became visible.
    pub(super) fn discard(&mut self) {
        self.previews.clear();
    }
}

pub(super) struct ToolTurnPresentationSink<'a> {
    presentation: &'a mut ToolTurnPresentation,
    inner: &'a mut dyn EventSink,
}

impl EventSink for ToolTurnPresentationSink<'_> {
    fn send(&mut self, event: ChatEvent) {
        if let ChatEvent::NoteEditPreview { id, .. } = &event {
            let id = id.clone();
            self.presentation.previews.insert(id, event);
            return;
        }
        if let ChatEvent::NoteEditAbandoned { id, .. } = &event {
            // The corresponding preview is still private to this buffer, so
            // removing it is the complete presentation outcome. Publishing an
            // abandonment for a card the user never saw would invent UI.
            self.presentation.previews.remove(id);
            return;
        }
        self.inner.send(event);
    }

    fn begin_final_answer(&mut self) {
        self.inner.begin_final_answer();
    }

    fn record_usage(&mut self, usage: Option<TokenUsage>) {
        self.inner.record_usage(usage);
    }
}
