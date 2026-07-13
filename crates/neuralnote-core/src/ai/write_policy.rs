//! Pure policy and shell seams for model-authored vault writes.
//!
//! Core validates paths, chooses collision-safe names, enforces budgets, and
//! records Undo hashes. A host backend supplies only canonicalise/probe/create-new
//! primitives; the eventual Tauri implementation therefore stays an I/O husk.

use crate::error::{CoreError, CoreResult};
use crate::paths::validate_name;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// Hard write allowance for each selected work item.
pub const WRITES_PER_WORK_ITEM: usize = 8;

/// The note role that drives collision handling and the chat report card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NoteKind {
    Literature,
    Atomic,
    Transcript,
}

/// No-follow state of one leaf beneath an opened parent-directory capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotePathState {
    Missing,
    RegularFile { actual_name: String },
    Other,
}

/// An opened parent-directory capability supplied by the host.
///
/// Implementations must address leaves relative to the already-open directory,
/// never by rejoining its original path. That makes a later symlink swap unable to
/// redirect the operation outside the vault.
pub trait NoteWriteParent: Send + Sync {
    /// Inspect `leaf` without following a final symlink. A regular-file result must
    /// return its stored casing/normalisation in `actual_name`.
    fn probe(&self, leaf: &str) -> CoreResult<NotePathState>;

    /// Publish a complete new file without following a final symlink or replacing
    /// anything. On `Err`, no partial leaf may remain visible.
    fn create_new_all_or_nothing(&self, leaf: &str, content: &str) -> CoreResult<()>;
}

/// A confined parent capability plus the stored path of the directory that was
/// actually opened. Core derives every reported and Undo path from this post-open
/// identity, so an in-vault rename/symlink swap cannot make the ledger lie.
pub struct OpenedNoteParent {
    canonical_path: PathBuf,
    handle: Box<dyn NoteWriteParent>,
}

impl OpenedNoteParent {
    /// Construct a result for the exact directory represented by `handle`.
    pub fn new(canonical_path: PathBuf, handle: Box<dyn NoteWriteParent>) -> Self {
        Self {
            canonical_path,
            handle,
        }
    }

    /// Stored canonical path of the directory represented by the capability.
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
}

/// Minimal create-only filesystem seam supplied by the host.
pub trait NoteWriteBackend: Send + Sync {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf>;

    /// Open `canonical_parent` as a stable directory capability and verify that the
    /// opened directory still resides under `canonical_root`. This second check
    /// closes a rename/symlink race between core's canonicalisation and the open.
    fn open_parent(
        &self,
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent>;
}

/// Explicit fallback for clients that have not wired a note writer.
#[derive(Debug, Default)]
pub struct UnavailableNoteWriter;

impl NoteWriteBackend for UnavailableNoteWriter {
    fn canonicalize(&self, _path: &Path) -> CoreResult<PathBuf> {
        Err(CoreError::Io(
            "skill note writing is not wired in this client yet".into(),
        ))
    }

    fn open_parent(
        &self,
        _canonical_root: &Path,
        _canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        Err(CoreError::Io(
            "skill note writing is not wired in this client yet".into(),
        ))
    }
}

/// Successful policy result. `Existing` is atomic-note deduplication, not a write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteOutcome {
    Created {
        rel_path: String,
        written_kind: NoteKind,
        content_hash: String,
    },
    Existing {
        rel_path: String,
    },
}

/// One create made by the run, retained for content-safe Undo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoEntry {
    pub rel_path: String,
    pub content_hash: String,
}

/// Pure Undo decision after the shell hashes the current on-disk content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UndoCheck {
    Allowed,
    RefusedHashMismatch { expected: String, actual: String },
    NotRecorded,
}

/// Created paths and the exact content hashes the run wrote.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UndoLedger {
    entries: Vec<UndoEntry>,
}

impl UndoLedger {
    pub fn entries(&self) -> &[UndoEntry] {
        &self.entries
    }

    /// Keep only entries that still carry delete authority after a partial Undo.
    pub fn retain_entries(&mut self, mut keep: impl FnMut(&UndoEntry) -> bool) {
        self.entries.retain(|entry| keep(entry));
    }

    pub fn check_hash(&self, rel_path: &str, current_hash: &str) -> UndoCheck {
        let Some(entry) = self.entries.iter().find(|entry| entry.rel_path == rel_path) else {
            return UndoCheck::NotRecorded;
        };
        if entry.content_hash == current_hash {
            UndoCheck::Allowed
        } else {
            UndoCheck::RefusedHashMismatch {
                expected: entry.content_hash.clone(),
                actual: current_hash.to_string(),
            }
        }
    }

    fn record(&mut self, rel_path: String, content_hash: String) {
        self.entries.push(UndoEntry {
            rel_path,
            content_hash,
        });
    }
}

/// Monotonic per-item counters plus the derived run ceiling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteBudget {
    per_item_writes: Vec<usize>,
    total_writes: usize,
    total_cap: usize,
}

impl WriteBudget {
    pub fn new(work_items: usize) -> CoreResult<Self> {
        let total_cap = work_items
            .checked_mul(WRITES_PER_WORK_ITEM)
            .ok_or_else(|| {
                CoreError::InvalidName("work item count overflows the write budget".into())
            })?;
        Ok(Self {
            per_item_writes: vec![0; work_items],
            total_writes: 0,
            total_cap,
        })
    }

    pub fn total_writes(&self) -> usize {
        self.total_writes
    }

    pub fn total_cap(&self) -> usize {
        self.total_cap
    }

    pub fn work_item_count(&self) -> usize {
        self.per_item_writes.len()
    }

    fn ensure_work_items(&mut self, work_items: usize) -> CoreResult<()> {
        if work_items <= self.per_item_writes.len() {
            return Ok(());
        }
        let total_cap = work_items
            .checked_mul(WRITES_PER_WORK_ITEM)
            .ok_or_else(|| {
                CoreError::InvalidName("work item count overflows the write budget".into())
            })?;
        self.per_item_writes
            .try_reserve(work_items - self.per_item_writes.len())
            .map_err(|_| CoreError::Io("could not expand the write budget".into()))?;
        self.per_item_writes.resize(work_items, 0);
        self.total_cap = total_cap;
        Ok(())
    }

    fn ensure_item(&self, work_item: usize) -> CoreResult<()> {
        if work_item >= self.per_item_writes.len() {
            return Err(CoreError::InvalidName(format!(
                "work item {work_item} is outside this run's {} work items",
                self.per_item_writes.len()
            )));
        }
        Ok(())
    }

    fn ensure_available(&self, work_item: usize) -> CoreResult<()> {
        self.ensure_item(work_item)?;
        if self.per_item_writes[work_item] >= WRITES_PER_WORK_ITEM
            || self.total_writes >= self.total_cap
        {
            return Err(CoreError::Conflict(format!(
                "write_note cap exceeded: {WRITES_PER_WORK_ITEM} writes per work item (run cap {} for {} work items)",
                self.total_cap,
                self.per_item_writes.len()
            )));
        }
        Ok(())
    }

    fn record(&mut self, work_item: usize) {
        self.per_item_writes[work_item] += 1;
        self.total_writes += 1;
    }
}

/// Per-run write accounting and Undo state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteSession {
    budget: WriteBudget,
    ledger: UndoLedger,
}

impl WriteSession {
    pub fn new(work_items: usize) -> CoreResult<Self> {
        Ok(Self {
            budget: WriteBudget::new(work_items)?,
            ledger: UndoLedger::default(),
        })
    }

    pub fn budget(&self) -> &WriteBudget {
        &self.budget
    }

    /// Expand the run budget after a validated playlist selection. Existing
    /// counters and Undo authority are preserved; calls never shrink a run.
    pub fn ensure_work_items(&mut self, work_items: usize) -> CoreResult<()> {
        self.budget.ensure_work_items(work_items)
    }

    pub fn ledger(&self) -> &UndoLedger {
        &self.ledger
    }

    pub fn into_ledger(self) -> UndoLedger {
        self.ledger
    }
}

/// Hash content with the vault's existing optimistic-concurrency algorithm.
pub fn note_content_hash(content: &str) -> String {
    crate::note::content_hash(content)
}

/// Validate and perform one create-only note write through `backend`.
#[allow(clippy::too_many_arguments)]
pub fn write_note_policy(
    root: &Path,
    rel_path: &str,
    content: &str,
    kind: NoteKind,
    work_item: usize,
    backend: &dyn NoteWriteBackend,
    session: &mut WriteSession,
) -> CoreResult<WriteOutcome> {
    session.budget.ensure_item(work_item)?;
    let components = validate_note_path(rel_path)?;
    let (opened_parent, actual_parent_rel) =
        resolve_confined_parent(root, rel_path, &components, backend)?;

    let requested_leaf = components.last().expect("validated path has a leaf");
    let mut suffix = 1usize;
    loop {
        let leaf = if suffix == 1 {
            requested_leaf.clone()
        } else {
            suffixed_markdown_name(requested_leaf, suffix)?
        };
        let actual_rel = joined_rel_path(&actual_parent_rel, &leaf);
        match opened_parent.handle.probe(&leaf)? {
            NotePathState::Missing => {}
            NotePathState::RegularFile { actual_name } if kind == NoteKind::Atomic => {
                return Ok(WriteOutcome::Existing {
                    rel_path: joined_rel_path(&actual_parent_rel, &actual_name),
                });
            }
            NotePathState::Other if kind == NoteKind::Atomic => {
                return Err(CoreError::Conflict(format!(
                    "atomic note collision at '{actual_rel}' is not a regular file"
                )));
            }
            NotePathState::RegularFile { .. } | NotePathState::Other => {
                suffix = next_suffix(suffix)?;
                continue;
            }
        }

        session.budget.ensure_available(work_item)?;
        match opened_parent
            .handle
            .create_new_all_or_nothing(&leaf, content)
        {
            Ok(()) => {
                let content_hash = note_content_hash(content);
                session.budget.record(work_item);
                session
                    .ledger
                    .record(actual_rel.clone(), content_hash.clone());
                return Ok(WriteOutcome::Created {
                    rel_path: actual_rel,
                    written_kind: kind,
                    content_hash,
                });
            }
            Err(CoreError::AlreadyExists(_)) if kind == NoteKind::Atomic => {
                match opened_parent.handle.probe(&leaf)? {
                    NotePathState::RegularFile { actual_name } => {
                        return Ok(WriteOutcome::Existing {
                            rel_path: joined_rel_path(&actual_parent_rel, &actual_name),
                        });
                    }
                    NotePathState::Missing => {
                        return Err(CoreError::Conflict(format!(
                        "atomic note collision at '{actual_rel}' disappeared before it could be inspected"
                    )));
                    }
                    NotePathState::Other => {
                        return Err(CoreError::Conflict(format!(
                            "atomic note collision at '{actual_rel}' is not a regular file"
                        )));
                    }
                }
            }
            Err(CoreError::AlreadyExists(_)) => {
                suffix = next_suffix(suffix)?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn resolve_confined_parent(
    root: &Path,
    rel_path: &str,
    components: &[String],
    backend: &dyn NoteWriteBackend,
) -> CoreResult<(OpenedNoteParent, String)> {
    let root_c = backend
        .canonicalize(root)
        .map_err(|error| CoreError::Io(format!("vault root unreadable: {error}")))?;
    let requested_parent_rel = components[..components.len() - 1].join("/");
    let parent = if requested_parent_rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(&requested_parent_rel)
    };
    let parent_c = backend.canonicalize(&parent).map_err(|error| match error {
        CoreError::NotFound(_) => CoreError::NotFound(parent.display().to_string()),
        other => other,
    })?;
    if parent_c != root_c && !parent_c.starts_with(&root_c) {
        return Err(CoreError::OutsideVault(rel_path.to_string()));
    }
    let opened_parent = backend.open_parent(&root_c, &parent_c)?;
    let opened_parent_c = opened_parent.canonical_path();
    if opened_parent_c != root_c && !opened_parent_c.starts_with(&root_c) {
        return Err(CoreError::OutsideVault(rel_path.to_string()));
    }
    let actual_parent_rel = opened_parent_c
        .strip_prefix(&root_c)
        .map_err(|_| CoreError::OutsideVault(rel_path.to_string()))?
        .iter()
        .map(|component| component.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");

    Ok((opened_parent, actual_parent_rel))
}

// TODO(vault-rel-path): unify validate_note_path (write_policy.rs) and validate_undo_rel_path (skills/undo.rs) behind a core VaultRelPath newtype.
fn validate_note_path(rel_path: &str) -> CoreResult<Vec<String>> {
    if rel_path.trim().is_empty()
        || rel_path.starts_with('/')
        || rel_path.starts_with('\\')
        || rel_path.contains('\\')
        || has_windows_drive_prefix(rel_path)
    {
        return Err(CoreError::OutsideVault(rel_path.to_string()));
    }

    let raw_components: Vec<&str> = rel_path.split('/').collect();
    if raw_components
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(CoreError::OutsideVault(rel_path.to_string()));
    }

    for component in &raw_components {
        validate_name(component)?;
        validate_portable_component(component)?;
    }
    let leaf = raw_components
        .last()
        .expect("a non-empty path always has a leaf");
    if !leaf
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("md"))
    {
        return Err(CoreError::InvalidName(
            "write_note rel_path must end in .md".into(),
        ));
    }

    Ok(raw_components.into_iter().map(str::to_string).collect())
}

fn validate_portable_component(component: &str) -> CoreResult<()> {
    if component.starts_with(' ')
        || component.ends_with(['.', ' '])
        || component
            .chars()
            .any(|character| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err(CoreError::InvalidName(format!(
            "'{component}' is not a portable vault path component"
        )));
    }

    // Win32 also recognises device names when followed by extensions and treats
    // the ISO-8859-1 superscript digits as COM/LPT port numbers. Trim a space
    // immediately before the extension so `CON .md` cannot evade that namespace.
    let basename = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end_matches(' ');
    let reserved = matches!(
        basename.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    );
    if reserved {
        return Err(CoreError::InvalidName(format!(
            "'{component}' uses a reserved Windows device name"
        )));
    }
    Ok(())
}

fn joined_rel_path(parent_rel: &str, leaf: &str) -> String {
    if parent_rel.is_empty() {
        leaf.to_string()
    } else {
        format!("{parent_rel}/{leaf}")
    }
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn suffixed_markdown_name(name: &str, suffix: usize) -> CoreResult<String> {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| CoreError::InvalidName(name.to_string()))?;
    Ok(format!("{stem} {suffix}.md"))
}

fn next_suffix(current: usize) -> CoreResult<usize> {
    if current == 1 {
        Ok(2)
    } else {
        current
            .checked_add(1)
            .ok_or_else(|| CoreError::Conflict("note collision suffix overflowed".into()))
    }
}
