//! Template discovery, configuration, and note creation.
//!
//! Locates the vault's template folder (Obsidian config or a fallback scan of
//! well-known folder names), lists and reads template files under the vault
//! sandbox, and seeds a new note with a rendered template. The pure
//! substitution engine lives in the sibling `render` module.

use super::render::{render_template, TemplateContext};
use super::settings::{
    configured_template_folder, load_template_settings, parse_relative_path, TemplateSettings,
    TemplateSettingsSource,
};
use super::{DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT};
use crate::error::{CoreError, CoreResult};
use crate::model::TemplateInfo;
use crate::paths::{ensure_within, rel_path};
use crate::{entries, note, tree};
use chrono::{DateTime, Local};
use serde_json::Value;
use std::path::{Path, PathBuf};

const DEFAULT_TEMPLATE_FOLDER: &str = "Templates";
const FALLBACK_FOLDERS: [&str; 3] = ["Templates", "_templates", "templates"];

/// List markdown templates in the inferred template folder.
pub fn list_templates(root: &Path) -> CoreResult<Vec<TemplateInfo>> {
    let root = canon_root(root)?;
    let settings = load_template_settings(&root)?.settings;
    let Some(folder) = existing_template_folder(&root, &settings)? else {
        return Ok(Vec::new());
    };

    let nodes = tree::read_tree(&folder)?;
    let mut templates = tree::markdown_files(&nodes)
        .into_iter()
        .map(|node| template_info_for(&root, Path::new(&node.path)))
        .collect::<Vec<_>>();
    templates.sort_by(|a, b| {
        a.rel_path
            .to_lowercase()
            .cmp(&b.rel_path.to_lowercase())
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(templates)
}

/// Create a note and optionally seed it with a rendered vault template.
pub fn create_note_from_template(
    root: &Path,
    parent: &Path,
    name: &str,
    template: Option<&str>,
    now: DateTime<Local>,
) -> CoreResult<crate::model::TreeNode> {
    let root = canon_root(root)?;
    let settings = load_template_settings(&root)?.settings;
    let template_content = match template {
        Some(template) => Some(read_template(&root, &settings, template)?),
        None => None,
    };

    let node = entries::create_note(&root, parent, name)?;
    if let Some(template_content) = template_content {
        let title = Path::new(&node.name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| node.name.clone());
        let ctx =
            TemplateContext::with_formats(title, now, settings.date_format, settings.time_format);
        let rendered = render_template(&template_content, &ctx);
        if let Err(e) = note::write_note(&root, Path::new(&node.path), &rendered, None) {
            remove_created_note_after_template_write_failure(Path::new(&node.path));
            return Err(e);
        }
    }
    Ok(node)
}

pub(crate) fn remove_created_note_after_template_write_failure(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!(
            "templates: failed to clean up note after template write error {}: {e}",
            path.display()
        ),
    }
}

fn read_template(root: &Path, settings: &TemplateSettings, template: &str) -> CoreResult<String> {
    let template_path = resolve_template_file(root, settings, template)?;
    let bytes = std::fs::read(&template_path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn resolve_template_file(
    root: &Path,
    settings: &TemplateSettings,
    template: &str,
) -> CoreResult<PathBuf> {
    let Some(folder) = existing_template_folder(root, settings)? else {
        return Err(CoreError::NotFound(format!(
            "template folder not found: {}",
            settings.folder
        )));
    };
    let rel = parse_relative_path(template)
        .ok_or_else(|| CoreError::InvalidName("template path must be vault-relative".into()))?;
    let requested = ensure_within(root, &root.join(rel))?;
    if !requested.starts_with(&folder) {
        return Err(CoreError::InvalidName(format!(
            "template must be inside the template folder: {}",
            rel_path(root, &folder)
        )));
    }
    if !is_markdown_path(&requested) {
        return Err(CoreError::InvalidName(
            "template must be a markdown file".into(),
        ));
    }
    if !requested.is_file() {
        return Err(CoreError::NotFound(format!(
            "template not found: {}",
            rel_path(root, &requested)
        )));
    }
    Ok(requested)
}

fn template_info_for(root: &Path, path: &Path) -> TemplateInfo {
    TemplateInfo {
        rel_path: rel_path(root, path),
        name: path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

fn existing_template_folder(
    root: &Path,
    settings: &TemplateSettings,
) -> CoreResult<Option<PathBuf>> {
    configured_template_folder(root, settings)
}

pub(super) fn infer_legacy_template_settings(
    root: &Path,
) -> (TemplateSettings, TemplateSettingsSource) {
    let mut settings = TemplateSettings {
        folder: DEFAULT_TEMPLATE_FOLDER.into(),
        date_format: DEFAULT_DATE_FORMAT.to_string(),
        time_format: DEFAULT_TIME_FORMAT.to_string(),
    };

    let (config_folder, valid_obsidian_config) = read_obsidian_template_config(root, &mut settings);
    let discovered = discover_top_level_template_folder(root);
    let folder = config_folder.or(discovered.clone());
    settings.folder = folder
        .as_deref()
        .map(path_to_relative_string)
        .unwrap_or_else(|| DEFAULT_TEMPLATE_FOLDER.into());
    let source = if valid_obsidian_config {
        TemplateSettingsSource::Obsidian
    } else if discovered.is_some() {
        TemplateSettingsSource::Discovery
    } else {
        TemplateSettingsSource::Default
    };
    (settings, source)
}

fn read_obsidian_template_config(
    root: &Path,
    settings: &mut TemplateSettings,
) -> (Option<PathBuf>, bool) {
    let requested_config_path = root.join(".obsidian/templates.json");
    let config_path = if requested_config_path.exists() {
        match ensure_within(root, &requested_config_path) {
            Ok(path) => path,
            Err(error) => {
                log::warn!(
                    "templates: refused Obsidian template config outside vault {}: {error}",
                    requested_config_path.display()
                );
                return (None, false);
            }
        }
    } else {
        requested_config_path
    };
    let data = match std::fs::read_to_string(&config_path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (None, false),
        Err(e) => {
            log::warn!(
                "templates: could not read Obsidian template config {}: {e}",
                config_path.display()
            );
            return (None, false);
        }
    };
    let parsed = match serde_json::from_str::<Value>(&data) {
        Ok(parsed) => parsed,
        Err(e) => {
            log::warn!(
                "templates: could not parse Obsidian template config {}: {e}",
                config_path.display()
            );
            return (None, false);
        }
    };
    let Some(obj) = parsed.as_object() else {
        log::warn!(
            "templates: Obsidian template config {} is not a JSON object",
            config_path.display()
        );
        return (None, false);
    };

    if let Some(value) = obj.get("dateFormat").and_then(Value::as_str) {
        if !value.trim().is_empty() {
            settings.date_format = value.to_string();
        }
    }
    if let Some(value) = obj.get("timeFormat").and_then(Value::as_str) {
        if !value.trim().is_empty() {
            settings.time_format = value.to_string();
        }
    }

    (
        obj.get("folder")
            .and_then(Value::as_str)
            .and_then(parse_relative_path),
        true,
    )
}

fn discover_top_level_template_folder(root: &Path) -> Option<PathBuf> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!(
                "templates: could not scan vault root for template folders {}: {e}",
                root.display()
            );
            return None;
        }
    };
    let mut matches = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log::warn!(
                    "templates: could not read a vault root entry while discovering templates in {}: {e}",
                    root.display()
                );
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !FALLBACK_FOLDERS
            .iter()
            .any(|wanted| name.eq_ignore_ascii_case(wanted))
        {
            continue;
        }
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => matches.push(name),
            Ok(_) => {}
            Err(e) => {
                log::warn!(
                    "templates: could not inspect template folder candidate {}: {e}",
                    entry.path().display()
                );
            }
        }
    }
    matches.sort();
    matches.into_iter().next().map(PathBuf::from)
}

fn path_to_relative_string(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn is_markdown_path(path: &Path) -> bool {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
    tree::is_markdown_ext(ext.as_deref())
}

fn canon_root(root: &Path) -> CoreResult<PathBuf> {
    root.canonicalize()
        .map_err(|e| CoreError::Io(format!("vault root unreadable: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// True when the filesystem actually enforces the `0o000`/`0o555` permission
    /// bits the permission tests rely on. Running as root (as some CI images do)
    /// bypasses them, so those tests would see an unexpected success — skip there.
    #[cfg(unix)]
    fn permission_restrictions_apply() -> bool {
        use std::os::unix::fs::PermissionsExt;
        let file = tempfile::NamedTempFile::new().unwrap();
        fs::set_permissions(file.path(), fs::Permissions::from_mode(0o000)).unwrap();
        fs::read(file.path()).is_err()
    }

    #[test]
    fn remove_helper_deletes_an_existing_note_and_ignores_a_missing_one() {
        let vault = tempfile::tempdir().unwrap();
        let present = vault.path().join("half-written.md");
        fs::write(&present, "partial").unwrap();

        remove_created_note_after_template_write_failure(&present);
        // Second call proves the missing-file branch is silent (idempotent cleanup).
        remove_created_note_after_template_write_failure(&present);

        assert!(!present.exists());
    }

    #[test]
    fn remove_helper_survives_a_path_it_cannot_delete() {
        let vault = tempfile::tempdir().unwrap();
        // A non-empty directory cannot be removed with `remove_file`, exercising the
        // "could not clean up" warn branch without ever panicking.
        let dir = vault.path().join("not-a-file");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("child.md"), "x").unwrap();

        remove_created_note_after_template_write_failure(&dir);

        assert!(
            dir.exists(),
            "the directory must be left intact, not removed"
        );
    }

    #[test]
    fn malformed_obsidian_template_config_is_ignored_and_falls_back_to_default() {
        // Invalid JSON, a non-object document, and a config that is a directory all
        // reach a distinct guard in `read_obsidian_template_config`; every one must
        // be refused so the settings fall back to the built-in default folder.
        let invalid_json = |vault: &Path| {
            fs::write(vault.join(".obsidian/templates.json"), "{ not json").unwrap();
        };
        let non_object = |vault: &Path| {
            fs::write(vault.join(".obsidian/templates.json"), "[\"array\"]").unwrap();
        };
        let config_is_a_directory = |vault: &Path| {
            fs::create_dir(vault.join(".obsidian/templates.json")).unwrap();
        };
        let cases: [&dyn Fn(&Path); 3] = [&invalid_json, &non_object, &config_is_a_directory];

        for prepare in cases {
            let vault = tempfile::tempdir().unwrap();
            fs::create_dir(vault.path().join(".obsidian")).unwrap();
            prepare(vault.path());

            let loaded = load_template_settings(vault.path()).unwrap();

            assert_eq!(loaded.source, TemplateSettingsSource::Default);
            assert_eq!(loaded.settings.folder, DEFAULT_TEMPLATE_FOLDER);
            assert!(list_templates(vault.path()).unwrap().is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn obsidian_template_config_symlinked_outside_the_vault_is_refused() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), r#"{"folder":"Escaped"}"#).unwrap();
        fs::create_dir(vault.path().join(".obsidian")).unwrap();
        symlink(
            outside.path(),
            vault.path().join(".obsidian/templates.json"),
        )
        .unwrap();

        let loaded = load_template_settings(vault.path()).unwrap();

        assert_eq!(loaded.source, TemplateSettingsSource::Default);
        assert_eq!(loaded.settings.folder, DEFAULT_TEMPLATE_FOLDER);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_vault_root_yields_no_templates_without_panicking() {
        use std::os::unix::fs::PermissionsExt;

        if !permission_restrictions_apply() {
            return;
        }
        let vault = tempfile::tempdir().unwrap();
        // Execute-but-not-read: `canonicalize` still resolves the path, but the
        // template-folder scan's `read_dir` is denied, hitting the warn-and-continue
        // guard rather than propagating an error.
        fs::set_permissions(vault.path(), fs::Permissions::from_mode(0o111)).unwrap();

        let result = list_templates(vault.path());

        fs::set_permissions(vault.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.unwrap().is_empty());
    }
}
