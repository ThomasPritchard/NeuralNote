//! Shared wording and event construction for a skill that could not activate.
//!
//! Lives here rather than in the chat loop so tool dispatch and the orchestrator
//! can emit the same recoverable failure without importing each other.

use crate::ai::events::ChatEvent;
use crate::ai::skills::{missing_required_binary, SkillEnvironment, SkillRegistry};

/// Marker substring the frontend keys activation-failure rendering on.
/// A wording change is a two-site edit; the tripwire is
/// `disabled_fixture_preload_surfaces_a_recoverable_error_without_activation`
/// in `tests/skill_orchestrator.rs`, which asserts the emitted `SkillStep`
/// message contains this constant.
pub const SKILL_ACTIVATION_FAILURE_MARK: &str = "could not be activated";

/// The structured report for a skill that could not be activated. `missing_binary`
/// is the only remedy the UI can offer, and it is derived from the requirement set
/// — never from `message`, so re-wording the sentence cannot disable the remedy.
pub(crate) fn skill_activation_failed(
    id: &str,
    error: &str,
    registry: &SkillRegistry,
    environment: &SkillEnvironment,
) -> ChatEvent {
    let manifest = registry.lookup(id).ok();
    ChatEvent::SkillActivationFailed {
        id: id.to_string(),
        // An id nobody recognises has no name of its own; the id the caller asked
        // for is the only identity there is.
        name: manifest.map_or_else(|| id.to_string(), |manifest| manifest.name.clone()),
        message: activation_failure_message(id, error),
        missing_binary: manifest
            .and_then(|manifest| missing_required_binary(&manifest.requirements, environment)),
    }
}

pub(crate) fn activation_failure_message(id: &str, error: &str) -> String {
    format!("Skill '{id}' {SKILL_ACTIVATION_FAILURE_MARK}: {error} — continuing without it")
}
