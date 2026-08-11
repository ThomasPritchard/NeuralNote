//! Driving one streamed tool-deciding turn from raw response bytes.
//!
//! Three layers stack up to a streamed tool turn, and this is the top one:
//!
//! 1. [`ToolTurnAccumulator`] reassembles fragments into calls and previews the
//!    note being composed. It knows nothing about SSE.
//! 2. [`consume_tool_sse_line`] turns one SSE *line* into accumulator input.
//! 3. This module turns a sequence of arbitrary *byte chunks* into those lines,
//!    and settles the turn into a [`Completion`].
//!
//! It lives in core rather than the Tauri shell for the same reason the SSE
//! parsing does: the behaviour is owned here, so coverage is measured here, and
//! both providers drive it through the one client. The shell keeps only the part
//! that genuinely needs the network — pulling chunks off the socket.
//!
//! **Not every provider streams a tool turn.** The one that cannot sends no
//! tool-call fragments and no prose, which arrives here as a turn that carried
//! nothing at all. That is reported as [`StreamedToolTurn::NotStreamed`] so the
//! caller re-runs the turn buffered, rather than handing the orchestrator an
//! empty turn — which reads as "the model chose to answer" and would silently
//! skip retrieval for the whole run.

use crate::ai::events::EventSink;
use crate::ai::llm::Completion;
use crate::ai::openai::consume_tool_sse_line;
use crate::ai::tool_stream::ToolTurnAccumulator;
use crate::error::CoreResult;

/// How a streamed tool turn settled.
#[derive(Debug)]
pub enum StreamedToolTurn {
    /// The provider streamed the turn. This is what a buffered `complete` would
    /// have returned for it.
    Completed(Completion),
    /// The provider streamed no tool-call fragments and no prose — it does not
    /// stream this turn. The caller must fall back to a buffered `complete`.
    ///
    /// Nothing was emitted when this is reported: a preview can only come from a
    /// tool call, and there were none. So the fallback is invisible to the user
    /// and cannot replay a note over one already on screen.
    NotStreamed,
}

/// Reassembles one streamed tool-deciding turn from the bytes of the response.
#[derive(Debug, Default)]
pub struct ToolTurnReader {
    /// Bytes not yet resolved into a complete line. Buffered as BYTES, not
    /// `str`: a chunk can split a multibyte character, but never the `\n`
    /// delimiter (one byte, never part of a UTF-8 sequence), so every complete
    /// line decodes cleanly.
    buf: Vec<u8>,
    accumulator: ToolTurnAccumulator,
    terminated: bool,
}

impl ToolTurnReader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold in one chunk of the response body. `Ok(true)` means the terminator
    /// was seen (stop reading); `Ok(false)` means keep reading; `Err` surfaces a
    /// failure with every live preview already cleared.
    pub fn push_bytes(&mut self, chunk: &[u8], sink: &mut dyn EventSink) -> CoreResult<bool> {
        self.buf.extend_from_slice(chunk);
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            if consume_tool_sse_line(&line, &mut self.accumulator, sink)? {
                self.terminated = true;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Settle the turn at end of stream.
    ///
    /// A final line the stream left without a trailing newline is read first —
    /// otherwise a last fragment, or a terminal error frame, sitting in the tail
    /// would be silently lost.
    pub fn finish(mut self, sink: &mut dyn EventSink) -> CoreResult<StreamedToolTurn> {
        if !self.terminated && !self.buf.is_empty() {
            let tail = std::mem::take(&mut self.buf);
            consume_tool_sse_line(&tail, &mut self.accumulator, sink)?;
        }
        let completion = self.accumulator.finish(sink)?;
        // Prose alone is a real answer — the model declining to call a tool — and
        // must NOT trigger a fallback that would bill a second turn and could
        // answer differently. Only a turn that carried nothing at all is one the
        // provider failed to stream.
        if completion.content.is_none() && completion.tool_calls.is_empty() {
            return Ok(StreamedToolTurn::NotStreamed);
        }
        Ok(StreamedToolTurn::Completed(completion))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::events::{ChatEvent, VecSink};
    use crate::ai::openai::{parse_tool_sse_line, ToolSseEvent};
    use crate::ai::tool_registry::TOOL_WRITE_NOTE;
    use crate::ai::tool_stream::ABANDONED_TURN_FAILED;

    /// The captured turn. Contract C6: every tool-call frame below is a line of
    /// this file, or a line of it with one field substituted. None is invented.
    const CAPTURE: &str = include_str!("fixtures/openrouter_tool_stream.sse");

    /// The capture's completed `write_note`, whose body arrived in 386 fragments.
    const COMPLETED_CALL: u32 = 1;

    fn captured_frame(predicate: impl Fn(&str) -> bool) -> &'static str {
        CAPTURE
            .lines()
            .find(|line| line.starts_with("data:") && predicate(line))
            .expect("the capture still contains this frame")
    }

    /// The capture's raw lines carrying fragments for exactly one call.
    fn frames_for(index: u32) -> Vec<&'static str> {
        CAPTURE
            .lines()
            .filter(|line| match parse_tool_sse_line(line) {
                ToolSseEvent::Delta { fragments, .. } => {
                    !fragments.is_empty() && fragments.iter().all(|f| f.index == index)
                }
                _ => false,
            })
            .collect()
    }

    /// Everything the capture sent as `arguments` for one call, in order.
    fn captured_arguments(index: u32) -> String {
        frames_for(index)
            .into_iter()
            .filter_map(|line| match parse_tool_sse_line(line) {
                ToolSseEvent::Delta { fragments, .. } => Some(fragments),
                _ => None,
            })
            .flatten()
            .filter_map(|fragment| fragment.arguments)
            .collect()
    }

    /// The capture's own `write_note`, rebuilt as ONE frame carrying the whole
    /// argument blob — the shape local Ollama sends.
    ///
    /// Derived from the real first-sight frame by substituting its empty
    /// `arguments` for the full blob the capture went on to send in pieces, so
    /// every other field stays exactly as the provider wrote it.
    fn atomic_frame() -> String {
        const EMPTY_ARGUMENTS: &str = r#""arguments":"""#;
        let first_sight = captured_frame(|line| {
            line.contains(r#""name":"write_note""#) && line.contains(r#""index":1,"#)
        });
        assert!(
            first_sight.contains(EMPTY_ARGUMENTS),
            "the first-sight frame still carries the empty argument fragment to substitute"
        );
        let escaped = serde_json::to_string(&captured_arguments(COMPLETED_CALL))
            .expect("a string always serialises");
        let frame = first_sight.replace(EMPTY_ARGUMENTS, &format!(r#""arguments":{escaped}"#));
        // Guard the substitution itself: a frame this mangles parses as noise and
        // is silently skipped, so every assertion downstream would go vacuous.
        let fragment = match parse_tool_sse_line(&frame) {
            ToolSseEvent::Delta { fragments, .. } if fragments.len() == 1 => {
                fragments.into_iter().next().unwrap()
            }
            _ => panic!("the substituted frame must still parse as one tool-call fragment"),
        };
        assert_eq!(
            fragment.arguments.as_deref(),
            Some(captured_arguments(COMPLETED_CALL).as_str()),
            "the whole blob must ride on the single fragment"
        );
        frame
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

    /// Feed whole lines, as a well-behaved provider would chunk them.
    fn read_lines(lines: &[&str], sink: &mut VecSink) -> (ToolTurnReader, CoreResult<bool>) {
        let mut reader = ToolTurnReader::new();
        for line in lines {
            let line = format!("{line}\n");
            match reader.push_bytes(line.as_bytes(), sink) {
                Ok(false) => {}
                other => return (reader, other),
            }
        }
        (reader, Ok(false))
    }

    fn completed(turn: StreamedToolTurn) -> Completion {
        match turn {
            StreamedToolTurn::Completed(completion) => completion,
            StreamedToolTurn::NotStreamed => {
                panic!("the provider streamed this turn; it must not ask for a fallback")
            }
        }
    }

    #[test]
    fn a_whole_call_in_one_frame_previews_once_and_carries_its_arguments_intact() {
        // The local-Ollama shape, measured: the entire arguments blob arrives in a
        // SINGLE fragment rather than progressively. The preview then appears
        // already complete instead of composing — and the call it hands on for
        // dispatch has to be byte-identical to the fragmented provider's.
        let mut sink = VecSink::default();
        let (reader, outcome) = read_lines(&[&atomic_frame()], &mut sink);
        assert!(!outcome.unwrap(), "no terminator in this frame");

        let previews = previews(&sink);
        assert_eq!(previews.len(), 1, "one fragment previews exactly once");
        let (id, body, complete) = previews[0];
        assert!(complete, "a whole call is complete the moment it lands");
        assert!(id.starts_with("chatcmpl-tool-"), "the provider's call id");
        let expected_body =
            serde_json::from_str::<serde_json::Value>(&captured_arguments(COMPLETED_CALL)).unwrap()
                ["content"]
                .as_str()
                .unwrap()
                .to_string();
        assert_eq!(body, expected_body, "the whole note previews at once");
        assert!(
            body.len() > 4000,
            "the captured note is 4728 characters; a short body would mean this \
             test passes without comparing the thing it exists to compare"
        );

        let completion = completed(reader.finish(&mut sink).unwrap());
        let call = completion.tool_calls.first().expect("the call settles");
        assert_eq!(call.name, TOOL_WRITE_NOTE);
        assert_eq!(
            call.arguments,
            captured_arguments(COMPLETED_CALL),
            "the atomic call must dispatch exactly what the fragmented one does"
        );
        assert!(
            !sink
                .events
                .iter()
                .any(|event| matches!(event, ChatEvent::NoteEditAbandoned { .. })),
            "a call that arrived whole is never abandoned"
        );
    }

    #[test]
    fn a_fragmented_call_reaches_the_same_arguments_as_the_atomic_one() {
        // The two provider shapes must converge. Same capture, one call: read it
        // fragment by fragment and the settled arguments are the blob the atomic
        // frame carried in one piece.
        let mut sink = VecSink::default();
        let (reader, outcome) = read_lines(&frames_for(COMPLETED_CALL), &mut sink);
        assert!(!outcome.unwrap());

        assert!(
            previews(&sink).len() > 100,
            "the fragmented shape previews as it composes"
        );
        let completion = completed(reader.finish(&mut sink).unwrap());
        assert_eq!(
            completion.tool_calls.first().unwrap().arguments,
            captured_arguments(COMPLETED_CALL)
        );
    }

    #[test]
    fn a_provider_that_streams_no_tool_calls_asks_for_a_fallback_and_emits_nothing() {
        // Ollama does stream tool calls, but a future provider might ignore
        // `stream` on a tool turn. Handing the orchestrator an empty turn would
        // read as "the model chose to answer" and skip retrieval for the whole
        // run, silently. So it settles as NotStreamed instead.
        let mut sink = VecSink::default();
        let reasoning = captured_frame(|line| line.contains("reasoning.text"));
        let (reader, outcome) = read_lines(&[reasoning, "data: [DONE]"], &mut sink);
        assert!(outcome.unwrap(), "the terminator stopped the read");

        assert!(
            matches!(
                reader.finish(&mut sink).unwrap(),
                StreamedToolTurn::NotStreamed
            ),
            "a turn that carried nothing must ask for the buffered fallback"
        );
        assert!(
            sink.events.is_empty(),
            "nothing reached the user, so the fallback cannot replay over a card"
        );
    }

    #[test]
    fn a_turn_that_only_prosed_is_a_real_answer_not_a_fallback() {
        // The model declining to call a tool is an ordinary outcome. Falling back
        // there would bill a second turn and could answer differently.
        let mut sink = VecSink::default();
        let prose = r#"data: {"choices":[{"delta":{"content":"No note needed."}}]}"#;
        let (reader, _) = read_lines(&[prose], &mut sink);

        let completion = completed(reader.finish(&mut sink).unwrap());
        assert_eq!(completion.content.as_deref(), Some("No note needed."));
        assert!(completion.tool_calls.is_empty());
    }

    #[test]
    fn frames_split_across_chunk_boundaries_reassemble_into_the_same_call() {
        // The socket does not align chunks to SSE lines. Reading the capture's own
        // call one awkward byte-slice at a time must settle identically to reading
        // it line by line.
        let wire: String = frames_for(COMPLETED_CALL)
            .iter()
            .map(|line| format!("{line}\n"))
            .collect();
        let mut sink = VecSink::default();
        let mut reader = ToolTurnReader::new();
        for chunk in wire.as_bytes().chunks(7) {
            assert!(!reader.push_bytes(chunk, &mut sink).unwrap());
        }

        let completion = completed(reader.finish(&mut sink).unwrap());
        assert_eq!(
            completion.tool_calls.first().unwrap().arguments,
            captured_arguments(COMPLETED_CALL),
            "a call severed at arbitrary byte boundaries must still reassemble"
        );
    }

    #[test]
    fn a_final_line_with_no_trailing_newline_is_still_read() {
        // A stream can end without a newline. Dropping the tail would lose the
        // last fragment of a note — or a terminal error frame.
        let mut sink = VecSink::default();
        let mut reader = ToolTurnReader::new();
        let frame = atomic_frame();
        assert!(!reader.push_bytes(frame.as_bytes(), &mut sink).unwrap());

        let completion = completed(reader.finish(&mut sink).unwrap());
        assert_eq!(
            completion.tool_calls.first().unwrap().arguments,
            captured_arguments(COMPLETED_CALL),
            "the tail line must be read at EOF, not discarded"
        );
    }

    #[test]
    fn the_captures_own_ending_fails_the_turn_and_clears_its_previews() {
        // The capture ends `finish_reason: "error"` with a note half composed. The
        // failure has to surface AND the card has to go, or a half-written note is
        // left on screen looking like one that landed.
        let mut sink = VecSink::default();
        let (_, outcome) = read_lines(&CAPTURE.lines().collect::<Vec<_>>(), &mut sink);

        let error = outcome.expect_err("the capture ends on a provider error frame");
        assert!(error.to_string().contains("unfinished plan"), "{error}");
        assert!(!previews(&sink).is_empty(), "cards were on screen");
        assert!(
            sink.events.iter().any(|event| matches!(
                event,
                ChatEvent::NoteEditAbandoned { reason, .. } if reason == ABANDONED_TURN_FAILED
            )),
            "the failure must clear what it promised"
        );
    }

    #[test]
    fn a_fragment_that_never_got_an_id_fails_the_turn_rather_than_leaving_a_hole() {
        // A tool result is keyed on the call id, so a call whose first-sight frame
        // never arrived cannot be answered. Surfacing the broken stream beats
        // dispatching a plan with a hole in it — and the caller clears the cards.
        let mut sink = VecSink::default();
        let orphan = captured_frame(|line| line.contains(r#"{\"query\""#))
            .replace(r#""index":0"#, r#""index":3"#);
        let (reader, _) = read_lines(&[&atomic_frame(), &orphan], &mut sink);

        let error = reader
            .finish(&mut sink)
            .expect_err("an unplaceable call must surface");

        assert!(error.to_string().contains("index 3"), "{error}");
    }
}
