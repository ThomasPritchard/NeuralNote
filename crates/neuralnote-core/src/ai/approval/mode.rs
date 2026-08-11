//! The global approval mode, its per-tool overrides, and the clamp that makes the
//! global mode a true ceiling (§9.6).

use crate::ai::approval::gated::GatedTool;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// How much the agent may do without asking.
///
/// Variant ORDER IS LOAD-BEARING TWICE: `Default` takes the first variant (the
/// safe one), and the derived `Ord` makes `min(a, b)` mean "the more restrictive
/// of the two", which is how a per-tool override clamps the global mode
/// (§9.6.4). Reordering these silently makes YOLO the default AND inverts the
/// clamp — hence [`the_order_is_most_restrictive_first`](self#tests), which fails
/// loudly if anyone does.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default, TS,
)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ApprovalMode {
    /// Every gated call is asked. The default, and today's behaviour plus a
    /// visible prompt.
    #[default]
    AlwaysAsk,
    /// Eligible calls go to the judge; irreversible and ineligible calls are
    /// still asked, unconditionally, whatever the judge would have said.
    ApproveForMe,
    /// Approves everything, including irreversible operations. The
    /// unconditional-approval list does NOT apply here — that is deliberate
    /// (§9.6.1). Validation, confinement, and budgets still do (§9.6.2).
    Yolo,
}

/// The compiled-in default for a tool with no stored override.
///
/// `AlwaysAsk` for `transcribe_audio`; unconstrained (`Yolo`, the identity for
/// the `min` clamp) for the other six, which therefore inherit the global mode.
///
/// `transcribe_audio` ships pinned because it spawns a host process and may
/// install a binary, which is categorically not what "approve my note writes"
/// means. **The pin holds under `Yolo` too** — it is a per-tool preference at the
/// most restrictive setting, and the clamp below makes overrides win in the
/// restrictive direction regardless of the global mode. A user who genuinely
/// wants it unattended can clear the pin themselves; they cannot get there by
/// accident or by inheritance.
pub const fn compiled_default_override(tool: GatedTool) -> ApprovalMode {
    match tool {
        GatedTool::TranscribeAudio => ApprovalMode::AlwaysAsk,
        GatedTool::WriteNote
        | GatedTool::UseSkill
        | GatedTool::SelectPlaylistVideos
        | GatedTool::ResolveDistilRoute
        | GatedTool::FetchVideoInfo
        | GatedTool::FetchCaptions => ApprovalMode::Yolo,
    }
}

/// The mode actually in force for one tool.
///
/// A tool with no STORED override falls back to its COMPILED default
/// ([`compiled_default_override`]). Storing an override REPLACES the compiled
/// default rather than being clamped by it, so a user who deliberately wants
/// `transcribe_audio` unattended can still get there — they just cannot arrive by
/// accident or by inheritance.
///
/// `min` = more restrictive. Clamping at EVALUATION rather than at write time is
/// deliberate: the preference is judged against whatever the global mode is NOW,
/// so lowering the global can never leave a stale, more-permissive override
/// behind. A stored override that is *less* restrictive than the current global
/// is inert rather than rejected.
pub fn effective_mode(
    global: ApprovalMode,
    overrides: &BTreeMap<String, ApprovalMode>,
    tool: GatedTool,
) -> ApprovalMode {
    let tool_pref = overrides
        .get(tool.name())
        .copied()
        .unwrap_or_else(|| compiled_default_override(tool));
    global.min(tool_pref)
}

/// Keep only overrides whose key is a tool this build gates.
///
/// An unknown key is dropped on read rather than erroring, so a config written by
/// a newer build (with an eighth gated tool) still loads in an older one. The
/// trade is explicit: the older build then rewrites the file without that entry.
pub fn retain_known_tool_overrides(
    overrides: BTreeMap<String, ApprovalMode>,
) -> BTreeMap<String, ApprovalMode> {
    overrides
        .into_iter()
        .filter(|(name, _)| GatedTool::from_name(name).is_some())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::approval::gated::ALL_GATED_TOOLS;

    const ALL_MODES: [ApprovalMode; 3] = [
        ApprovalMode::AlwaysAsk,
        ApprovalMode::ApproveForMe,
        ApprovalMode::Yolo,
    ];

    #[test]
    fn the_default_mode_is_always_ask() {
        assert_eq!(ApprovalMode::default(), ApprovalMode::AlwaysAsk);
    }

    #[test]
    fn the_order_is_most_restrictive_first() {
        // Both `Default` and the `min` clamp read off declaration order, so one
        // ordering assertion guards both. Reorder the variants and this fails
        // loudly rather than silently making YOLO the default.
        assert!(ApprovalMode::AlwaysAsk < ApprovalMode::ApproveForMe);
        assert!(ApprovalMode::ApproveForMe < ApprovalMode::Yolo);
    }

    #[test]
    fn an_override_can_never_widen_permission_across_all_nine_combinations() {
        for global in ALL_MODES {
            for stored in ALL_MODES {
                let overrides = BTreeMap::from([(GatedTool::WriteNote.name().to_string(), stored)]);
                let effective = effective_mode(global, &overrides, GatedTool::WriteNote);
                assert!(
                    effective <= global,
                    "global {global:?} with override {stored:?} produced {effective:?}, \
                     which is MORE permissive than the global ceiling"
                );
                assert_eq!(effective, global.min(stored));
            }
        }
    }

    #[test]
    fn transcribe_audio_stays_pinned_to_always_ask_in_every_global_mode() {
        for global in ALL_MODES {
            assert_eq!(
                effective_mode(global, &BTreeMap::new(), GatedTool::TranscribeAudio),
                ApprovalMode::AlwaysAsk,
                "the process-spawning tool must not inherit {global:?}"
            );
        }
    }

    #[test]
    fn a_deliberate_stored_override_replaces_the_pin_rather_than_being_clamped_by_it() {
        // The pin stops accidental inheritance, not a deliberate choice.
        let overrides = BTreeMap::from([(
            GatedTool::TranscribeAudio.name().to_string(),
            ApprovalMode::Yolo,
        )]);
        assert_eq!(
            effective_mode(ApprovalMode::Yolo, &overrides, GatedTool::TranscribeAudio),
            ApprovalMode::Yolo
        );
        // …and the global is still the ceiling for it.
        assert_eq!(
            effective_mode(
                ApprovalMode::AlwaysAsk,
                &overrides,
                GatedTool::TranscribeAudio
            ),
            ApprovalMode::AlwaysAsk
        );
    }

    #[test]
    fn the_other_six_tools_inherit_the_global_mode_with_no_stored_override() {
        for tool in ALL_GATED_TOOLS {
            if tool == GatedTool::TranscribeAudio {
                continue;
            }
            for global in ALL_MODES {
                assert_eq!(effective_mode(global, &BTreeMap::new(), tool), global);
            }
        }
    }

    #[test]
    fn a_per_tool_always_ask_claws_one_tool_back_under_a_yolo_global() {
        let overrides = BTreeMap::from([(
            GatedTool::WriteNote.name().to_string(),
            ApprovalMode::AlwaysAsk,
        )]);
        assert_eq!(
            effective_mode(ApprovalMode::Yolo, &overrides, GatedTool::WriteNote),
            ApprovalMode::AlwaysAsk
        );
        // Every other tool is untouched by that one override.
        assert_eq!(
            effective_mode(ApprovalMode::Yolo, &overrides, GatedTool::UseSkill),
            ApprovalMode::Yolo
        );
    }

    #[test]
    fn unknown_override_keys_are_dropped_and_known_ones_survive() {
        let stored = BTreeMap::from([
            (
                GatedTool::WriteNote.name().to_string(),
                ApprovalMode::AlwaysAsk,
            ),
            ("a_tool_from_a_newer_build".to_string(), ApprovalMode::Yolo),
            ("search_notes".to_string(), ApprovalMode::Yolo),
        ]);
        let kept = retain_known_tool_overrides(stored);
        assert_eq!(
            kept,
            BTreeMap::from([(
                GatedTool::WriteNote.name().to_string(),
                ApprovalMode::AlwaysAsk
            )])
        );
    }

    #[test]
    fn modes_serialise_as_camel_case() {
        for (mode, expected) in [
            (ApprovalMode::AlwaysAsk, "alwaysAsk"),
            (ApprovalMode::ApproveForMe, "approveForMe"),
            (ApprovalMode::Yolo, "yolo"),
        ] {
            assert_eq!(serde_json::to_value(mode).unwrap(), expected);
            assert_eq!(
                serde_json::from_value::<ApprovalMode>(serde_json::json!(expected)).unwrap(),
                mode
            );
        }
    }
}
