//! Recent-vaults list, persisted as JSON in the app config dir. This is UI
//! convenience, not vault data — a corrupt file is tolerated (treated as empty)
//! rather than blocking the app.

use crate::error::{CoreError, CoreResult};
use crate::model::{RecentVault, Vault};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const FILE: &str = "recent-vaults.json";
const MAX: usize = 12;

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
    // can't leave a truncated/corrupt recents file (PA-015).
    let target = config_dir.join(FILE);
    let tmp = config_dir.join(format!(".{FILE}.{}.tmp", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, json) {
        let _ = std::fs::remove_file(&tmp); // don't leak a partial temp
        return Err(e.into());
    }
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
