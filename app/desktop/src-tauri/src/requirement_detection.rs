use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use neuralnote_core::ai::{requirement_files, RequirementInstallKind};

/// Inventory only compiled-in requirement filenames under NeuralNote's app-data
/// directories. `symlink_metadata` deliberately avoids following a link out of
/// those trusted roots.
pub(crate) fn detect_requirement_files(app_data_dir: &Path) -> BTreeSet<PathBuf> {
    requirement_files()
        .iter()
        .filter_map(|requirement| {
            let directory = match requirement.install_kind {
                RequirementInstallKind::Executable => "bin",
                RequirementInstallKind::Asset => "assets",
            };
            let path = app_data_dir.join(directory).join(requirement.name);
            requirement_is_available(&path, requirement.install_kind).then_some(path)
        })
        .collect()
}

fn requirement_is_available(path: &Path, install_kind: RequirementInstallKind) -> bool {
    let Ok(metadata) = path.symlink_metadata() else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }
    match install_kind {
        RequirementInstallKind::Executable => is_executable(&metadata),
        RequirementInstallKind::Asset => true,
    }
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
