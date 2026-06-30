//! The vault domain types — the frozen contract shared with the frontend.
//!
//! Every type serialises to `camelCase` so the TypeScript mirror in
//! `app/desktop/src/lib/types.ts` matches field-for-field. Do not rename a field
//! here without updating that file.

use serde::{Deserialize, Serialize};

/// An opened vault — just a folder on disk, by design. Any folder is a valid
/// vault (that is what makes "open your existing Obsidian vault" zero-migration).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    /// Display name (the folder's final path component).
    pub name: String,
    /// Absolute path to the vault root.
    pub path: String,
}

/// Whether a tree node is a folder or a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Folder,
    File,
}

/// A node in the vault file tree. Folders carry `children`; files carry `ext`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub kind: EntryKind,
    /// Final path component (file or folder name).
    pub name: String,
    /// Absolute path on disk.
    pub path: String,
    /// Path relative to the vault root, `/`-joined (stable id for the UI).
    pub rel_path: String,
    /// Lowercased file extension without the dot (files only; `None` for folders).
    pub ext: Option<String>,
    /// Child nodes (folders only; `None` for files), folders-first then files,
    /// each group sorted case-insensitively by name.
    pub children: Option<Vec<TreeNode>>,
}

/// A note opened in the reader/editor: parsed frontmatter + markdown body, with
/// the full raw file always retained so nothing is ever lost or hidden.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDoc {
    pub path: String,
    pub rel_path: String,
    /// Best-effort title: frontmatter `title`, else first H1, else file stem.
    pub title: String,
    /// Parsed YAML frontmatter as JSON, or `None` if absent/unparseable.
    pub frontmatter: Option<serde_json::Value>,
    /// The raw frontmatter block (between the `---` fences), if present.
    pub frontmatter_raw: Option<String>,
    /// Set (failures are never silent) when a frontmatter block existed but did
    /// not parse — the UI still gets `raw` + `body` to show.
    pub frontmatter_error: Option<String>,
    /// Markdown body with the frontmatter block stripped.
    pub body: String,
    /// The entire file, verbatim — the safety net behind every other field.
    pub raw: String,
    /// Stable content fingerprint at read. Echoed back on save so the backend can
    /// detect an external edit and refuse to clobber it (optimistic concurrency).
    pub content_hash: String,
    /// True for a binary attachment (image, PDF, or any non-`.md`/`.txt` file that
    /// isn't valid UTF-8). The reader shows its "no preview" notice instead of an
    /// error, and `body`/`raw` are empty (binary bytes are never sent across the IPC
    /// boundary as a lossy string). Editing/saving is disabled for these.
    pub binary: bool,
    /// True when a *text* note (`.md`/`.txt`) was not valid UTF-8 and had to be
    /// decoded lossily (e.g. a Windows-1252/Latin-1 note from a migrated vault).
    /// Content is shown rather than hidden, but some bytes became `�` — the reader
    /// surfaces a notice so the degradation is never silent.
    pub lossy_text: bool,
}

/// A recently-opened vault, for the welcome screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVault {
    pub name: String,
    pub path: String,
    /// Unix epoch milliseconds of the last open.
    pub last_opened: i64,
}
