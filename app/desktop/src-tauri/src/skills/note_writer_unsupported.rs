//! Fail-closed note-writing seam for platforms without the descriptor-confined backend.

use neuralnote_core::ai::{NoteWriteBackend, OpenedNoteParent, UnavailableNoteWriter};
use neuralnote_core::CoreResult;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Keep the command wiring portable without replacing the Unix capability-based
/// implementation with weaker path-based filesystem operations.
pub(crate) struct RunNoteWriteBackend(UnavailableNoteWriter);

impl RunNoteWriteBackend {
    pub(crate) fn new(_close_signal: Arc<crate::ai::ChatRunCloseSignal>) -> Self {
        Self(UnavailableNoteWriter)
    }
}

impl NoteWriteBackend for RunNoteWriteBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        self.0.canonicalize(path)
    }

    fn open_parent(
        &self,
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        self.0.open_parent(canonical_root, canonical_parent)
    }
}
