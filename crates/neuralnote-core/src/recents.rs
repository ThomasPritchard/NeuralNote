//! Recent-vaults list, persisted as JSON in the app config dir. This is UI
//! convenience, not vault data — a corrupt file is tolerated (treated as empty)
//! rather than blocking the app.

use crate::error::{CoreError, CoreResult};
use crate::model::{RecentVault, Vault};
use crate::temp_sibling::create_temp_sibling;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::AtomicU64;
use std::time::{SystemTime, UNIX_EPOCH};

const FILE: &str = "recent-vaults.json";
const MAX: usize = 12;

/// This site's own temp-name counter, so a busy recents write never advances the
/// counter another write path is walking.
static RECENTS_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Most-recent-first list of vaults that still exist on disk.
pub fn list_recent_vaults(config_dir: &Path) -> CoreResult<Vec<RecentVault>> {
    let mut list = load(config_dir);
    list.retain(|r| Path::new(&r.path).is_dir());
    list.sort_by_key(|r| std::cmp::Reverse(r.last_opened));
    Ok(list)
}

/// Record (or refresh) a vault as most-recently-opened.
pub fn record_recent_vault(config_dir: &Path, vault: &Vault) -> CoreResult<()> {
    std::fs::create_dir_all(config_dir)?;
    let mut list = load(config_dir);
    list.retain(|r| r.path != vault.path);
    list.insert(
        0,
        RecentVault {
            name: vault.name.clone(),
            path: vault.path.clone(),
            last_opened: now_millis(),
        },
    );
    list.truncate(MAX);
    let json = serde_json::to_string_pretty(&list)
        .map_err(|e| CoreError::Io(format!("could not serialise recents: {e}")))?;
    // Atomic replace (temp + rename), like the note write-path: a crash mid-write
    // can't leave a truncated/corrupt recents file (PA-015). The temp is opened
    // O_EXCL, so a symlink planted on its predictable name is skipped rather than
    // written through (issue #213).
    let target = config_dir.join(FILE);
    let (tmp, mut file) = create_temp_sibling(
        config_dir,
        FILE,
        &RECENTS_TMP_SEQ,
        "could not write the recent-vaults list",
    )?;
    if let Err(e) = file.write_all(json.as_bytes()) {
        drop(file);
        let _ = std::fs::remove_file(&tmp); // don't leak a partial temp
        return Err(e.into());
    }
    drop(file);
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

fn load(config_dir: &Path) -> Vec<RecentVault> {
    let file = config_dir.join(FILE);
    match std::fs::read_to_string(&file) {
        // A corrupt recents file is tolerated (treated as empty) but not silently:
        // log it, so a parse failure that would reset the list leaves a trace
        // rather than vanishing without explanation.
        Ok(data) => serde_json::from_str(&data).unwrap_or_else(|e| {
            log::warn!("recent-vaults.json is unreadable ({e}); treating as empty");
            Vec::new()
        }),
        // A missing file is normal (first run). Any other read error (permissions,
        // I/O) would also reset the list, so surface it rather than swallow it.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            log::warn!("recent-vaults.json could not be read ({e}); treating as empty");
            Vec::new()
        }
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::temp_sibling::MAX_TEMP_ATTEMPTS;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;

    fn vault_at(dir: &Path) -> Vault {
        Vault {
            name: "fixture".into(),
            path: dir.to_string_lossy().into_owned(),
        }
    }

    /// How many consecutive temp names the guard below occupies, starting at
    /// whatever the live counter reads.
    ///
    /// A write walks [`MAX_TEMP_ATTEMPTS`] names from wherever `RECENTS_TMP_SEQ`
    /// stands when it runs, and other tests in this binary move that counter while
    /// the band is being planted. Eight windows wide, the band absorbs seven
    /// windows of that interference and the write's whole window still falls on
    /// squatted names. Exceeding even that is not a false pass: the write would
    /// find a free name and SUCCEED, which is what the guard asserts against.
    const SQUATTED_BAND: u64 = MAX_TEMP_ATTEMPTS as u64 * 8;

    /// Every temp name one `record_recent_vault` call can reach, lowest first.
    fn temp_name_band(config_dir: &Path) -> Vec<PathBuf> {
        let first = RECENTS_TMP_SEQ.load(Ordering::Relaxed);
        (first..first + SQUATTED_BAND)
            .map(|sequence| {
                config_dir.join(format!(".{FILE}.{}.{sequence}.nn-tmp", std::process::id()))
            })
            .collect()
    }

    /// A symlink squatting the temp file a recents write renames into place must
    /// never be opened *through*. The plain `std::fs::write` this path used
    /// followed such a link and truncated whatever it pointed at, outside the
    /// config dir entirely (issue #213).
    ///
    /// Exhaustion is the WITNESS, not merely the outcome: a write gives up only
    /// once every name it can reach is taken, and every name it can reach here is
    /// one of these symlinks — so arriving at that error proves that many links
    /// were offered to `create_new` and refused. Follow one instead and the write
    /// succeeds, having clobbered `outside`.
    #[cfg(unix)]
    #[test]
    fn a_symlink_squatting_the_temp_file_is_never_written_through() {
        use std::os::unix::fs::symlink;

        let config = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), "outside stays intact").unwrap();
        let band = temp_name_band(config.path());
        for name in &band {
            symlink(outside.path(), name).unwrap();
        }

        let result = record_recent_vault(config.path(), &vault_at(vault.path()));

        assert_eq!(
            std::fs::read_to_string(outside.path()).unwrap(),
            "outside stays intact",
            "the recents write was made THROUGH a symlink squatting its temp file"
        );
        let error = result.expect_err(
            "the write found a free temp name, so it was never offered a squatting \
             symlink and this guard proved nothing",
        );
        assert!(
            error
                .to_string()
                .contains("no unique temporary file was available"),
            "unexpected error: {error}"
        );
        assert!(
            std::fs::symlink_metadata(&band[0]).is_ok_and(|meta| meta.file_type().is_symlink()),
            "the squatting symlink was consumed rather than skipped"
        );
        assert!(!config.path().join(FILE).exists());
    }
}
