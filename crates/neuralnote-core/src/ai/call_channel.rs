//! One dispatched tool call's slice of the event channel.

use crate::ai::events::{ChatEvent, EventSink};

/// The sink a running tool emits through, carried together with the id of the
/// call doing the emitting.
///
/// The two travel together because neither is right without the other:
/// [`ChatEvent::ToolProgress`] renders on the [`ChatEvent::ToolCall`] node it
/// names, so progress sent with someone else's id lands on someone else's row,
/// and progress sent with no id has no row at all. Handing a tool the raw sink
/// left that correlation to whichever string happened to be in scope.
///
/// There is deliberately no general `send`. One existed briefly and gave the
/// type away: a method taking the whole [`ChatEvent`] union lets a caller pass
/// `ToolProgress { id: <anything> }` and reproduce exactly the mis-keyed
/// progress this type exists to prevent. Each event a tool needs gets its own
/// named method instead, so the wrong id is unwritable rather than merely
/// unwritten.
pub(super) struct CallChannel<'a> {
    sink: &'a mut dyn EventSink,
    call_id: &'a str,
}

impl<'a> CallChannel<'a> {
    pub(super) fn new(sink: &'a mut dyn EventSink, call_id: &'a str) -> Self {
        Self { sink, call_id }
    }

    /// Say what this call is doing while it does it. Repeatable, and
    /// last-writer-wins at the consumer — so the line worth leaving standing is
    /// the one to send last.
    ///
    /// Reach for it before anything that can take real time — a network call, a
    /// retry, a subprocess — because a wait nobody narrated is indistinguishable
    /// from a hang. The message is composed in Rust at the call site, never model
    /// prose, the same rule [`ChatEvent::ToolCall`]'s `title` follows.
    pub(super) fn progress(&mut self, message: impl Into<String>) {
        self.sink.send(ChatEvent::ToolProgress {
            id: self.call_id.to_string(),
            message: message.into(),
        });
    }

    /// The video this run is about to work on.
    ///
    /// Unkeyed on purpose — the card attaches to the run's live head rather than
    /// to one timeline node — and it must follow the round beacon announcing its
    /// item. See [`ChatEvent::VideoPreview`].
    pub(super) fn video_preview(&mut self, preview: ChatEvent) {
        debug_assert!(
            matches!(preview, ChatEvent::VideoPreview { .. }),
            "video_preview carries only a VideoPreview"
        );
        self.sink.send(preview);
    }

    /// How a transcript was actually obtained, from the tool that obtained it.
    /// No note exists at this point, hence no `rel_path`.
    pub(super) fn transcript_source(&mut self, label: impl Into<String>) {
        self.sink.send(ChatEvent::TranscriptSource {
            label: label.into(),
            rel_path: None,
        });
    }
}
