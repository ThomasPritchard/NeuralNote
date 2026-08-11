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

/// Declares the gated set **once**, and derives from that one list everything
/// that has to cover every variant: the enum itself, [`ALL_GATED_TOOLS`],
/// [`GatedTool::name`], and [`GatedTool::from_name`].
///
/// **Why a macro rather than a hand-written enum plus a hand-written array.**
/// The array and the enum used to be two lists a human kept in step, tied
/// together by a const assertion. That assertion could prove the array was
/// *ordered* correctly but not that it was *complete*, because stable Rust
/// cannot enumerate an enum's variants in a const context. A variant declared in
/// all six exhaustive matches but left out of the array therefore compiled — and
/// `from_name` searched the array, so it answered `None` for that tool,
/// `ApprovedCall::ungated` accepted the call, and [`decide`] was never reached.
/// The tool ran with **no approval decision in any mode**, `AlwaysAsk` included,
/// with the whole suite green. Verified by adding a throwaway eighth variant: 45
/// gate tests passed while the tool was completely un-gated.
///
/// Here there is no second list to fall out of step with. A variant that is not
/// in this invocation does not exist; one that is, is in the array and resolves
/// by name. **What would go red if this were violated:** nothing needs to — the
/// state is unrepresentable. What a reviewer must protect is the macro itself:
/// declaring a `GatedTool` variant *outside* this invocation would reopen the
/// hole, and the compiler cannot stop that (a second `enum GatedTool` would
/// collide, but adding an arm to a hand-rolled enum would not).
///
/// `$wire_name` is a `TOOL_*` path constant from [`crate::ai::tool_registry`], so
/// it serves as both the returned value and the match pattern — the name a tool
/// is gated under and the name the dispatcher routes on are the same token.
macro_rules! declare_gated_tools {
    (
        $( #[$enum_meta:meta] )*
        pub enum $enum_name:ident {
            $( $( #[$variant_meta:meta] )* $variant:ident => $wire_name:path ),+ $(,)?
        }
    ) => {
        $( #[$enum_meta] )*
        pub enum $enum_name {
            $( $( #[$variant_meta] )* $variant, )+
        }

        /// Every gated tool, in the order the user-facing warning lists them.
        ///
        /// Generated from the same list as the enum by [`declare_gated_tools!`],
        /// so it cannot omit a variant. The length is counted from that list
        /// rather than written down, so it cannot disagree with it either.
        pub const ALL_GATED_TOOLS: [$enum_name; [$( stringify!($variant) ),+].len()] =
            [ $( $enum_name::$variant ),+ ];

        impl $enum_name {
            /// The model-facing wire name, shared with [`crate::ai::tool_registry`].
            pub const fn name(self) -> &'static str {
                match self {
                    $( Self::$variant => $wire_name, )+
                }
            }

            /// Resolve a wire name. `None` means the tool is **not gated** — a
            /// read-only vault tool, `skill_step`, or `ask_user` — and needs no
            /// approval decision.
            ///
            /// One arm per variant, generated from the same list as the enum, so
            /// a `GatedTool` this cannot resolve is unrepresentable. That matters
            /// more than it looks: `None` here is not a soft failure, it is the
            /// un-gating. `ApprovedCall::ungated` returns `Some` for a name the
            /// gate does not claim, and [`decide`] is then never called at all.
            ///
            /// `deny(unreachable_patterns)` is the one piece of this that is not
            /// free. `&'static str` constants match by VALUE, so two variants
            /// pointing at the same `TOOL_*` constant would silently make the
            /// second unreachable — `from_name` would answer with the first, and
            /// a call could be classified as one tool and dispatched as another.
            /// Rust only warns about that by default; here it must not compile.
            pub fn from_name(name: &str) -> Option<Self> {
                #[deny(unreachable_patterns)]
                match name {
                    $( $wire_name => Some(Self::$variant), )+
                    _ => None,
                }
            }
        }
    };
}

declare_gated_tools! {
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
        WriteNote => TOOL_WRITE_NOTE,
        /// Widens the tool grant set for the rest of the run (`skill_tools.rs`).
        UseSkill => TOOL_USE_SKILL,
        /// Widens the run's write budget (`write_policy.rs`).
        SelectPlaylistVideos => TOOL_SELECT_PLAYLIST_VIDEOS,
        /// Persists a vault profile that steers *future* routing (`youtube_route.rs`).
        ResolveDistilRoute => TOOL_RESOLVE_DISTIL_ROUTE,
        /// Reaches the internet for video metadata.
        FetchVideoInfo => TOOL_FETCH_VIDEO_INFO,
        /// Reaches the internet for captions.
        FetchCaptions => TOOL_FETCH_CAPTIONS,
        /// Spawns a host process and may trigger a binary install.
        TranscribeAudio => TOOL_TRANSCRIBE_AUDIO,
    }
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

impl GatedTool {
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
        //
        // It no longer doubles as the completeness check it was once documented
        // as being. A variant missing from the gated set is now unrepresentable
        // (see `declare_gated_tools!`); an ADDED variant fails this assertion on
        // length, but it fails `reversibility()` with E0004 first.
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
    fn every_registered_tool_is_either_gated_or_on_the_blessed_ungated_list() {
        // The direction `every_gated_tool_name_is_a_registered_tool` does NOT
        // cover, and the one hole `declare_gated_tools!` cannot close by
        // construction. The macro guarantees that a tool in the gated set is
        // reachable; nothing guarantees that a tool which OUGHT to be gated was
        // ever added to it. Someone registering a new `delete_note` tomorrow
        // gets no compile error from the approval module at all — the gate would
        // simply never see it, which is the same outcome as the un-gating bug
        // this change-set exists to close, arrived at from the other side.
        //
        // So the ungated set is written down and blessed here rather than left
        // implicit. Every name below is a read-only vault query, the skill
        // stepper, or the model's own question tool: nothing that writes, fetches
        // or spawns.
        //
        // The classification is an exhaustive `match`, not a list of strings, so
        // registering a new tool does not merely fail this assertion — it stops
        // this file COMPILING (E0004) until someone writes its arm. A `cargo test`
        // that cannot build is the loudest signal available, and unlike a runtime
        // assertion it cannot be filtered out of a run.
        //
        // What goes red: add a variant to `RegisteredTool` and this match is
        // non-exhaustive; classify a gated tool as `Ungated` (or the reverse) and
        // the assertion below fires with its name.
        #[derive(Debug, PartialEq, Eq)]
        enum Expected {
            Gated,
            Ungated,
        }
        const fn expected(tool: RegisteredTool) -> Expected {
            match tool {
                // Read-only vault queries, the skill stepper, and the model's own
                // question tool. Nothing that writes, fetches, or spawns.
                RegisteredTool::ListNotes
                | RegisteredTool::ListFolders
                | RegisteredTool::SearchNotes
                | RegisteredTool::ReadNoteSpan
                | RegisteredTool::SkillStep
                | RegisteredTool::AskUser => Expected::Ungated,
                RegisteredTool::WriteNote
                | RegisteredTool::UseSkill
                | RegisteredTool::SelectPlaylistVideos
                | RegisteredTool::ResolveDistilRoute
                | RegisteredTool::FetchVideoInfo
                | RegisteredTool::FetchCaptions
                | RegisteredTool::TranscribeAudio => Expected::Gated,
            }
        }
        for registered in RegisteredTool::ALL {
            let name = registered.name();
            let actual = if GatedTool::from_name(name).is_some() {
                Expected::Gated
            } else {
                Expected::Ungated
            };
            assert_eq!(
                actual,
                expected(registered),
                "'{name}' is on the wrong side"
            );
        }
    }

    #[test]
    fn the_gated_set_is_exactly_seven_distinct_tools() {
        // Both counts now come from the ONE variant list, so this reddens when
        // the gated set grows or shrinks — it is a "say it out loud" gate on a
        // change to the security surface, not the completeness proof it used to
        // be mistaken for. Distinctness is the second assertion's job: two
        // variants sharing a wire name would make `from_name` unreachable for
        // the later one, which the compiler reports as an unreachable pattern
        // but which this states as a property.
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
