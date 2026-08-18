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
/// Every message crossing this is composed in Rust at the call site, never model
/// prose — the same rule [`ChatEvent::ToolCall`]'s `title` follows. It is what
/// makes the rail trustworthy: the model cannot narrate work it is not doing.
pub(super) struct CallChannel<'a> {
    sink: &'a mut dyn EventSink,
    call_id: &'a str,
}

impl<'a> CallChannel<'a> {
    pub(super) fn new(sink: &'a mut dyn EventSink, call_id: &'a str) -> Self {
        Self { sink, call_id }
    }

    /// Say what this call is doing while it does it. Repeatable; the UI shows
    /// the latest.
    ///
    /// Reach for it before anything that can take real time — a network call, a
    /// retry, a subprocess — because a wait nobody narrated is indistinguishable
    /// from a hang.
    pub(super) fn progress(&mut self, message: impl Into<String>) {
        self.sink.send(ChatEvent::ToolProgress {
            id: self.call_id.to_string(),
            message: message.into(),
        });
    }

    /// Emit an event this call produced that is not keyed to it — a transcript's
    /// provenance, a video preview. Same channel, no correlation key, because
    /// those events attach to the run rather than to one node.
    pub(super) fn send(&mut self, event: ChatEvent) {
        self.sink.send(event);
    }
}
