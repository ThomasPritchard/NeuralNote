//! Reassembles streamed tool calls and previews only note-writing calls.
//! The captured fixture pins fragment ordering and incomplete-call settlement.

use crate::ai::events::{ChatEvent, EventSink, TokenUsage};
use crate::ai::llm::{Completion, ToolCall};
use crate::ai::partial_json::PartialObject;
use crate::ai::tool_registry::TOOL_WRITE_NOTE;
use crate::ai::transport_limits::{checked_len, reserve_string_bounded, ToolStreamLimits};
use crate::ai::write_policy::NoteKind;
use crate::error::{CoreError, CoreResult};
use std::collections::BTreeMap;

/// The tools whose in-flight arguments may be rendered to the user.
///
/// One entry today, and adding a second is a product decision rather than a
/// mechanical one: everything on this list has its half-finished, model-authored
/// arguments shown on screen.
pub const PREVIEWABLE_TOOLS: [&str; 1] = [TOOL_WRITE_NOTE];

/// The model stopped mid-arguments — the common case, per the capture.
pub const ABANDONED_INCOMPLETE: &str = "the model stopped before it finished composing this note";
/// The user stopped the run while the note was still being composed.
pub const ABANDONED_CANCELLED: &str = "the run was stopped before this note was composed";
/// The provider ended the turn (an error frame, or its own output ceiling).
pub const ABANDONED_TURN_FAILED: &str = "the provider ended the turn before this note was composed";

const ARG_REL_PATH: &str = "rel_path";
const ARG_KIND: &str = "kind";
const ARG_CONTENT: &str = "content";

/// One streamed tool-call entry, as one frame carried it.
///
/// Every field but `index` is optional because the wire sends each exactly once:
/// `id` and `name` on first sight, `arguments` in fragments after that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallDelta {
    /// The accumulation key. Fragments for one call are only recognisable as
    /// belonging together because they share this.
    pub index: u32,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<String>,
}

/// One streamed tool turn, reassembled as it arrives.
#[derive(Debug, Default)]
pub struct ToolTurnAccumulator {
    content: String,
    calls: BTreeMap<u32, PendingCall>,
    retained_bytes: usize,
    limits: ToolStreamLimits,
    /// Whether this turn's token usage has already gone to the sink. The run's
    /// total needs exactly one report per model call, so a repeated frame must
    /// not double-count — and a turn the provider never metered must still be
    /// reported as unmetered, which is what [`Self::usage_reported`] tells the
    /// reader to do.
    usage_reported: bool,
}

#[derive(Debug, Default)]
struct PendingCall {
    id: Option<String>,
    name: Option<String>,
    /// The argument fragments, concatenated verbatim. Never decoded in place:
    /// un-escaping is deferred to a whole-document parse of this buffer, so no
    /// escape sequence is ever decoded across a fragment boundary.
    arguments: String,
    /// The preview last sent for this call, so an identical one is not re-sent
    /// and so `finish` knows whether a card is on screen awaiting resolution.
    last_preview: Option<PreviewSnapshot>,
}

impl PendingCall {
    /// The id of the card this call has on screen, retiring it so exactly one
    /// abandonment can ever follow one preview. `None` when there is no card —
    /// which is also every call that never had an id to key one by.
    fn take_previewed_id(&mut self) -> Option<String> {
        self.last_preview.take()?;
        self.id.clone()
    }

    /// A card is on screen and its note never finished composing.
    fn previewed_but_unfinished(&self) -> bool {
        self.last_preview
            .as_ref()
            .is_some_and(|preview| !preview.complete)
    }
}

/// Enough of the last preview to tell whether the next one would say anything new.
/// The body is compared by length because it only ever grows.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PreviewSnapshot {
    rel_path: Option<String>,
    kind: Option<NoteKind>,
    body_len: usize,
    complete: bool,
}

impl ToolTurnAccumulator {
    pub fn new() -> Self {
        Self::with_limits(ToolStreamLimits::default())
    }

    pub fn with_limits(limits: ToolStreamLimits) -> Self {
        Self {
            content: String::new(),
            calls: BTreeMap::new(),
            retained_bytes: 0,
            limits,
            usage_reported: false,
        }
    }

    /// Fold in assistant prose under the per-turn retention ceilings.
    pub fn push_content(&mut self, delta: &str, sink: &mut dyn EventSink) -> CoreResult<()> {
        let next_content = checked_len(
            self.content.len(),
            delta.len(),
            self.limits.max_content_bytes,
            "tool-turn prose",
        );
        let next_retained = next_content.and_then(|_| {
            checked_len(
                self.retained_bytes,
                delta.len(),
                self.limits.max_total_retained_bytes,
                "tool-turn retained data",
            )
        });
        let next_retained = match next_retained {
            Ok(len) => len,
            Err(error) => {
                self.abandon(ABANDONED_TURN_FAILED, sink);
                return Err(error);
            }
        };
        if let Err(error) = reserve_string_bounded(
            &mut self.content,
            delta.len(),
            self.limits.max_content_bytes,
            "tool-turn prose",
        ) {
            self.abandon(ABANDONED_TURN_FAILED, sink);
            return Err(error);
        }
        self.content.push_str(delta);
        self.retained_bytes = next_retained;
        Ok(())
    }

    /// Pass this turn's token report to the sink, at most once.
    ///
    /// `None` is a frame that carried no usage, not a turn that carried none —
    /// it is ignored here, and the *reader* is what reports an unmetered turn
    /// once the stream has actually ended.
    pub fn report_usage(&mut self, usage: Option<TokenUsage>, sink: &mut dyn EventSink) {
        if self.usage_reported {
            return;
        }
        let Some(usage) = usage else {
            return;
        };
        self.usage_reported = true;
        sink.record_usage(Some(usage));
    }

    /// Whether the provider metered this turn.
    pub fn usage_reported(&self) -> bool {
        self.usage_reported
    }

    /// Fold in one tool-call fragment, emitting a live preview when the call is
    /// previewable and the fragment moved it on.
    pub fn push_fragment(
        &mut self,
        fragment: ToolCallDelta,
        sink: &mut dyn EventSink,
    ) -> CoreResult<()> {
        let current = self.calls.get(&fragment.index);
        let is_new = current.is_none();
        if is_new && self.calls.len() >= self.limits.max_calls {
            self.abandon(ABANDONED_TURN_FAILED, sink);
            return Err(CoreError::Llm(format!(
                "provider tool turn exceeded its {}-call limit",
                self.limits.max_calls
            )));
        }

        let previous_argument_bytes = current.map_or(0, |call| call.arguments.len());
        let added_argument_bytes = fragment.arguments.as_ref().map_or(0, String::len);
        let next_argument_bytes = match checked_len(
            previous_argument_bytes,
            added_argument_bytes,
            self.limits.max_call_argument_bytes,
            "tool-call arguments",
        ) {
            Ok(len) => len,
            Err(error) => {
                self.abandon(ABANDONED_TURN_FAILED, sink);
                return Err(error);
            }
        };
        let added_metadata_bytes = (if current.is_none_or(|call| call.id.is_none()) {
            fragment.id.as_ref().map_or(0, String::len)
        } else {
            0
        }) + (if current.is_none_or(|call| call.name.is_none()) {
            fragment.name.as_ref().map_or(0, String::len)
        } else {
            0
        });
        let added_retained_bytes = match added_argument_bytes.checked_add(added_metadata_bytes) {
            Some(bytes) => bytes,
            None => {
                self.abandon(ABANDONED_TURN_FAILED, sink);
                return Err(CoreError::Llm("tool-call size overflow".into()));
            }
        };
        let next_retained = match checked_len(
            self.retained_bytes,
            added_retained_bytes,
            self.limits.max_total_retained_bytes,
            "tool-turn retained data",
        ) {
            Ok(len) => len,
            Err(error) => {
                self.abandon(ABANDONED_TURN_FAILED, sink);
                return Err(error);
            }
        };

        let reserve_error = reserve_string_bounded(
            &mut self.calls.entry(fragment.index).or_default().arguments,
            added_argument_bytes,
            self.limits.max_call_argument_bytes,
            "tool-call arguments",
        );
        if let Err(error) = reserve_error {
            self.abandon(ABANDONED_TURN_FAILED, sink);
            return Err(error);
        }

        {
            let call = self
                .calls
                .get_mut(&fragment.index)
                .expect("call was inserted");
            if call.id.is_none() {
                call.id = fragment.id;
            }
            if call.name.is_none() {
                call.name = fragment.name;
            }
            if let Some(text) = fragment.arguments {
                call.arguments.push_str(&text);
            }
            debug_assert_eq!(call.arguments.len(), next_argument_bytes);
        }
        self.retained_bytes = next_retained;

        let call = self
            .calls
            .get_mut(&fragment.index)
            .expect("call was inserted");
        if !call.arguments.is_empty() && is_previewable(call.name.as_deref()) {
            emit_preview(call, sink);
        }
        Ok(())
    }

    /// Clear every preview still on screen, because the turn will not produce the
    /// notes they promised — the run was cancelled, or the provider ended it.
    ///
    /// Abandons completed previews too: nothing has been dispatched at this point,
    /// so a preview that merely finished composing is exactly the one at risk of
    /// being read as a note that landed.
    pub fn abandon(&mut self, reason: &str, sink: &mut dyn EventSink) {
        for call in self.calls.values_mut() {
            if let Some(id) = call.take_previewed_id() {
                sink.send(ChatEvent::NoteEditAbandoned {
                    id,
                    reason: reason.to_string(),
                });
            }
        }
    }

    /// Settle the turn into the [`Completion`] the orchestrator dispatches.
    ///
    /// Any preview whose arguments never closed is abandoned here: the model
    /// stopped mid-note, and a diff left sitting there would read as committed.
    /// The unclosed call is still returned, raw, so the dispatcher rejects it in
    /// full view rather than the call vanishing off the timeline.
    pub fn finish(mut self, sink: &mut dyn EventSink) -> CoreResult<Completion> {
        if let Some((index, _)) = self.calls.iter().find(|(_, call)| call.id.is_none()) {
            let index = *index;
            self.abandon(ABANDONED_TURN_FAILED, sink);
            return Err(CoreError::Llm(format!(
                "the provider streamed tool-call fragments at index {index} without an id, so the tool turn cannot be reassembled"
            )));
        }
        let mut tool_calls = Vec::with_capacity(self.calls.len());
        for call in self.calls.values_mut() {
            if call.previewed_but_unfinished() {
                if let Some(id) = call.take_previewed_id() {
                    sink.send(ChatEvent::NoteEditAbandoned {
                        id,
                        reason: ABANDONED_INCOMPLETE.to_string(),
                    });
                }
            }
            let id = call.id.clone().expect("ids were checked before settlement");
            tool_calls.push(ToolCall {
                // A nameless call is left nameless on purpose: the dispatcher
                // rejects it and it still gets a timeline node, which is the
                // existing handling for a tool name the model made up.
                name: call.name.clone().unwrap_or_default(),
                id,
                arguments: std::mem::take(&mut call.arguments),
            });
        }
        Ok(Completion {
            content: (!self.content.is_empty()).then_some(self.content),
            tool_calls,
        })
    }
}

/// A pass-through sink that remembers which previews are still unresolved.
///
/// [`ToolTurnAccumulator`] clears its own cards when the turn settles or fails,
/// because it still exists to do it. A run STOPPED mid-compose is the one case
/// where it does not: the host drops the whole streaming future — accumulator
/// and all — the moment the user hits stop, so nothing is left to send the
/// abandonment and a half-written note would sit on screen looking like one that
/// landed. Keeping the ids out here, in the caller's frame, is what survives
/// that drop.
pub struct LivePreviews<'a> {
    inner: &'a mut dyn EventSink,
    /// Previewed ids not yet abandoned, in first-seen order so the cards clear
    /// in the order the user watched them appear.
    live: Vec<String>,
}

impl<'a> LivePreviews<'a> {
    pub fn new(inner: &'a mut dyn EventSink) -> Self {
        Self {
            inner,
            live: Vec::new(),
        }
    }

    /// Clear every card still on screen. Idempotent: each is abandoned once, so
    /// a caller that clears defensively cannot double-report one.
    pub fn abandon_live(&mut self, reason: &str) {
        for id in std::mem::take(&mut self.live) {
            self.inner.send(ChatEvent::NoteEditAbandoned {
                id,
                reason: reason.to_string(),
            });
        }
    }
}

impl EventSink for LivePreviews<'_> {
    fn send(&mut self, event: ChatEvent) {
        match &event {
            ChatEvent::NoteEditPreview { id, .. } => {
                if !self.live.iter().any(|live| live == id) {
                    self.live.push(id.clone());
                }
            }
            // The turn resolved this one itself, so it is no longer ours to clear.
            ChatEvent::NoteEditAbandoned { id, .. } => self.live.retain(|live| live != id),
            _ => {}
        }
        self.inner.send(event);
    }

    /// Forwarded, not defaulted. This sink sits between the streaming client and
    /// the orchestrator's meter on BOTH tool-turn paths, so swallowing here would
    /// silently cost every real run its token counts.
    fn record_usage(&mut self, usage: Option<TokenUsage>) {
        self.inner.record_usage(usage);
    }
}

fn is_previewable(name: Option<&str>) -> bool {
    name.is_some_and(|name| PREVIEWABLE_TOOLS.contains(&name))
}

/// Re-read the bounded argument prefix and send a preview when it changes.
fn emit_preview(call: &mut PendingCall, sink: &mut dyn EventSink) {
    let Some(id) = call.id.clone() else {
        // No correlation key, so no card could be upgraded or cleared later.
        // `finish` turns this into a surfaced error.
        return;
    };
    let parsed = PartialObject::parse(&call.arguments);
    let rel_path = parsed.complete_str(ARG_REL_PATH).map(str::to_string);
    let kind = parsed.complete_str(ARG_KIND).and_then(parse_note_kind);
    let body = parsed.text(ARG_CONTENT).unwrap_or_default().to_string();
    let snapshot = PreviewSnapshot {
        rel_path: rel_path.clone(),
        kind,
        body_len: body.len(),
        complete: parsed.is_complete(),
    };
    if call.last_preview.as_ref() == Some(&snapshot) {
        return;
    }
    let complete = snapshot.complete;
    call.last_preview = Some(snapshot);
    sink.send(ChatEvent::NoteEditPreview {
        id,
        rel_path,
        kind,
        body,
        complete,
    });
}

/// The model can put anything in `kind`; only the three the vault recognises are
/// reported, and an unrecognised one reads as absent rather than as a guess.
fn parse_note_kind(raw: &str) -> Option<NoteKind> {
    serde_json::from_value(serde_json::Value::String(raw.to_string())).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::events::VecSink;
    use crate::ai::openai::{consume_tool_sse_line, parse_tool_sse_line, ToolSseEvent};

    /// The captured turn. Contract C6: the single source of truth for the wire
    /// shape, so no test below writes a tool-call frame of its own.
    const CAPTURE: &str = include_str!("fixtures/openrouter_tool_stream.sse");

    /// Every `data:` line of the capture, in order.
    fn capture_lines() -> Vec<&'static str> {
        CAPTURE.lines().collect()
    }

    /// Replay the whole capture, stopping where it does. It ends on a provider
    /// error frame, so the replay always ends on the failure it reports.
    fn replay_capture(sink: &mut VecSink) -> (ToolTurnAccumulator, CoreError) {
        let mut accumulator = ToolTurnAccumulator::new();
        for line in capture_lines() {
            if let Err(error) = consume_tool_sse_line(line.as_bytes(), &mut accumulator, sink) {
                return (accumulator, error);
            }
        }
        panic!("the capture ends on a provider error frame; it must not replay clean")
    }

    /// Every tool-call fragment in the capture, parsed by the real parser rather
    /// than by a test's idea of the frame shape.
    fn captured_fragments() -> Vec<ToolCallDelta> {
        capture_lines()
            .into_iter()
            .filter_map(|line| match parse_tool_sse_line(line) {
                ToolSseEvent::Delta { fragments, .. } => Some(fragments),
                _ => None,
            })
            .flatten()
            .collect()
    }

    /// The fragments the capture carries for one call, in arrival order.
    fn fragments_for(index: u32) -> Vec<ToolCallDelta> {
        captured_fragments()
            .into_iter()
            .filter(|fragment| fragment.index == index)
            .collect()
    }

    fn previews(sink: &VecSink) -> Vec<(&str, &str, bool)> {
        sink.events
            .iter()
            .filter_map(|event| match event {
                ChatEvent::NoteEditPreview {
                    id, body, complete, ..
                } => Some((id.as_str(), body.as_str(), *complete)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn argument_limit_failure_abandons_previews_and_does_not_retain_overflow() {
        let limits = ToolStreamLimits::new(2, 40, 64, 8);
        let mut accumulator = ToolTurnAccumulator::with_limits(limits);
        let mut sink = VecSink::default();
        let preview_fragment = ToolCallDelta {
            index: 0,
            id: Some("call_0".into()),
            name: Some(TOOL_WRITE_NOTE.into()),
            arguments: Some(r#"{"rel_path":"d.md","content":"hi""#.into()),
        };
        let retained_len = preview_fragment.arguments.as_ref().unwrap().len();
        accumulator
            .push_fragment(preview_fragment, &mut sink)
            .unwrap();
        let error = accumulator
            .push_fragment(
                ToolCallDelta {
                    index: 0,
                    id: None,
                    name: None,
                    arguments: Some("x".repeat(40)),
                },
                &mut sink,
            )
            .expect_err("an argument past its per-call byte cap must fail");

        assert!(error.to_string().contains("40-byte"), "{error}");
        let abandonments = sink
            .events
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    ChatEvent::NoteEditAbandoned { id, .. } if id == "call_0"
                )
            })
            .count();
        assert_eq!(
            abandonments, 1,
            "limit failure clears the preview exactly once"
        );
        assert_eq!(accumulator.calls[&0].arguments.len(), retained_len);
    }

    #[test]
    fn tool_prose_limit_is_enforced_before_retaining_the_delta() {
        let mut accumulator = ToolTurnAccumulator::with_limits(ToolStreamLimits::new(1, 8, 8, 4));
        let error = accumulator
            .push_content("12345", &mut VecSink::default())
            .expect_err("tool-turn prose must remain bounded");
        assert!(error.to_string().contains("4-byte"), "{error}");
        assert!(accumulator.content.is_empty());
    }

    fn abandoned(sink: &VecSink) -> Vec<&str> {
        sink.events
            .iter()
            .filter_map(|event| match event {
                ChatEvent::NoteEditAbandoned { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect()
    }

    /// The finished `content` argument of a call, straight from the capture.
    fn captured_content(index: u32) -> String {
        let raw: String = fragments_for(index)
            .into_iter()
            .filter_map(|fragment| fragment.arguments)
            .collect();
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()[ARG_CONTENT]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn the_capture_still_carries_the_shape_every_rule_here_was_derived_from() {
        // A guard on the fixture itself. If a later trim removes the empty
        // fragments or the truncated call, the rules below stop being tested and
        // this says so instead of the suite quietly going green on less.
        let fragments = captured_fragments();
        assert!(
            fragments
                .iter()
                .filter(|f| f.arguments.as_deref() == Some(""))
                .count()
                >= 4,
            "the empty argument fragments are load-bearing and must survive any trim"
        );
        let first_sight: Vec<&ToolCallDelta> =
            fragments.iter().filter(|f| f.id.is_some()).collect();
        assert_eq!(first_sight.len(), 16, "the capture's 16 calls");
        assert!(
            first_sight.iter().all(|f| f.name.is_some()),
            "id and name arrive together, on first sight"
        );
        let ids: std::collections::BTreeSet<&String> =
            first_sight.iter().filter_map(|f| f.id.as_ref()).collect();
        assert_eq!(ids.len(), 16, "every call has its own id");
        assert_eq!(
            fragments
                .iter()
                .filter(|f| f.id.is_none() && f.name.is_some())
                .count(),
            0,
            "the name is sent once, with the id, and never repeated"
        );
    }

    #[test]
    fn the_runaway_turn_reassembles_into_one_call_per_index() {
        // The capture's model asked for sixteen calls, fifteen of them duplicate
        // write_notes. They must come back as sixteen separately-keyed calls with
        // sixteen ids and no bleed between them.
        let mut sink = VecSink::default();
        let (accumulator, error) = replay_capture(&mut sink);
        assert!(
            error.to_string().contains("unfinished plan"),
            "the capture ends on a provider error frame: {error}"
        );
        let calls: Vec<(u32, Option<String>, Option<String>)> = accumulator
            .calls
            .iter()
            .map(|(index, call)| (*index, call.id.clone(), call.name.clone()))
            .collect();
        assert_eq!(calls.len(), 16);
        assert_eq!(calls.first().unwrap().2.as_deref(), Some("search_notes"));
        assert!(
            calls[1..]
                .iter()
                .all(|(_, _, name)| name.as_deref() == Some(TOOL_WRITE_NOTE)),
            "fifteen duplicate write_notes"
        );
        let ids: std::collections::BTreeSet<Option<String>> =
            calls.iter().map(|(_, id, _)| id.clone()).collect();
        assert_eq!(ids.len(), 16, "no two calls share an id");
        assert_eq!(
            calls.iter().map(|(index, _, _)| *index).collect::<Vec<_>>(),
            (0..16).collect::<Vec<u32>>()
        );
    }

    #[test]
    fn a_completed_call_previews_its_body_and_ends_complete() {
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        for fragment in fragments_for(1) {
            accumulator.push_fragment(fragment, &mut sink).unwrap();
        }
        let previews = previews(&sink);
        assert!(
            previews.len() > 100,
            "the body arrives in fragments, so it previews many times ({} here)",
            previews.len()
        );
        // Every preview is a prefix of the finished note, and they only grow.
        let expected = captured_content(1);
        for (_, body, _) in &previews {
            assert!(
                expected.starts_with(body),
                "a preview showed text the finished note does not contain"
            );
        }
        let (id, body, complete) = *previews.last().unwrap();
        assert!(complete, "the last preview reports the closed arguments");
        assert_eq!(body, expected);
        assert!(id.starts_with("chatcmpl-tool-"), "the provider's call id");
        assert!(abandoned(&sink).is_empty(), "nothing to abandon");
    }

    #[test]
    fn the_truncated_call_is_abandoned_and_still_returned_for_dispatch() {
        // Index 15 in the capture: 1367 characters that never became valid JSON.
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        for fragment in fragments_for(15) {
            accumulator.push_fragment(fragment, &mut sink).unwrap();
        }
        let (id, _, complete) = *previews(&sink).last().unwrap();
        let id = id.to_string();
        assert!(!complete, "the arguments never closed");
        let completion = accumulator.finish(&mut sink).unwrap();
        assert_eq!(
            abandoned(&sink),
            vec![id.as_str()],
            "exactly one abandonment"
        );
        let call = completion.tool_calls.first().unwrap();
        assert_eq!(call.name, TOOL_WRITE_NOTE);
        assert!(
            serde_json::from_str::<serde_json::Value>(&call.arguments).is_err(),
            "the raw arguments are handed on unrepaired, for the dispatcher to reject"
        );
    }

    #[test]
    fn an_empty_fragment_is_not_a_terminator() {
        // The capture's first-sight frames all carry `"arguments": ""`, and 32
        // empty fragments follow. Reading one as an end-of-call would truncate
        // every note in the vault at zero characters.
        let fragments = fragments_for(1);
        assert!(
            fragments
                .iter()
                .filter(|f| f.arguments.as_deref() == Some(""))
                .count()
                >= 2,
            "the fixture must keep its empty fragments"
        );
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        for fragment in fragments {
            accumulator.push_fragment(fragment, &mut sink).unwrap();
        }
        assert_eq!(previews(&sink).last().unwrap().1, captured_content(1));
    }

    #[test]
    fn two_interleaved_calls_do_not_bleed_into_one_another() {
        // The capture's calls arrive one after another, so interleave two of its
        // real fragment streams to prove the index — not arrival order — is what
        // keeps them apart.
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        let (mut first, mut second) = (fragments_for(0), fragments_for(1));
        first.reverse();
        second.reverse();
        while !first.is_empty() || !second.is_empty() {
            if let Some(fragment) = first.pop() {
                accumulator.push_fragment(fragment, &mut sink).unwrap();
            }
            if let Some(fragment) = second.pop() {
                accumulator.push_fragment(fragment, &mut sink).unwrap();
            }
        }
        let completion = accumulator.finish(&mut sink).unwrap();
        assert_eq!(completion.tool_calls.len(), 2);
        let search = &completion.tool_calls[0];
        assert_eq!(search.name, "search_notes");
        assert!(
            serde_json::from_str::<serde_json::Value>(&search.arguments).unwrap()["query"]
                .is_string(),
            "the search call's arguments survived intact alongside a 4840-character write"
        );
        assert_eq!(previews(&sink).last().unwrap().1, captured_content(1));
        assert!(abandoned(&sink).is_empty());
    }

    #[test]
    fn arguments_arriving_in_one_chunk_preview_once_and_complete() {
        // Some providers do not fragment at all. Rebuild the capture's own call as
        // a single fragment: one preview, already complete.
        let whole: String = fragments_for(1)
            .into_iter()
            .filter_map(|fragment| fragment.arguments)
            .collect();
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        accumulator
            .push_fragment(
                ToolCallDelta {
                    index: 1,
                    id: Some("call-1".into()),
                    name: Some(TOOL_WRITE_NOTE.into()),
                    arguments: Some(whole),
                },
                &mut sink,
            )
            .unwrap();
        assert_eq!(previews(&sink).len(), 1);
        let (_, body, complete) = previews(&sink)[0];
        assert!(complete);
        assert_eq!(body, captured_content(1));
        accumulator.finish(&mut sink).unwrap();
        assert!(abandoned(&sink).is_empty());
    }

    #[test]
    fn arguments_that_never_become_valid_json_are_abandoned() {
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        accumulator
            .push_fragment(
                ToolCallDelta {
                    index: 0,
                    id: Some("call-1".into()),
                    name: Some(TOOL_WRITE_NOTE.into()),
                    arguments: Some(r#"{"rel_path": "a.md", "content": "body"#.into()),
                },
                &mut sink,
            )
            .unwrap();
        accumulator.finish(&mut sink).unwrap();
        assert_eq!(abandoned(&sink), vec!["call-1"]);
        let (_, body, complete) = *previews(&sink).last().unwrap();
        assert_eq!(body, "body");
        assert!(!complete);
    }

    #[test]
    fn cancelling_mid_preview_abandons_the_card_exactly_once() {
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        for fragment in fragments_for(1).into_iter().take(40) {
            accumulator.push_fragment(fragment, &mut sink).unwrap();
        }
        assert!(!previews(&sink).is_empty(), "a card is on screen");
        accumulator.abandon(ABANDONED_CANCELLED, &mut sink);
        let reasons: Vec<&str> = sink
            .events
            .iter()
            .filter_map(|event| match event {
                ChatEvent::NoteEditAbandoned { reason, .. } => Some(reason.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(reasons, vec![ABANDONED_CANCELLED]);
        // Settling afterwards must not send a second abandonment for one card.
        accumulator.finish(&mut sink).unwrap();
        assert_eq!(abandoned(&sink).len(), 1);
    }

    #[test]
    fn a_completed_preview_is_still_abandoned_when_the_turn_is_cancelled() {
        // Nothing has been dispatched yet, so a finished-composing card is exactly
        // the one at risk of being read as a note that landed.
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        for fragment in fragments_for(1) {
            accumulator.push_fragment(fragment, &mut sink).unwrap();
        }
        assert!(previews(&sink).last().unwrap().2, "composed in full");
        accumulator.abandon(ABANDONED_CANCELLED, &mut sink);
        assert_eq!(abandoned(&sink).len(), 1);
    }

    #[test]
    fn only_previewable_tools_are_previewed() {
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        for fragment in fragments_for(0) {
            accumulator.push_fragment(fragment, &mut sink).unwrap();
        }
        assert!(
            previews(&sink).is_empty(),
            "search_notes arguments are not rendered as a note"
        );
        accumulator.finish(&mut sink).unwrap();
        assert!(abandoned(&sink).is_empty());
    }

    #[test]
    fn the_path_and_kind_appear_only_once_they_have_finished_arriving() {
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        for chunk in [
            r#"{"rel_path": "Notes/Spa"#,
            r#"ced.md", "kind": "atom"#,
            r#"ic", "#,
        ] {
            accumulator
                .push_fragment(
                    ToolCallDelta {
                        index: 0,
                        id: Some("call-1".into()),
                        name: Some(TOOL_WRITE_NOTE.into()),
                        arguments: Some(chunk.into()),
                    },
                    &mut sink,
                )
                .unwrap();
        }
        let paths: Vec<(Option<String>, Option<NoteKind>)> = sink
            .events
            .iter()
            .filter_map(|event| match event {
                ChatEvent::NoteEditPreview { rel_path, kind, .. } => {
                    Some((rel_path.clone(), *kind))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            paths.first(),
            Some(&(None, None)),
            "half a path is not a path"
        );
        assert_eq!(
            paths.last(),
            Some(&(Some("Notes/Spaced.md".into()), Some(NoteKind::Atomic)))
        );
    }

    #[test]
    fn an_unrecognised_kind_reads_as_absent_rather_than_as_a_guess() {
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        accumulator
            .push_fragment(
                ToolCallDelta {
                    index: 0,
                    id: Some("call-1".into()),
                    name: Some(TOOL_WRITE_NOTE.into()),
                    arguments: Some(r#"{"kind": "diary", "content": "x"}"#.into()),
                },
                &mut sink,
            )
            .unwrap();
        let kinds: Vec<Option<NoteKind>> = sink
            .events
            .iter()
            .filter_map(|event| match event {
                ChatEvent::NoteEditPreview { kind, .. } => Some(*kind),
                _ => None,
            })
            .collect();
        assert_eq!(kinds, vec![None]);
    }

    #[test]
    fn the_first_id_and_name_win_over_a_later_contradiction() {
        // The wire sends each once. A second, different id would orphan every
        // event already emitted under the first.
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        for (id, name) in [("call-1", TOOL_WRITE_NOTE), ("call-2", "search_notes")] {
            accumulator
                .push_fragment(
                    ToolCallDelta {
                        index: 0,
                        id: Some(id.into()),
                        name: Some(name.into()),
                        arguments: Some(r#"{"content": "x"#.into()),
                    },
                    &mut sink,
                )
                .unwrap();
        }
        let completion = accumulator.finish(&mut sink).unwrap();
        let call = completion.tool_calls.first().unwrap();
        assert_eq!(call.id, "call-1");
        assert_eq!(call.name, TOOL_WRITE_NOTE);
        assert_eq!(abandoned(&sink), vec!["call-1"]);
    }

    #[test]
    fn fragments_with_no_id_surface_as_an_error_rather_than_a_hole_in_the_turn() {
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        accumulator
            .push_fragment(
                ToolCallDelta {
                    index: 3,
                    id: None,
                    name: Some(TOOL_WRITE_NOTE.into()),
                    arguments: Some(r#"{"content": "orphan"}"#.into()),
                },
                &mut sink,
            )
            .unwrap();
        let error = accumulator.finish(&mut sink).unwrap_err();
        assert!(
            error.to_string().contains("index 3"),
            "the error names the fragment it could not place: {error}"
        );
        assert!(
            previews(&sink).is_empty(),
            "no card without a correlation key"
        );
    }

    #[test]
    fn a_fragment_that_carries_no_arguments_at_all_changes_nothing() {
        // A frame can announce a call without an argument fragment beside it.
        // That is identity, not content — nothing to preview yet.
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        accumulator
            .push_fragment(
                ToolCallDelta {
                    index: 0,
                    id: Some("call-1".into()),
                    name: Some(TOOL_WRITE_NOTE.into()),
                    arguments: None,
                },
                &mut sink,
            )
            .unwrap();
        assert!(previews(&sink).is_empty());
        let completion = accumulator.finish(&mut sink).unwrap();
        assert_eq!(completion.tool_calls.first().unwrap().arguments, "");
        assert!(
            abandoned(&sink).is_empty(),
            "no card was ever shown, so there is none to clear"
        );
    }

    /// Every reason attached to an abandonment, in order.
    fn abandon_reasons(sink: &VecSink) -> Vec<(&str, &str)> {
        sink.events
            .iter()
            .filter_map(|event| match event {
                ChatEvent::NoteEditAbandoned { id, reason } => Some((id.as_str(), reason.as_str())),
                _ => None,
            })
            .collect()
    }

    /// Stream `fragments` through a tracker, then stop the run mid-compose.
    /// Scoped so the sink is readable again once the tracker has let it go.
    fn stopped_mid_compose(fragments: Vec<ToolCallDelta>, settle: bool) -> VecSink {
        let mut sink = VecSink::default();
        {
            let mut tracked = LivePreviews::new(&mut sink);
            let mut accumulator = ToolTurnAccumulator::new();
            for fragment in fragments {
                accumulator.push_fragment(fragment, &mut tracked).unwrap();
            }
            if settle {
                accumulator.finish(&mut tracked).unwrap();
            }
            tracked.abandon_live(ABANDONED_CANCELLED);
        }
        sink
    }

    #[test]
    fn a_run_stopped_mid_compose_clears_the_card_it_left_on_screen() {
        // The stop drops the streaming future and its accumulator, so the card
        // outlives the only thing that knew about it. This is what clears it.
        let sink = stopped_mid_compose(fragments_for(1).into_iter().take(40).collect(), false);

        let abandoned = abandon_reasons(&sink);
        assert_eq!(abandoned.len(), 1, "one card, cleared once");
        assert_eq!(abandoned[0].1, ABANDONED_CANCELLED);
        assert_eq!(
            abandoned[0].0,
            previews(&sink).last().unwrap().0,
            "the abandonment is keyed to the card the user is looking at"
        );
    }

    #[test]
    fn a_card_the_turn_already_retired_keeps_the_turns_own_reason() {
        // The accumulator clears its own unfinished cards when the turn settles.
        // Clearing again on the way out would report one card twice — and would
        // overwrite why it really went with a cancellation that came later.
        let sink = stopped_mid_compose(fragments_for(15), true);

        let abandoned = abandon_reasons(&sink);
        assert_eq!(abandoned.len(), 1, "the turn retired it; the stop must not");
        assert_eq!(
            abandoned[0].1, ABANDONED_INCOMPLETE,
            "the model stopped composing — that is why the card went, not the stop"
        );
    }

    #[test]
    fn a_turn_that_previewed_nothing_has_nothing_to_clear() {
        // Index 0 is `search_notes`, which is never previewable.
        let sink = stopped_mid_compose(fragments_for(0), false);

        assert!(
            sink.events.is_empty(),
            "search_notes never previews, so a stop has no card to clear"
        );
    }

    #[test]
    fn clearing_twice_reports_each_card_once() {
        let mut sink = VecSink::default();
        {
            let mut tracked = LivePreviews::new(&mut sink);
            let mut accumulator = ToolTurnAccumulator::new();
            for fragment in fragments_for(1).into_iter().take(40) {
                accumulator.push_fragment(fragment, &mut tracked).unwrap();
            }
            tracked.abandon_live(ABANDONED_CANCELLED);
            tracked.abandon_live(ABANDONED_CANCELLED);
        }

        assert_eq!(abandon_reasons(&sink).len(), 1, "idempotent");
    }

    #[test]
    fn tracking_previews_leaves_every_other_event_untouched() {
        // It is a pass-through: the turn's events must reach the user unchanged,
        // in order, whether or not they concern a note edit.
        let mut sink = VecSink::default();
        {
            let mut tracked = LivePreviews::new(&mut sink);
            tracked.send(ChatEvent::Verifying);
            tracked.send(ChatEvent::Done);
        }

        assert_eq!(sink.events, vec![ChatEvent::Verifying, ChatEvent::Done]);
    }

    #[test]
    fn assistant_prose_alongside_the_tool_calls_is_kept() {
        let mut sink = VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        accumulator.push_content("Let me ", &mut sink).unwrap();
        accumulator.push_content("check.", &mut sink).unwrap();
        let completion = accumulator.finish(&mut sink).unwrap();
        assert_eq!(completion.content.as_deref(), Some("Let me check."));
        // A turn with no prose reports absent, never an empty string.
        assert_eq!(
            ToolTurnAccumulator::new()
                .finish(&mut sink)
                .unwrap()
                .content,
            None
        );
    }
}
