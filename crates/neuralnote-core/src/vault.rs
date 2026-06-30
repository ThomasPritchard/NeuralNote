//! Opening and creating vaults. A vault is simply a folder — any folder — which
//! is what makes opening an existing Obsidian vault a zero-migration operation.

use crate::error::{CoreError, CoreResult};
use crate::model::Vault;
use crate::paths::validate_name;
use std::path::Path;

/// Open an existing folder as a vault. Validates that it exists, is a directory,
/// and is readable.
pub fn open_vault(path: &Path) -> CoreResult<Vault> {
    let canon = path
        .canonicalize()
        .map_err(|_| CoreError::NotFound(path.display().to_string()))?;
    if !canon.is_dir() {
        return Err(CoreError::InvalidName(format!(
            "{} is not a folder",
            canon.display()
        )));
    }
    // Prove it's readable now, so failures surface here rather than later.
    std::fs::read_dir(&canon)?;
    Ok(Vault {
        name: vault_name(&canon),
        path: canon.to_string_lossy().into_owned(),
    })
}

/// Create a new vault folder `name` inside `parent`, then open it.
pub fn create_vault(parent: &Path, name: &str) -> CoreResult<Vault> {
    validate_name(name)?;
    let parent_c = parent
        .canonicalize()
        .map_err(|_| CoreError::NotFound(parent.display().to_string()))?;
    let target = parent_c.join(name.trim());
    if target.exists() {
        return Err(CoreError::AlreadyExists(name.to_string()));
    }
    std::fs::create_dir(&target)?;
    open_vault(&target)
}

fn vault_name(canon: &Path) -> String {
    canon
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| canon.to_string_lossy().into_owned())
}
