//! The closed set of gated tools, the reversibility each one declares, and the
//! user-facing YOLO warning generated from that declaration.
//!
//! This module is the load-bearing half of the enforcement chain described in
//! §9.3 of `specs/agentic-chat-pane-plan.md`:
//!
//! 1. adding a [`GatedTool`] variant fails to compile until its [`Reversibility`]
//!    is declared ([`reversibility`] is exhaustive with no wildcard arm, and
//!    `Reversibility` has no `Default`);
//! 2. classifying a tool `Irreversible` changes the generated confirmation copy
//!    ([`yolo_irreversible_sentence`]);
//! 3. the golden test on that copy goes red, so a human re-blesses the security
//!    text before it lands.
//!
//! A silent safety regression therefore becomes a visible, user-facing copy
//! change. That is the whole point, and it is why the mechanism is copy
//! generation rather than a comment or a checklist.

use crate::ai::tool_registry::{
    TOOL_FETCH_CAPTIONS, TOOL_FETCH_VIDEO_INFO, TOOL_RESOLVE_DISTIL_ROUTE,
    TOOL_SELECT_PLAYLIST_VIDEOS, TOOL_TRANSCRIBE_AUDIO, TOOL_USE_SKILL, TOOL_WRITE_NOTE,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One tool the approval gate covers.
///
/// **Closed on purpose, and there is deliberately no `Other(String)` variant.**
/// A string variant would reopen the injection channel this whole design closes:
/// the classifier's input is a fixed set of app-computed scalars precisely so
/// that no field exists for an instruction to live in. One `String` is enough to
/// undo that, so the escape hatch is not offered.
///
/// The wire name of each variant is a `TOOL_*` constant from
/// [`crate::ai::tool_registry`], and
/// [`every_gated_tool_name_is_a_registered_tool`](self#tests) keeps the two
/// tables tied together — a tool rename cannot silently un-gate a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum GatedTool {
    /// Creates a note in the vault.
    WriteNote,
    /// Widens the tool grant set for the rest of the run (`skill_tools.rs`).
    UseSkill,
    /// Widens the run's write budget (`write_policy.rs`).
    SelectPlaylistVideos,
    /// Persists a vault profile that steers *future* routing (`youtube_route.rs`).
    ResolveDistilRoute,
    /// Reaches the internet for video metadata.
    FetchVideoInfo,
    /// Reaches the internet for captions.
    FetchCaptions,
    /// Spawns a host process and may trigger a binary install.
    TranscribeAudio,
}

/// Whether a tool's effect can be taken back once it has run.
///
/// No `Default`, on purpose. A tool whose reversibility nobody decided must not
/// silently become the permissive one — a derived `Default` would let a new
/// variant inherit "reversible" by omission, which is precisely the failure this
/// type exists to close.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reversibility {
    /// Undoable after the fact through the `UndoLedger`, or scoped to the run.
    Reversible,
    /// Cannot be taken back once it has run.
    Irreversible,
}

/// Every gated tool, in the order the user-facing warning lists them.
pub const ALL_GATED_TOOLS: [GatedTool; 7] = [
    GatedTool::WriteNote,
    GatedTool::UseSkill,
    GatedTool::SelectPlaylistVideos,
    GatedTool::ResolveDistilRoute,
    GatedTool::FetchVideoInfo,
    GatedTool::FetchCaptions,
    GatedTool::TranscribeAudio,
];

/// Exhaustive by construction — **no wildcard arm**. Adding a [`GatedTool`]
/// variant makes this fail to compile (E0004, non-exhaustive patterns) until its
/// reversibility is declared. This is the guard that `eligible()` provides for
/// `ApproveForMe` and that `Yolo` previously lacked (§9.3).
///
/// Each classification is confirmed against the real call site, not inferred:
///
/// * `write_note` — create-only (`ai/tools.rs`, `write_policy.rs`); the host
///   primitive is `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` and every create is
///   recorded in the `UndoLedger`, so the worst outcome is an undoable note.
/// * `use_skill` / `select_playlist_videos` — both widen run-scoped state (the
///   tool grant set and the write budget). Neither survives the run.
/// * `resolve_distil_route` — writes `<vault>/.neuralnote/profile.json` through
///   `VaultProfileIo::save` (`ai/youtube_route.rs`). Durable state that outlives
///   the run and steers future routing, with no ledger entry and no undo.
/// * `fetch_video_info` / `fetch_captions` — a request cannot be unsent.
/// * `transcribe_audio` — spawns a host process and may install a binary.
pub const fn reversibility(tool: GatedTool) -> Reversibility {
    match tool {
        GatedTool::WriteNote => Reversibility::Reversible,
        GatedTool::UseSkill => Reversibility::Reversible,
        GatedTool::SelectPlaylistVideos => Reversibility::Reversible,
        GatedTool::ResolveDistilRoute => Reversibility::Irreversible,
        GatedTool::FetchVideoInfo => Reversibility::Irreversible,
        GatedTool::FetchCaptions => Reversibility::Irreversible,
        GatedTool::TranscribeAudio => Reversibility::Irreversible,
    }
}

/// The slot each variant occupies in [`ALL_GATED_TOOLS`]. One arm per variant, no
/// wildcard, so adding a variant fails here (E0004) until someone declares where
/// it belongs.
const fn slot(tool: GatedTool) -> usize {
    let index = match tool {
        GatedTool::WriteNote => 0,
        GatedTool::UseSkill => 1,
        GatedTool::SelectPlaylistVideos => 2,
        GatedTool::ResolveDistilRoute => 3,
        GatedTool::FetchVideoInfo => 4,
        GatedTool::FetchCaptions => 5,
        GatedTool::TranscribeAudio => 6,
    };
    // A slot past the end of the array names a tool that was declared but never
    // placed in it — see the honest limits below. This makes that loud wherever
    // `slot` is actually reached, rather than silent.
    assert!(index < ALL_GATED_TOOLS.len());
    index
}

/// Ties [`ALL_GATED_TOOLS`] to the slot table at COMPILE time.
///
/// **What it proves:** every entry of the array sits at the index [`slot`]
/// declares for it. So the array cannot be reordered, and it cannot contain the
/// same tool twice, without failing const-eval (E0080).
///
/// **What it does NOT prove, stated plainly because the difference matters:**
/// that the array is *complete*. Stable Rust has no way to enumerate an enum's
/// variants in a const context (`variant_count` is unstable and there is no
/// derive here), so a variant that is declared in all six exhaustive matches but
/// left out of this array would still compile, and would drop silently out of
/// the generated YOLO warning.
///
/// The plan's §9.6.6 asserts that case fails with E0080 because "the new arm's
/// slot indexes past a `[_; 7]` array". It does not: nothing indexes the array
/// *by* slot, so `slot(NewVariant) == 7` is never evaluated. This was checked by
/// adding a throwaway variant — the six E0004s fired, the const block stayed
/// silent — rather than taken on trust.
///
/// What closes the gap instead is the runtime pairing in
/// [`the_reversibility_classification_matches_the_blessed_table`](self#tests):
/// its expected table is hand-written variant by variant, so the length check
/// inside `assert_eq!` reddens the moment the array and that table disagree.
const _: () = {
    let mut i = 0;
    while i < ALL_GATED_TOOLS.len() {
        assert!(slot(ALL_GATED_TOOLS[i]) == i);
        i += 1;
    }
};

impl GatedTool {
    /// The model-facing wire name, shared with [`crate::ai::tool_registry`].
    pub const fn name(self) -> &'static str {
        match self {
            Self::WriteNote => TOOL_WRITE_NOTE,
            Self::UseSkill => TOOL_USE_SKILL,
            Self::SelectPlaylistVideos => TOOL_SELECT_PLAYLIST_VIDEOS,
            Self::ResolveDistilRoute => TOOL_RESOLVE_DISTIL_ROUTE,
            Self::FetchVideoInfo => TOOL_FETCH_VIDEO_INFO,
            Self::FetchCaptions => TOOL_FETCH_CAPTIONS,
            Self::TranscribeAudio => TOOL_TRANSCRIBE_AUDIO,
        }
    }

    /// Resolve a wire name. `None` means the tool is **not gated** — a read-only
    /// vault tool, `skill_step`, or `ask_user` — and needs no approval decision.
    pub fn from_name(name: &str) -> Option<Self> {
        ALL_GATED_TOOLS.into_iter().find(|tool| tool.name() == name)
    }

    /// Whether this tool's effect can be taken back. See [`reversibility`].
    pub const fn reversibility(self) -> Reversibility {
        reversibility(self)
    }

    /// The plain-language phrase the YOLO confirmation uses for this tool.
    ///
    /// User-facing copy, so: no tool name, no `snake_case`, no insider shorthand
    /// (§9.6.5). "Saving how it files your notes", never `resolve_distil_route`.
    /// Two tools deliberately share a phrase — a user does not distinguish
    /// "fetching a video's details" from "fetching its captions", and the
    /// sentence dedupes so the warning reads as English rather than as a list of
    /// implementation details.
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::WriteNote => "creating notes in your vault",
            Self::UseSkill => "giving itself more tools to work with",
            Self::SelectPlaylistVideos => "taking on more videos in one go",
            Self::ResolveDistilRoute => "saving how it files your notes",
            Self::FetchVideoInfo | Self::FetchCaptions => {
                "fetching pages and captions from the internet"
            }
            Self::TranscribeAudio => "running audio transcription on your machine",
        }
    }
}

/// The plain-language phrases for every [`Reversibility::Irreversible`] tool, in
/// [`ALL_GATED_TOOLS`] order, with repeats collapsed.
///
/// Rust owns this list and the UI composes the sentence around it, so the warning
/// cannot rot into a stale hand-written list and cannot silently omit a
/// newly-added destructive tool. One source of truth, and it is the same one the
/// gate consults.
pub fn irreversible_display_names() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = Vec::new();
    for tool in ALL_GATED_TOOLS {
        if reversibility(tool) == Reversibility::Irreversible
            && !names.contains(&tool.display_name())
        {
            names.push(tool.display_name());
        }
    }
    names
}

/// The bolded sentence in the YOLO entry confirmation, generated from the
/// reversibility classification rather than written by hand (§9.6.5).
///
/// Pinned by a golden test. Classify a new tool `Irreversible` and the golden
/// reddens; classify one `Reversible` and it reddens. Neither can land as a
/// silent diff in a match arm.
pub fn yolo_irreversible_sentence() -> String {
    join_plain_english(&irreversible_display_names())
}

/// Join phrases the way a person writes a list: `a`, `a and b`, `a, b, and c`.
fn join_plain_english(parts: &[&str]) -> String {
    match parts {
        [] => String::new(),
        [only] => (*only).to_string(),
        [first, second] => format!("{first} and {second}"),
        [leading @ .., last] => format!("{}, and {last}", leading.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::tool_registry::RegisteredTool;
    use std::collections::BTreeSet;

    #[test]
    fn yolo_confirmation_irreversible_sentence_matches_the_blessed_copy() {
        // GOLDEN. This string is user-facing security copy. If a change to
        // `reversibility()` moves a tool in or out of the irreversible set, this
        // assertion fails and a human must consciously re-bless what the user is
        // shown before it can ship. Do NOT update it to match a new output
        // without reading it.
        assert_eq!(
            yolo_irreversible_sentence(),
            "saving how it files your notes, fetching pages and captions from the \
             internet, and running audio transcription on your machine",
        );
    }

    #[test]
    fn the_reversibility_classification_matches_the_blessed_table() {
        // GOLDEN, and it exists because the sentence golden above has one blind
        // spot: `fetch_video_info` and `fetch_captions` deliberately SHARE a
        // display phrase, so reclassifying exactly one of them as Reversible
        // leaves the generated sentence byte-identical and the golden green — a
        // silent safety regression at the one place the design says a regression
        // must be loud. This table is hand-written here and compared against the
        // code's own match, so ANY single reclassification reddens it.
        let expected = [
            (GatedTool::WriteNote, Reversibility::Reversible),
            (GatedTool::UseSkill, Reversibility::Reversible),
            (GatedTool::SelectPlaylistVideos, Reversibility::Reversible),
            (GatedTool::ResolveDistilRoute, Reversibility::Irreversible),
            (GatedTool::FetchVideoInfo, Reversibility::Irreversible),
            (GatedTool::FetchCaptions, Reversibility::Irreversible),
            (GatedTool::TranscribeAudio, Reversibility::Irreversible),
        ];
        let actual: Vec<_> = ALL_GATED_TOOLS
            .into_iter()
            .map(|tool| (tool, reversibility(tool)))
            .collect();
        assert_eq!(actual, expected.to_vec());
    }

    #[test]
    fn every_gated_tool_name_is_a_registered_tool() {
        // The gate routes on names the dispatcher also routes on. If a tool is
        // renamed in `tool_registry` and not here, `GatedTool::from_name` stops
        // matching and the tool silently leaves the gated set — an un-gating with
        // no diff anywhere near the approval code.
        for tool in ALL_GATED_TOOLS {
            assert_eq!(
                RegisteredTool::from_name(tool.name()).map(RegisteredTool::name),
                Some(tool.name()),
                "gated tool '{}' is not a registered tool",
                tool.name()
            );
        }
    }

    #[test]
    fn the_gated_set_is_exactly_seven_distinct_tools() {
        let names: BTreeSet<&str> = ALL_GATED_TOOLS.iter().map(|tool| tool.name()).collect();
        assert_eq!(names.len(), 7);
        assert_eq!(ALL_GATED_TOOLS.len(), 7);
    }

    #[test]
    fn an_ungated_tool_name_resolves_to_none() {
        // Read-only vault tools and the model's own question tool are NOT gated.
        for name in [
            "list_notes",
            "list_folders",
            "search_notes",
            "read_note_span",
            "skill_step",
            "ask_user",
            "definitely_not_a_tool",
        ] {
            assert_eq!(GatedTool::from_name(name), None, "{name} must not be gated");
        }
    }

    #[test]
    fn every_gated_tool_round_trips_between_name_and_variant() {
        for tool in ALL_GATED_TOOLS {
            assert_eq!(GatedTool::from_name(tool.name()), Some(tool));
        }
    }

    #[test]
    fn gated_tools_serialise_as_bare_camel_case_identifiers() {
        // The variant is what the classifier sees in place of a tool name string,
        // so its serialised form has to satisfy the subject's identifier rule.
        for tool in ALL_GATED_TOOLS {
            let value = serde_json::to_value(tool).unwrap();
            let text = value.as_str().expect("a gated tool serialises as a string");
            assert!(
                text.chars().next().is_some_and(char::is_lowercase)
                    && text.chars().all(|c| c.is_ascii_alphanumeric()),
                "{text} is not a bare camelCase identifier"
            );
        }
    }

    #[test]
    fn no_display_name_leaks_a_tool_identifier() {
        // The warning is read by a person. A `snake_case` symbol in it means the
        // user has to look something up to understand the consequence.
        for tool in ALL_GATED_TOOLS {
            let display = tool.display_name();
            assert!(!display.contains('_'), "{display} leaks a snake_case name");
            assert!(!display.contains(tool.name()), "{display} names the tool");
        }
    }

    #[test]
    fn the_irreversible_list_collapses_the_shared_phrase() {
        assert_eq!(
            irreversible_display_names(),
            vec![
                "saving how it files your notes",
                "fetching pages and captions from the internet",
                "running audio transcription on your machine",
            ]
        );
    }

    #[test]
    fn plain_english_joining_handles_every_list_length() {
        assert_eq!(join_plain_english(&[]), "");
        assert_eq!(join_plain_english(&["one"]), "one");
        assert_eq!(join_plain_english(&["one", "two"]), "one and two");
        assert_eq!(
            join_plain_english(&["one", "two", "three"]),
            "one, two, and three"
        );
    }
}
