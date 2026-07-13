use neuralnote_core::ai::{NotePathState, NoteWriteBackend, NoteWriteParent, OpenedNoteParent};
use neuralnote_core::{CoreError, CoreResult};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct FsBackend;

struct FsParent {
    path: PathBuf,
}

impl NoteWriteBackend for FsBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        path.canonicalize().map_err(CoreError::from)
    }

    fn open_parent(
        &self,
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        // This test adapter re-resolves immediately before returning its owned
        // capability. Production shell code must back the same trait with an
        // opened directory handle, as the trait contract requires.
        let reopened = canonical_parent.canonicalize().map_err(CoreError::from)?;
        if reopened != canonical_root && !reopened.starts_with(canonical_root) {
            return Err(CoreError::OutsideVault(
                canonical_parent.display().to_string(),
            ));
        }
        Ok(OpenedNoteParent::new(
            reopened.clone(),
            Box::new(FsParent { path: reopened }),
        ))
    }
}

impl NoteWriteParent for FsParent {
    fn probe(&self, leaf: &str) -> CoreResult<NotePathState> {
        let path = self.path.join(leaf);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(NotePathState::Missing)
            }
            Err(error) => return Err(CoreError::from(error)),
        };
        if !metadata.file_type().is_file() {
            return Ok(NotePathState::Other);
        }

        let resolved = path.canonicalize().map_err(CoreError::from)?;
        for entry in fs::read_dir(&self.path).map_err(CoreError::from)? {
            let entry = entry.map_err(CoreError::from)?;
            if !entry.file_type().map_err(CoreError::from)?.is_file() {
                continue;
            }
            let actual_name = entry.file_name().to_string_lossy().into_owned();
            if actual_name == leaf
                || entry.path().canonicalize().map_err(CoreError::from)? == resolved
            {
                return Ok(NotePathState::RegularFile { actual_name });
            }
        }
        Err(CoreError::NotFound(path.display().to_string()))
    }

    fn create_new_all_or_nothing(&self, leaf: &str, content: &str) -> CoreResult<()> {
        let mut staged = tempfile::NamedTempFile::new_in(&self.path).map_err(CoreError::from)?;
        staged
            .write_all(content.as_bytes())
            .map_err(CoreError::from)?;
        staged.as_file().sync_all().map_err(CoreError::from)?;
        staged
            .persist_noclobber(self.path.join(leaf))
            .map(|_| ())
            .map_err(|error| CoreError::from(error.error))
    }
}
