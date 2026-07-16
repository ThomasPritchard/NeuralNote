//! Pure vault-structure classification for capture routing.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const MIN_FLAT_ROOT_NOTES: usize = 5;
const MIN_TOPIC_FOLDERS: usize = 2;
const MIN_DATE_FOLDERS: usize = 2;
const MIN_JOHNNY_DECIMAL_AREAS: usize = 2;
const MAX_INVENTORY_PATH_BYTES: usize = 1_024;

/// One vault-relative folder from the host's bounded inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultFolder {
    pub rel_path: String,
    pub note_count: u32,
}

/// One vault-relative note used to select neighbouring convention samples.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultNote {
    pub rel_path: String,
}

/// The host-provided, I/O-free view of a vault used by routing policy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultInventory {
    pub folders: Vec<VaultFolder>,
    pub notes: Vec<VaultNote>,
}

/// A recognised vault organisation scheme. `Unknown` is an intentional result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VaultScheme {
    Para,
    FlatZettelkasten,
    TopicFolders,
    DateBased,
    JohnnyDecimal,
    Unknown,
}

/// Classify a vault conservatively from its folders and notes.
///
/// Conflicting strong signals produce [`VaultScheme::Unknown`], ensuring the
/// caller asks instead of silently imposing the wrong structure.
pub fn detect_vault_scheme(inventory: &VaultInventory) -> VaultScheme {
    let mut signals = Vec::with_capacity(5);

    if is_para(inventory) {
        signals.push(VaultScheme::Para);
    }
    if is_flat_zettelkasten(inventory) {
        signals.push(VaultScheme::FlatZettelkasten);
    }
    if is_date_based(inventory) {
        signals.push(VaultScheme::DateBased);
    }
    if is_johnny_decimal(inventory) {
        signals.push(VaultScheme::JohnnyDecimal);
    }
    if is_topic_folders(inventory) {
        signals.push(VaultScheme::TopicFolders);
    }

    match signals.as_slice() {
        [scheme] => *scheme,
        _ => VaultScheme::Unknown,
    }
}

fn is_para(inventory: &VaultInventory) -> bool {
    ["Projects", "Areas", "Resources", "Archive"]
        .iter()
        .all(|expected| {
            inventory.folders.iter().any(|folder| {
                is_bounded_path(&folder.rel_path)
                    && !folder.rel_path.contains('/')
                    && folder.rel_path.eq_ignore_ascii_case(expected)
            })
        })
}

fn is_flat_zettelkasten(inventory: &VaultInventory) -> bool {
    let valid_notes: Vec<_> = inventory
        .notes
        .iter()
        .filter(|note| is_bounded_path(&note.rel_path))
        .collect();
    if valid_notes.len() < MIN_FLAT_ROOT_NOTES {
        return false;
    }

    let root_notes = valid_notes
        .iter()
        .filter(|note| !note.rel_path.contains('/'))
        .count();

    root_notes >= MIN_FLAT_ROOT_NOTES && root_notes.saturating_mul(4) >= valid_notes.len() * 3
}

fn is_topic_folders(inventory: &VaultInventory) -> bool {
    inventory
        .folders
        .iter()
        .filter(|folder| {
            folder.note_count >= 2
                && is_bounded_path(&folder.rel_path)
                && !folder.rel_path.contains('/')
                && !is_reserved_top_level(&folder.rel_path)
                && parse_johnny_range(&folder.rel_path).is_none()
        })
        .map(|folder| folder.rel_path.to_ascii_lowercase())
        .collect::<BTreeSet<_>>()
        .len()
        >= MIN_TOPIC_FOLDERS
}

fn is_date_based(inventory: &VaultInventory) -> bool {
    inventory
        .folders
        .iter()
        .filter(|folder| is_bounded_path(&folder.rel_path) && is_year_month(&folder.rel_path))
        .map(|folder| folder.rel_path.to_ascii_lowercase())
        .collect::<BTreeSet<_>>()
        .len()
        >= MIN_DATE_FOLDERS
}

fn is_johnny_decimal(inventory: &VaultInventory) -> bool {
    let areas = inventory
        .folders
        .iter()
        .filter_map(|folder| {
            if folder.rel_path.contains('/') || !is_bounded_path(&folder.rel_path) {
                return None;
            }
            parse_johnny_range(&folder.rel_path).map(|range| (folder.rel_path.as_str(), range))
        })
        .filter(|(root, (start, end))| {
            inventory.folders.iter().any(|candidate| {
                let mut components = candidate.rel_path.split('/');
                let Some(parent) = components.next() else {
                    return false;
                };
                let Some(category) = components.next() else {
                    return false;
                };
                components.next().is_none()
                    && parent.eq_ignore_ascii_case(root)
                    && parse_johnny_category(category)
                        .is_some_and(|number| (*start..=*end).contains(&number))
            })
        })
        .count();

    areas >= MIN_JOHNNY_DECIMAL_AREAS
}

fn is_reserved_top_level(path: &str) -> bool {
    [
        "projects",
        "areas",
        "resources",
        "archive",
        "inbox",
        "attachments",
        ".neuralnote",
    ]
    .iter()
    .any(|reserved| path.eq_ignore_ascii_case(reserved))
}

fn is_year_month(path: &str) -> bool {
    let mut components = path.split('/');
    let (Some(year), Some(month), None) = (components.next(), components.next(), components.next())
    else {
        return false;
    };

    year.len() == 4
        && year.bytes().all(|byte| byte.is_ascii_digit())
        && month.len() == 2
        && month.bytes().all(|byte| byte.is_ascii_digit())
        && month
            .parse::<u8>()
            .is_ok_and(|month| (1..=12).contains(&month))
}

fn parse_johnny_range(component: &str) -> Option<(u8, u8)> {
    let (range, label) = component.split_once(' ')?;
    let (start, end) = range.split_once('-')?;
    if label.trim().is_empty()
        || start.len() != 2
        || end.len() != 2
        || !start.bytes().all(|byte| byte.is_ascii_digit())
        || !end.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }

    let start = start.parse().ok()?;
    let end = end.parse().ok()?;
    (start <= end).then_some((start, end))
}

fn parse_johnny_category(component: &str) -> Option<u8> {
    let (number, label) = component.split_once(' ')?;
    if label.trim().is_empty()
        || number.len() != 2
        || !number.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    number.parse().ok()
}

/// A host-supplied inventory path safe to classify against: this boundary's byte
/// cap plus the shared *portable* vault-relative grammar. The grammar already
/// rejects absolute paths, traversal, empty components, separators, and invisible
/// characters; the portable layer additionally refuses the Windows non-portable
/// class (reserved device names, `<>:"|?*`, and the trailing dot/space that could
/// fold toward `..`), keeping this classifier consistent with the write boundary.
fn is_bounded_path(path: &str) -> bool {
    path.len() <= MAX_INVENTORY_PATH_BYTES && crate::paths::parse_portable_rel_path(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_path_rejects_windows_trailing_dot_and_space_components() {
        for path in ["Projects ", "Projects.", "Projects/.. ", "2024/03 "] {
            assert!(
                !is_bounded_path(path),
                "{path:?} must be rejected as a non-portable inventory path"
            );
        }
    }

    #[test]
    fn bounded_path_accepts_legitimate_scheme_folders() {
        for path in [
            "Projects",
            "Areas/Reading",
            "2024/03",
            "10-19 Finance",
            ".neuralnote",
        ] {
            assert!(is_bounded_path(path), "{path:?} must remain a bounded path");
        }
    }
}
