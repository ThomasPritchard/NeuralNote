use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use neuralnote_core::ai::{requirement_files, RequirementFile, RequirementInstallKind};

/// What one sweep of the app-data requirement directories found.
#[derive(Debug, Default)]
pub(crate) struct RequirementInventory {
    /// Requirements that are present and usable.
    pub(crate) available: BTreeSet<PathBuf>,
    /// Requirements that are present and *not* usable, against the reason. These
    /// are deliberately kept apart from the ones that are simply absent, so the
    /// user is never told a file is missing while it sits in front of them.
    pub(crate) unusable: BTreeMap<PathBuf, String>,
}

/// Inventory only compiled-in requirement filenames under NeuralNote's app-data
/// directories. `symlink_metadata` deliberately avoids following a link out of
/// those trusted roots.
pub(crate) fn take_requirement_inventory(app_data_dir: &Path) -> RequirementInventory {
    let mut inventory = RequirementInventory::default();
    for requirement in requirement_files() {
        let path = app_data_dir
            .join(install_directory(requirement.install_kind))
            .join(requirement.name);
        match requirement_state(&path, requirement) {
            RequirementState::Ready => {
                inventory.available.insert(path);
            }
            // Nothing there at all is the ordinary "not installed yet" state and
            // needs no explanation beyond the one the skill listing already gives.
            RequirementState::Absent => {}
            RequirementState::Unusable(defect) => {
                log::warn!(
                    "'{}' is installed but not usable, so it is not offered: {defect}",
                    requirement.name
                );
                inventory.unusable.insert(path, defect);
            }
        }
    }
    inventory
}

/// The paths that are present and usable, for callers that only need to know
/// whether a requirement is ready.
pub(crate) fn detect_requirement_files(app_data_dir: &Path) -> BTreeSet<PathBuf> {
    take_requirement_inventory(app_data_dir).available
}

fn install_directory(install_kind: RequirementInstallKind) -> &'static str {
    match install_kind {
        RequirementInstallKind::Executable => "bin",
        RequirementInstallKind::Asset => "assets",
    }
}

/// Nothing installed, something installed and fine, or something installed that
/// cannot be used. Keeping the first and last apart is the whole point: only one
/// of them is worth explaining to the user.
enum RequirementState {
    Ready,
    Absent,
    Unusable(String),
}

fn requirement_state(path: &Path, requirement: &RequirementFile) -> RequirementState {
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RequirementState::Absent
        }
        Err(error) => {
            return RequirementState::Unusable(format!("it could not be inspected: {error}"))
        }
    };
    if !metadata.file_type().is_file() {
        return RequirementState::Unusable("it is not a regular file".into());
    }
    match requirement.install_kind {
        RequirementInstallKind::Asset => RequirementState::Ready,
        RequirementInstallKind::Executable => {
            match installed_executable_defect(path, requirement.name) {
                None => RequirementState::Ready,
                Some(defect) => RequirementState::Unusable(defect),
            }
        }
    }
}

/// Why an installed requirement executable cannot be trusted, or `None` when
/// nothing is wrong with it.
///
/// The inventory above and the installer's repair path both read this single
/// verdict, so what the app reports as ready and what it is willing to replace
/// cannot disagree: every reason a *file* is hidden from the inventory is also a
/// reason a fresh install may overwrite it. The one deliberate exception is on
/// the installer's side — it refuses to rename over something that is not a
/// regular file at all, rather than deleting a directory somebody put there.
pub(crate) fn installed_executable_defect(path: &Path, name: &str) -> Option<String> {
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) => return Some(format!("it could not be inspected: {error}")),
    };
    if !metadata.file_type().is_file() {
        return Some("it is not a regular file".into());
    }
    if !is_executable(&metadata) {
        return Some("it is not marked executable".into());
    }
    unlaunchable_reason(path, name)
}

/// Only a requirement compiled on this machine has its libraries checked. A
/// downloaded one is a checksum-pinned, self-contained release; a locally built
/// one is linked against a staging tree the installer deletes the moment the
/// build finishes, so it can be present, executable, and still die in dyld
/// before `main` — which is what made a broken install surface later as
/// "transcription is broken" instead of "the install failed".
#[cfg(target_os = "macos")]
fn unlaunchable_reason(path: &Path, name: &str) -> Option<String> {
    use crate::macho_linkage::{inspect, Linkage};

    if neuralnote_core::ai::lookup_requirement_source_build(name).is_err() {
        return None;
    }
    match inspect(path) {
        Linkage::Resolved => None,
        Linkage::Unresolved(missing) => Some(format!(
            "it needs libraries that are not on this machine: {}",
            missing.join(", ")
        )),
        // Anything unreadable — truncated, foreign, corrupt — counts as broken.
        // A doubt is never reported to the user as health, and because the same
        // verdict drives repair, a file in this state can always be replaced.
        Linkage::Undetermined(detail) => Some(format!("its libraries could not be read: {detail}")),
    }
}

/// Mach-O linkage is a macOS question, and the only locally compiled requirement
/// is built by shelling out to `xcrun`. Elsewhere there is nothing to check.
#[cfg(not(target_os = "macos"))]
fn unlaunchable_reason(_path: &Path, _name: &str) -> Option<String> {
    None
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
#[path = "requirement_detection_tests.rs"]
mod tests;
