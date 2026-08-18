//! Per-video playlist control: bounded turns, announcements, and context eviction.

use super::PARTIAL_RUN_CANCELLED;
use crate::ai::events::{ChatEvent, EventSink, PlaylistPosition};
use crate::ai::llm::{LlmMessage, Role};
use crate::ai::youtube::YoutubeToolSession;

const MAX_PLAYLIST_TURNS_PER_ITEM: usize = 8;

/// Which video the run is working on, for the round beacon to carry.
///
/// `None` covers both "no playlist was ever selected" and "the playlist is
/// finished", because in each case there is no item in flight to count — and a
/// finished playlist reporting "video 3 of 3" for the answer turn would claim
/// work that is over.
///
/// The 1-based position is composed here rather than at the reader: the session
/// counts items from zero, and the wire is what a human reads.
pub(super) fn playlist_position(session: &YoutubeToolSession) -> Option<PlaylistPosition> {
    let (index, total, _video_id) = session.playlist_current()?;
    Some(PlaylistPosition {
        // Saturating like the round number beside it: a wrapped position would
        // read as the playlist starting over.
        position: u32::try_from(index.saturating_add(1)).unwrap_or(u32::MAX),
        total: u32::try_from(total).unwrap_or(u32::MAX),
    })
}

#[derive(Default)]
pub(super) struct PlaylistLoopState {
    pub(super) context_chars: usize,
    announced_item: Option<usize>,
    summary_emitted: bool,
}

impl PlaylistLoopState {
    pub(super) fn sync(
        &mut self,
        messages: &mut Vec<LlmMessage>,
        youtube_session: &mut YoutubeToolSession,
        sink: &mut dyn EventSink,
    ) {
        sync_playlist_control(
            messages,
            youtube_session,
            sink,
            &mut self.context_chars,
            &mut self.announced_item,
            &mut self.summary_emitted,
        );
    }
}

pub(super) enum LoopControl {
    Proceed,
    Continue,
    Return(bool),
}

pub(super) fn playlist_preflight(
    messages: &mut Vec<LlmMessage>,
    youtube_session: &mut YoutubeToolSession,
    sink: &mut dyn EventSink,
    state: &mut PlaylistLoopState,
) -> LoopControl {
    if !youtube_session.playlist_is_active() {
        return LoopControl::Proceed;
    }
    if youtube_session.cancellation().is_cancelled() {
        youtube_session.cancel_playlist_remaining();
        state.sync(messages, youtube_session, sink);
        sink.send(ChatEvent::PartialRun {
            reason: PARTIAL_RUN_CANCELLED.to_string(),
        });
        return LoopControl::Return(false);
    }
    let over_turn_limit = youtube_session
        .record_playlist_turn()
        .is_some_and(|turns| turns > MAX_PLAYLIST_TURNS_PER_ITEM);
    if !over_turn_limit {
        return LoopControl::Proceed;
    }
    youtube_session.fail_playlist_item(format!(
        "exceeded the bounded {MAX_PLAYLIST_TURNS_PER_ITEM}-turn work-item allowance"
    ));
    state.sync(messages, youtube_session, sink);
    if youtube_session.playlist_is_finished() {
        LoopControl::Return(false)
    } else {
        LoopControl::Continue
    }
}

pub(super) fn handle_empty_tool_turn(
    messages: &mut Vec<LlmMessage>,
    youtube_session: &mut YoutubeToolSession,
    sink: &mut dyn EventSink,
    state: &mut PlaylistLoopState,
) -> LoopControl {
    if !youtube_session.playlist_is_active() {
        return LoopControl::Return(false);
    }
    youtube_session.fail_playlist_item(
        "model stopped before both literature and transcript notes were written",
    );
    state.sync(messages, youtube_session, sink);
    if youtube_session.playlist_is_finished() {
        LoopControl::Return(false)
    } else {
        LoopControl::Continue
    }
}

#[allow(clippy::too_many_arguments)]
fn sync_playlist_control(
    messages: &mut Vec<LlmMessage>,
    youtube_session: &mut YoutubeToolSession,
    sink: &mut dyn EventSink,
    context_chars: &mut usize,
    announced_item: &mut Option<usize>,
    summary_emitted: &mut bool,
) {
    let outcomes = youtube_session.take_unreported_playlist_outcomes();
    if !outcomes.is_empty() {
        compact_completed_playlist_context(messages, context_chars);
        for outcome in outcomes {
            let message = match outcome {
                crate::ai::youtube::PlaylistItemOutcome::Succeeded { video_id } => {
                    format!("Playlist video {video_id} succeeded")
                }
                crate::ai::youtube::PlaylistItemOutcome::Failed { video_id, reason } => {
                    format!("Playlist video {video_id} failed: {reason}")
                }
                crate::ai::youtube::PlaylistItemOutcome::Cancelled { video_id } => {
                    format!("Playlist video {video_id} cancelled")
                }
            };
            sink.send(ChatEvent::SkillStep { message });
        }
    }

    if youtube_session.playlist_is_finished() {
        if !*summary_emitted {
            messages.push(LlmMessage::system(format!(
                "PLAYLIST EXECUTION SUMMARY\n{}",
                youtube_session.playlist_summary().unwrap_or_default()
            )));
            *summary_emitted = true;
        }
        return;
    }

    if let Some((index, total, video_id)) = youtube_session.playlist_current() {
        if *announced_item != Some(index) {
            messages.push(LlmMessage::system(format!(
                "Implementation control: process playlist video {}/{} with id '{}'. Use write_note work_item {}. Do not move to another video until both its literature and transcript notes have been written; failures are recorded explicitly by the host.",
                index + 1,
                total,
                video_id,
                index
            )));
            *announced_item = Some(index);
        }
    }
}

fn compact_completed_playlist_context(messages: &mut [LlmMessage], context_chars: &mut usize) {
    for message in messages.iter_mut() {
        if message.role == Role::Assistant {
            for call in &mut message.tool_calls {
                if call.arguments.len() > 512 {
                    call.arguments = r#"{"context_evicted":"completed playlist work item"}"#.into();
                }
            }
        }
        if message.role == Role::Tool
            && message
                .content
                .as_ref()
                .is_some_and(|content| content.len() > 512)
        {
            message.content = Some(
                r#"{"context_evicted":"completed playlist work item; report-card events and Undo ledger preserved"}"#
                    .into(),
            );
        }
    }
    *context_chars = messages
        .iter()
        .filter(|message| message.role == Role::Tool)
        .filter_map(|message| message.content.as_ref())
        .map(String::len)
        .sum();
}
