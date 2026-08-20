//! The live write preview, end to end: what the user watched being composed has
//! to be what ends up in their vault.
//!
//! A preview that diverges from the file that lands is the same class of failure
//! as a wrong citation — the app would be showing the user something about their
//! own notes that is not true. So this suite drives the whole loop (streamed tool
//! turn → accumulator → preview events → dispatch → a real file on disk) from the
//! captured OpenRouter transcript, and compares the two ends.
//!
//! Contract C6: every tool-call frame here comes out of
//! `src/ai/fixtures/openrouter_tool_stream.sse`. Nothing below writes a frame of
//! its own.

mod support;

use async_trait::async_trait;
use futures::executor::block_on;
use neuralnote_core::ai::openai::{consume_tool_sse_line, parse_tool_sse_line, ToolSseEvent};
use neuralnote_core::ai::tool_stream::ToolTurnAccumulator;
use neuralnote_core::ai::{
    run_chat, ChatEvent, Completion, EventSink, Guards, HardwareSpec, KeywordRetriever, LlmClient,
    LlmRequest, NoUserPrompt, SkillEnvironment, SkillRegistry, SkillServices, ToolStatus,
    FIXTURE_SKILL_ID,
};
use neuralnote_core::CoreResult;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use support::FsBackend;

/// The captured turn — the single source of truth for the wire shape.
const CAPTURE: &str = include_str!("../src/ai/fixtures/openrouter_tool_stream.sse");

/// The capture's completed `write_note`, whose 4840-character body arrived in 386
/// fragments.
const COMPLETED_CALL: u32 = 1;
/// The capture's call that the stream cut off mid-arguments.
const TRUNCATED_CALL: u32 = 15;

#[derive(Default)]
struct VecEventSink(Vec<ChatEvent>);

impl EventSink for VecEventSink {
    fn send(&mut self, event: ChatEvent) {
        self.0.push(event);
    }
}

/// The capture's raw SSE lines that carry fragments for exactly one call.
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

/// How the provider delivered one call's arguments.
///
/// Both shapes are measured, not imagined. OpenRouter fragmented a single call
/// into 386 pieces averaging 12.5 characters; local Ollama sent its whole
/// argument blob in ONE fragment. The note that lands in the vault must not
/// depend on which of the two the user happens to be running.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ArgumentShape {
    Fragmented,
    Atomic,
}

/// The capture's own call rebuilt as a single frame carrying the whole argument
/// blob — the local-Ollama shape.
///
/// Derived from the real first-sight frame by substituting its empty `arguments`
/// for everything the capture went on to send in pieces, so every other field is
/// still exactly as the provider wrote it (contract C6).
fn atomic_frame(index: u32) -> String {
    const EMPTY_ARGUMENTS: &str = r#""arguments":"""#;
    let first_sight = frames_for(index)
        .into_iter()
        .find(|line| match parse_tool_sse_line(line) {
            ToolSseEvent::Delta { fragments, .. } => {
                fragments.iter().any(|fragment| fragment.id.is_some())
            }
            _ => false,
        })
        .expect("the capture announces every call with a first-sight frame");
    assert!(
        first_sight.contains(EMPTY_ARGUMENTS),
        "first sight carries an EMPTY argument fragment, which is what gets substituted"
    );
    let escaped = serde_json::to_string(&whole_arguments(index)).expect("a string serialises");
    let frame = first_sight.replace(EMPTY_ARGUMENTS, &format!(r#""arguments":{escaped}"#));
    // A mangled substitution parses as noise and is silently skipped, which would
    // leave every assertion downstream passing against nothing.
    match parse_tool_sse_line(&frame) {
        ToolSseEvent::Delta { fragments, .. } if fragments.len() == 1 => assert_eq!(
            fragments[0].arguments.as_deref(),
            Some(whole_arguments(index).as_str()),
            "the whole blob must ride on the single fragment"
        ),
        _ => panic!("the substituted frame must still parse as one tool-call fragment"),
    }
    frame
}

/// Everything the capture sent as `arguments` for one call, in order.
fn whole_arguments(index: u32) -> String {
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

/// The captured call omits `kind`, which `write_note`'s schema requires — so the
/// capture on its own can never reach the writer, and the two ends of this test
/// could never be compared. Add that one member and nothing else: `content`, the
/// thing actually under test, round-trips through `serde_json` untouched.
fn with_kind(arguments: &str) -> String {
    let mut value: serde_json::Value = serde_json::from_str(arguments)
        .expect("the completed call's arguments parse; that is what makes it the completed one");
    value["kind"] = serde_json::Value::String("atomic".into());
    value.to_string()
}

/// Replays one call out of the capture as a streamed tool turn, then answers.
struct FixtureStreamingLlm {
    call: u32,
    /// Whether to add the `kind` the schema requires (see [`with_kind`]). The
    /// truncated call's arguments never parse, so it cannot be repaired at all.
    repair_kind: bool,
    shape: ArgumentShape,
    turns: Mutex<usize>,
}

impl FixtureStreamingLlm {
    fn new(call: u32, repair_kind: bool) -> Self {
        Self {
            call,
            repair_kind,
            shape: ArgumentShape::Fragmented,
            turns: Mutex::new(0),
        }
    }

    /// The same captured call, delivered whole in one frame.
    fn atomic(call: u32, repair_kind: bool) -> Self {
        Self {
            shape: ArgumentShape::Atomic,
            ..Self::new(call, repair_kind)
        }
    }

    fn frames(&self) -> Vec<String> {
        match self.shape {
            ArgumentShape::Fragmented => frames_for(self.call)
                .into_iter()
                .map(str::to_string)
                .collect(),
            ArgumentShape::Atomic => vec![atomic_frame(self.call)],
        }
    }
}

#[async_trait]
impl LlmClient for FixtureStreamingLlm {
    async fn complete(&self, _req: &LlmRequest) -> CoreResult<Completion> {
        panic!("this client streams its tool turns; the buffered path must not be reached")
    }

    async fn complete_tool_streaming(
        &self,
        _req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<Completion> {
        let turn = {
            let mut turns = self.turns.lock().unwrap();
            *turns += 1;
            *turns
        };
        if turn > 1 {
            // The tools have run; end the loop so the answer turn can stream.
            return Ok(Completion {
                content: Some("ready".into()),
                tool_calls: Vec::new(),
            });
        }
        let mut accumulator = ToolTurnAccumulator::new();
        for line in self.frames() {
            consume_tool_sse_line(line.as_bytes(), &mut accumulator, sink)?;
        }
        let mut completion = accumulator.finish(sink)?;
        if self.repair_kind {
            for call in &mut completion.tool_calls {
                call.arguments = with_kind(&call.arguments);
            }
        }
        Ok(completion)
    }

    async fn complete_streaming(
        &self,
        _req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<String> {
        let answer = "Done.".to_string();
        sink.send(ChatEvent::Answer {
            delta: answer.clone(),
        });
        Ok(answer)
    }
}

fn environment() -> SkillEnvironment {
    SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 16_000_000_000,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 10_000_000_000,
        },
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::new(),
        unusable_binaries: Default::default(),
    }
}

fn run(root: &Path, llm: &FixtureStreamingLlm) -> Vec<ChatEvent> {
    let retriever = KeywordRetriever::new(root);
    let registry = SkillRegistry::built_in(&[]).unwrap();
    let environment = environment();
    let (policy, approval_prompt, approval_classifier) = support::unattended_approval();
    let services = SkillServices::new(&registry, &environment, &NoUserPrompt, &FsBackend, 1)
        .with_approval(policy, approval_prompt, approval_classifier);
    let mut sink = VecEventSink::default();
    block_on(run_chat(
        "write up spaced repetition",
        &[],
        vec![FIXTURE_SKILL_ID.into()],
        root,
        "test-model",
        &retriever,
        llm,
        &services,
        &mut sink,
        &Guards::default(),
    ))
    .unwrap();
    sink.0
}

fn previews(events: &[ChatEvent]) -> Vec<(&str, &str, bool)> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::NoteEditPreview {
                id, body, complete, ..
            } => Some((id.as_str(), body.as_str(), *complete)),
            _ => None,
        })
        .collect()
}

fn written_note(events: &[ChatEvent]) -> Option<&str> {
    events.iter().find_map(|event| match event {
        ChatEvent::NoteWritten { rel_path, .. } => Some(rel_path.as_str()),
        _ => None,
    })
}

/// The vault the capture's note wants, with its folder already in place —
/// `write_note` is create-only and never invents a parent directory.
fn vault() -> tempfile::TempDir {
    let vault = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(vault.path().join("Zettelkasten")).unwrap();
    vault
}

/// Drive one turn to completion and read back what reached the vault: the note's
/// path, its bytes on disk, and the events the user saw.
fn landed_note(llm: &FixtureStreamingLlm) -> (String, String, Vec<ChatEvent>) {
    let vault = vault();
    let events = run(vault.path(), llm);
    let rel_path = written_note(&events).expect("the write landed").to_string();
    let on_disk = std::fs::read_to_string(vault.path().join(&rel_path)).unwrap();
    (rel_path, on_disk, events)
}

#[test]
fn the_previewed_body_is_exactly_what_lands_in_the_vault() {
    let vault = vault();
    let llm = FixtureStreamingLlm::new(COMPLETED_CALL, true);

    let events = run(vault.path(), &llm);

    let previews = previews(&events);
    let (preview_id, previewed_body, complete) = *previews
        .last()
        .expect("the completed call previews as it composes");
    assert!(complete, "the final preview reports the closed arguments");
    assert!(
        previewed_body.len() > 4000,
        "the captured note is 4728 characters; a short body here would mean this \
         test can pass without ever comparing the thing it exists to compare"
    );

    let rel_path = written_note(&events).expect("the write landed");
    let on_disk = std::fs::read_to_string(vault.path().join(rel_path)).unwrap();
    assert_eq!(
        on_disk, previewed_body,
        "the note the user watched being composed is not the note that landed"
    );

    // The card upgrades in place, so the preview and the write must be the same
    // act — same correlation key, and nothing abandoned it on the way.
    let call_id = events.iter().find_map(|event| match event {
        ChatEvent::ToolCall { id, name, .. } if name == "write_note" => Some(id.as_str()),
        _ => None,
    });
    assert_eq!(call_id, Some(preview_id));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, ChatEvent::NoteEditAbandoned { .. })),
        "a note that landed must not also be reported abandoned"
    );
}

#[test]
fn no_preview_ever_shows_text_the_written_note_does_not_contain() {
    // Stronger than comparing the last frame: the body is shown hundreds of times
    // on the way, and any one of those could have leaked a mangled escape or a
    // half-decoded character that the finished body no longer shows.
    let vault = vault();
    let llm = FixtureStreamingLlm::new(COMPLETED_CALL, true);

    let events = run(vault.path(), &llm);

    let rel_path = written_note(&events).expect("the write landed");
    let on_disk = std::fs::read_to_string(vault.path().join(rel_path)).unwrap();
    let previews = previews(&events);
    assert!(previews.len() > 100, "the body previewed as it arrived");
    let mut last_len = 0;
    for (_, body, _) in &previews {
        assert!(
            on_disk.starts_with(body),
            "a preview showed text the written note does not begin with"
        );
        assert!(body.len() >= last_len, "a preview must never rewind");
        last_len = body.len();
    }
}

#[test]
fn a_call_arriving_whole_in_one_frame_previews_once_and_lands_the_same_note() {
    // The local-Ollama shape, and now the common case for one of the two
    // providers: no composing animation, just a preview that is already complete.
    // What matters is that the shortcut changes only the *pacing* — the note the
    // user is shown, and the note that lands, must be the fragmented one's.
    let (atomic_path, atomic_note, events) =
        landed_note(&FixtureStreamingLlm::atomic(COMPLETED_CALL, true));

    let previews = previews(&events);
    assert_eq!(
        previews.len(),
        1,
        "one fragment previews exactly once — there is nothing to animate"
    );
    let (preview_id, previewed_body, complete) = previews[0];
    assert!(complete, "a whole call is complete the moment it lands");
    assert!(
        previewed_body.len() > 4000,
        "the captured note is 4728 characters; a short body here would mean this \
         test can pass without ever comparing the thing it exists to compare"
    );
    assert_eq!(
        atomic_note, previewed_body,
        "the note the user was shown is not the note that landed"
    );

    let call_id = events.iter().find_map(|event| match event {
        ChatEvent::ToolCall { id, name, .. } if name == "write_note" => Some(id.as_str()),
        _ => None,
    });
    assert_eq!(call_id, Some(preview_id), "the card upgrades in place");
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, ChatEvent::NoteEditAbandoned { .. })),
        "a note that landed must not also be reported abandoned"
    );

    // The two provider shapes must converge on the same file, or which provider
    // the user picked would change what ends up in their vault.
    let (fragmented_path, fragmented_note, _) =
        landed_note(&FixtureStreamingLlm::new(COMPLETED_CALL, true));
    assert_eq!(
        atomic_note, fragmented_note,
        "atomic and fragmented delivery must land byte-identical notes"
    );
    assert_eq!(atomic_path, fragmented_path, "and at the same path");
}

#[test]
fn a_call_the_stream_cut_off_is_abandoned_and_writes_nothing() {
    // The capture's own ending: the model stopped mid-note. The card must be
    // cleared and the call must still settle on the timeline — a half-composed
    // diff left sitting there would read as a note that landed.
    let vault = vault();
    let llm = FixtureStreamingLlm::new(TRUNCATED_CALL, false);

    let events = run(vault.path(), &llm);

    let previews = previews(&events);
    assert!(!previews.is_empty(), "it previewed while it composed");
    assert!(
        previews.iter().all(|(_, _, complete)| !complete),
        "the arguments never closed"
    );
    let abandoned: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::NoteEditAbandoned { id, .. } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        abandoned,
        vec![previews[0].0],
        "exactly one abandonment, keyed to the card on screen"
    );
    assert_eq!(written_note(&events), None, "nothing was written");
    assert!(
        std::fs::read_dir(vault.path().join("Zettelkasten"))
            .unwrap()
            .next()
            .is_none(),
        "the vault folder is still empty"
    );
    // The call is still dispatched, so the timeline shows the model tried and the
    // orchestrator refused — rather than the call quietly disappearing.
    assert!(
        events.iter().any(|event| matches!(
            event,
            ChatEvent::ToolResult {
                status: ToolStatus::Rejected,
                ..
            }
        )),
        "the unparseable call settles as rejected"
    );
}
