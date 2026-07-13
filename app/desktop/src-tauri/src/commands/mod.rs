//! The Tauri command surface, split by responsibility so neither half grows into
//! a grab-bag: [`vault`] holds the note / tree / search / template / graph CRUD
//! verbs, [`ai`] holds provider config, cited chat, and local-model management.
//!
//! `lib.rs` owns the shared app state and registers each command by its full path
//! in `generate_handler!`; these two submodules are re-exported here so the rest of
//! the crate can reach a command without naming the split.

pub(crate) mod ai;
pub(crate) mod lifecycle;
pub(crate) mod preferences;
pub(crate) mod templates;
pub(crate) mod vault;
pub(crate) mod workspace_state;
