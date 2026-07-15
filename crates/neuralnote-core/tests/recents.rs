//! Persistence edge cases for the recent-vaults list. The list is UI
//! convenience, so a corrupt or unreadable file is tolerated (treated as empty)
//! — but an actual *write* failure must be surfaced, never swallowed. These
//! tests cover the atomic-write failure branches and the tolerant-read branch.

use std::fs;
use std::path::Path;

use neuralnote_core::model::Vault;
use neuralnote_core::recents::{list_recent_vaults, record_recent_vault};

fn vault_at(dir: &Path) -> Vault {
    Vault {
        name: dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: dir.to_string_lossy().into_owned(),
    }
}

/// True when the filesystem enforces the restrictive permission bits the
/// permission tests rely on (i.e. we are not running as root, which bypasses
/// them).
#[cfg(unix)]
fn permission_restrictions_apply() -> bool {
    use std::os::unix::fs::PermissionsExt;
    let file = tempfile::NamedTempFile::new().unwrap();
    fs::set_permissions(file.path(), fs::Permissions::from_mode(0o000)).unwrap();
    fs::read(file.path()).is_err()
}

#[test]
fn recording_lists_existing_vaults_most_recent_first() {
    let config = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();

    record_recent_vault(config.path(), &vault_at(first.path())).unwrap();
    record_recent_vault(config.path(), &vault_at(second.path())).unwrap();

    let listed = list_recent_vaults(config.path()).unwrap();

    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].path, second.path().to_string_lossy());
    assert_eq!(listed[1].path, first.path().to_string_lossy());
}

#[test]
fn recording_the_same_vault_twice_deduplicates_and_refreshes_it() {
    let config = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();

    record_recent_vault(config.path(), &vault_at(vault.path())).unwrap();
    record_recent_vault(config.path(), &vault_at(vault.path())).unwrap();

    assert_eq!(list_recent_vaults(config.path()).unwrap().len(), 1);
}

#[test]
fn vaults_that_no_longer_exist_on_disk_are_dropped_from_the_list() {
    let config = tempfile::tempdir().unwrap();
    let gone = tempfile::tempdir().unwrap();
    let gone_path = gone.path().to_path_buf();

    record_recent_vault(config.path(), &vault_at(&gone_path)).unwrap();
    drop(gone); // the directory is removed

    assert!(list_recent_vaults(config.path()).unwrap().is_empty());
}

#[test]
fn a_recents_file_that_is_a_directory_is_read_as_empty_and_fails_the_write() {
    let config = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    // A directory where the JSON file belongs: reading it is tolerated (treated as
    // empty), but the atomic rename onto it must fail loudly rather than silently
    // dropping the record.
    let occupied = config.path().join("recent-vaults.json");
    fs::create_dir(&occupied).unwrap();
    fs::write(occupied.join("blocker"), "x").unwrap();

    // The tolerant read path still lets the list be enumerated as empty.
    assert!(list_recent_vaults(config.path()).unwrap().is_empty());

    let error = record_recent_vault(config.path(), &vault_at(vault.path())).unwrap_err();

    assert!(!error.to_string().is_empty());
    // The temp file must not be left behind on the failure path.
    assert!(fs::read_dir(config.path())
        .unwrap()
        .filter_map(Result::ok)
        .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")));
}

#[cfg(unix)]
#[test]
fn a_read_only_config_dir_surfaces_the_temp_write_failure() {
    use std::os::unix::fs::PermissionsExt;

    if !permission_restrictions_apply() {
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    // The directory already exists, so `create_dir_all` succeeds, but writing the
    // atomic temp file into a read-only directory is denied.
    fs::set_permissions(config.path(), fs::Permissions::from_mode(0o555)).unwrap();

    let result = record_recent_vault(config.path(), &vault_at(vault.path()));

    fs::set_permissions(config.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(result.is_err());
}
