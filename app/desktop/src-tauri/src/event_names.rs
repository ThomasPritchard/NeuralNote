//! Single source of truth for the Rust→webview event names, plus the generator
//! that mirrors them into `app/desktop/src/lib/bindings/events.ts`.
//!
//! These strings are a contract shared with the frontend: the shell `emit`s them,
//! `src/lib/api.ts` `listen`s for them. Previously each side spelled the literal
//! independently, so a typo on one side would silently break the bridge. Now Rust
//! owns the constants and a `#[cfg(test)]` generator writes them to a TS module the
//! frontend imports — the same `cargo test` step that runs the ts-rs type exports,
//! so a changed constant here shows up as an uncommitted `bindings/` diff and the
//! drift check fails the build (never a user).

/// Emitted to the frontend when the vault changes on disk (the frontend debounces
/// and re-reads the tree). Lets external edits — e.g. from Obsidian — show up live.
pub const TREE_CHANGED: &str = "vault://tree-changed";

/// The single event carrying every custom native-menu action to the frontend.
pub const MENU_ACTION: &str = "menu://action";

/// Emitted once after a vault opens when crash-recovery reconciled one or more
/// stranded note-quarantine records (an undo / cancelled-write interrupted by a
/// process kill). Carries the `QuarantineRecoveryReport`; only fired when the
/// report is non-empty, so a clean open stays silent.
pub const QUARANTINE_RECOVERY: &str = "vault://quarantine-recovery";

#[cfg(test)]
mod tests {
    use super::*;

    /// Regenerate `bindings/events.ts` from the Rust constants above. Runs under
    /// `cargo test` alongside the ts-rs type exports and writes into the same
    /// `TS_RS_EXPORT_DIR`. Deterministic: the emitted bytes are a fixed template
    /// with the constant values interpolated, so a clean checkout + `cargo test`
    /// produces zero diff, and a changed constant produces exactly one.
    #[test]
    fn export_event_name_bindings() {
        // Resolve the frontend bindings dir from this crate's manifest — the same
        // directory the ts-rs `#[ts(export)]` types target — so the constants land
        // beside the generated types regardless of the cwd `cargo test` runs from.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/bindings");
        std::fs::create_dir_all(&dir).expect("create bindings dir");

        let contents = format!(
            "// This file was generated from the Rust event-name constants by \
             `cargo test`\n// (app/desktop/src-tauri/src/event_names.rs). Do not \
             edit this file manually.\n\n\
             /** Emitted by the shell when the open vault changes on disk. */\n\
             export const TREE_CHANGED = \"{TREE_CHANGED}\";\n\
             /** Emitted by the native menu for every custom action. */\n\
             export const MENU_ACTION = \"{MENU_ACTION}\";\n\
             /** Emitted after a vault opens when crash-recovery reconciled \
             stranded note quarantines. */\n\
             export const QUARANTINE_RECOVERY = \"{QUARANTINE_RECOVERY}\";\n"
        );

        std::fs::write(dir.join("events.ts"), contents).expect("write events.ts");
    }
}
