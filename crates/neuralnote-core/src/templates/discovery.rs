//! Template discovery, configuration, and note creation.
//!
//! Locates the vault's template folder (Obsidian config or a fallback scan of
//! well-known folder names), lists and reads template files under the vault
//! sandbox, and seeds a new note with a rendered template. The pure
//! substitution engine lives in the sibling `render` module.

use super::render::{render_template, TemplateContext};
use super::{DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT};
use crate::error::{CoreError, CoreResult};
use crate::model::TemplateInfo;
use crate::paths::{ensure_within, rel_path};
use crate::{entries, note, tree};
use chrono::{DateTime, Local};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

const DEFAULT_TEMPLATE_FOLDER: &str = "Templates";
const FALLBACK_FOLDERS: [&str; 3] = ["Templates", "_templates", "templates"];

#[derive(Debug, Clone)]
struct TemplateSettings {
    folder: PathBuf,
    date_format: String,
    time_format: String,
}

/// List markdown templates in the inferred template folder.
pub fn list_templates(root: &Path) -> CoreResult<Vec<TemplateInfo>> {
    let root = canon_root(root)?;
    let settings = infer_template_settings(&root);
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
    let settings = infer_template_settings(&root);
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
            rel_path(root, &root.join(&settings.folder))
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
    let folder = root.join(&settings.folder);
    if !folder.exists() {
        return Ok(None);
    }
    let folder = ensure_within(root, &folder)?;
    if folder.is_dir() {
        Ok(Some(folder))
    } else {
        Ok(None)
    }
}

fn infer_template_settings(root: &Path) -> TemplateSettings {
    let mut settings = TemplateSettings {
        folder: PathBuf::from(DEFAULT_TEMPLATE_FOLDER),
        date_format: DEFAULT_DATE_FORMAT.to_string(),
        time_format: DEFAULT_TIME_FORMAT.to_string(),
    };

    let config_folder = read_obsidian_template_config(root, &mut settings);
    settings.folder = config_folder
        .or_else(|| discover_top_level_template_folder(root))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_TEMPLATE_FOLDER));
    settings
}

fn read_obsidian_template_config(root: &Path, settings: &mut TemplateSettings) -> Option<PathBuf> {
    let config_path = root.join(".obsidian/templates.json");
    let data = match std::fs::read_to_string(&config_path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!(
                "templates: could not read Obsidian template config {}: {e}",
                config_path.display()
            );
            return None;
        }
    };
    let parsed = match serde_json::from_str::<Value>(&data) {
        Ok(parsed) => parsed,
        Err(e) => {
            log::warn!(
                "templates: could not parse Obsidian template config {}: {e}",
                config_path.display()
            );
            return None;
        }
    };
    let Some(obj) = parsed.as_object() else {
        log::warn!(
            "templates: Obsidian template config {} is not a JSON object",
            config_path.display()
        );
        return None;
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

    obj.get("folder")
        .and_then(Value::as_str)
        .and_then(parse_relative_path)
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

fn parse_relative_path(raw: &str) -> Option<PathBuf> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return None;
    }

    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn is_markdown_path(path: &Path) -> bool {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
    tree::is_markdown_ext(ext.as_deref())
}

fn canon_root(root: &Path) -> CoreResult<PathBuf> {
    root.canonicalize()
        .map_err(|e| CoreError::Io(format!("vault root unreadable: {e}")))
}
