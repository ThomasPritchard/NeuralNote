use neuralnote_core::ai::retrieval::{FolderMeta, RetrievalProvider};
use neuralnote_core::ai::{EvidenceSpan, ListOutcome, SearchOutcome};
use neuralnote_core::capture::{CaptureError, VaultProfileIo};
use neuralnote_core::{CoreError, CoreResult};
use std::fs;

pub struct ErrorProfileIo {
    pub fail_load: bool,
    pub fail_save: bool,
}

impl VaultProfileIo for ErrorProfileIo {
    fn load(&self) -> Result<Option<Vec<u8>>, CaptureError> {
        if self.fail_load {
            Err(CaptureError::ProfileInvalid("profile load failed".into()))
        } else {
            Ok(None)
        }
    }

    fn save(&self, _bytes: &[u8]) -> Result<(), CaptureError> {
        if self.fail_save {
            Err(CaptureError::ProfileInvalid("profile save failed".into()))
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Copy)]
pub enum RetrievalFailure {
    Folders,
    Notes,
}

pub struct FailingRetrieval(pub RetrievalFailure);

impl RetrievalProvider for FailingRetrieval {
    fn list_notes(&self, _folder: Option<&str>) -> CoreResult<ListOutcome> {
        if matches!(self.0, RetrievalFailure::Notes) {
            Err(CoreError::Io("note inventory failed".into()))
        } else {
            Ok(ListOutcome {
                notes: Vec::new(),
                skipped: 0,
                truncated: false,
                total: 0,
            })
        }
    }

    fn list_folders(&self) -> CoreResult<Vec<FolderMeta>> {
        if matches!(self.0, RetrievalFailure::Folders) {
            Err(CoreError::Io("folder inventory failed".into()))
        } else {
            Ok(Vec::new())
        }
    }

    fn search_notes(
        &self,
        _query: &str,
        _max_results: usize,
        _folder: Option<&str>,
    ) -> CoreResult<SearchOutcome> {
        Err(CoreError::Io("unused search".into()))
    }

    fn read_note_span(
        &self,
        _rel_path: &str,
        _start_line: u32,
        _end_line: u32,
        _max_bytes: usize,
    ) -> CoreResult<EvidenceSpan> {
        Err(CoreError::Io("unused read".into()))
    }
}

pub fn write_note(vault: &std::path::Path, rel_path: &str) {
    let path = vault.join(rel_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, "# Test note\n").unwrap();
}
