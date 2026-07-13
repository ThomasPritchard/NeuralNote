//! NeuralNote-owned per-vault template settings and format validation.

use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT};
use crate::config_io::write_json_atomic;
use crate::error::{CoreError, CoreResult};
use crate::paths::ensure_within;

const SETTINGS_FILE: &str = ".neuralnote/template-settings.json";
const MAX_FORMAT_CHARS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TemplateSettings {
    pub folder: String,
    pub date_format: String,
    pub time_format: String,
}

impl Default for TemplateSettings {
    fn default() -> Self {
        Self {
            folder: "Templates".into(),
            date_format: DEFAULT_DATE_FORMAT.into(),
            time_format: DEFAULT_TIME_FORMAT.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TemplateSettingsSource {
    NeuralNote,
    Obsidian,
    Discovery,
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TemplateSettingsStatus {
    pub settings: TemplateSettings,
    pub source: TemplateSettingsSource,
    pub folder_exists: bool,
}

pub fn load_template_settings(root: &Path) -> CoreResult<TemplateSettingsStatus> {
    let root = canonical_root(root)?;
    let path = root.join(SETTINGS_FILE);
    let readable_path = confined_existing_file(&root, &path)?;
    let loaded = match std::fs::read_to_string(&readable_path) {
        Ok(raw) => {
            let settings: TemplateSettings = serde_json::from_str(&raw).map_err(|error| {
                CoreError::Io(format!(
                    "could not parse template settings at {}: {error}",
                    readable_path.display()
                ))
            })?;
            validate_template_settings(&root, &settings)?;
            (settings, TemplateSettingsSource::NeuralNote)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            super::discovery::infer_legacy_template_settings(&root)
        }
        Err(error) => {
            return Err(CoreError::Io(format!(
                "could not read template settings at {}: {error}",
                readable_path.display()
            )));
        }
    };

    status(&root, loaded.0, loaded.1)
}

pub fn save_template_settings(
    root: &Path,
    settings: &TemplateSettings,
) -> CoreResult<TemplateSettingsStatus> {
    let root = canonical_root(root)?;
    validate_template_settings(&root, settings)?;
    let path = settings_file_for_write(&root)?;
    write_json_atomic(&path, settings, "template settings")?;
    status(&root, settings.clone(), TemplateSettingsSource::NeuralNote)
}

pub fn reset_template_settings(root: &Path) -> CoreResult<TemplateSettingsStatus> {
    let root = canonical_root(root)?;
    let path = settings_file_entry(&root)?;
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(CoreError::Io(format!(
                "could not reset template settings at {}: {error}",
                path.display()
            )));
        }
    }
    load_template_settings(&root)
}

pub fn preview_template_format(format: &str, now: DateTime<Local>) -> CoreResult<String> {
    validate_template_format(format)?;
    Ok(super::render::format_moment(format, now))
}

pub fn validate_template_format(format: &str) -> CoreResult<()> {
    if format.chars().count() > MAX_FORMAT_CHARS {
        return Err(CoreError::InvalidName(format!(
            "template format cannot exceed {MAX_FORMAT_CHARS} characters"
        )));
    }
    if format.chars().any(char::is_control) {
        return Err(CoreError::InvalidName(
            "template format cannot contain control characters".into(),
        ));
    }
    let mut in_literal = false;
    for character in format.chars() {
        match character {
            '[' if !in_literal => in_literal = true,
            ']' if in_literal => in_literal = false,
            _ => {}
        }
    }
    if in_literal {
        return Err(CoreError::InvalidName(
            "template format contains an unclosed literal".into(),
        ));
    }
    Ok(())
}

pub(super) fn configured_template_folder(
    root: &Path,
    settings: &TemplateSettings,
) -> CoreResult<Option<PathBuf>> {
    let relative = parse_relative_path(&settings.folder).ok_or_else(|| {
        CoreError::InvalidName("template folder must be a non-empty vault-relative path".into())
    })?;
    let folder = root.join(relative);
    if !folder.exists() {
        return Ok(None);
    }
    let folder = ensure_within(root, &folder)?;
    Ok(folder.is_dir().then_some(folder))
}

pub(super) fn parse_relative_path(raw: &str) -> Option<PathBuf> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return None;
    }

    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => output.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!output.as_os_str().is_empty()).then_some(output)
}

fn validate_template_settings(root: &Path, settings: &TemplateSettings) -> CoreResult<()> {
    validate_template_format(&settings.date_format)?;
    validate_template_format(&settings.time_format)?;
    configured_template_folder(root, settings)?;
    Ok(())
}

fn status(
    root: &Path,
    settings: TemplateSettings,
    source: TemplateSettingsSource,
) -> CoreResult<TemplateSettingsStatus> {
    let folder_exists = configured_template_folder(root, &settings)?.is_some();
    Ok(TemplateSettingsStatus {
        settings,
        source,
        folder_exists,
    })
}

fn canonical_root(root: &Path) -> CoreResult<PathBuf> {
    root.canonicalize()
        .map_err(|error| CoreError::Io(format!("vault root unreadable: {error}")))
}

fn confined_existing_file(root: &Path, path: &Path) -> CoreResult<PathBuf> {
    if path.exists() {
        ensure_within(root, path)
    } else {
        Ok(path.to_path_buf())
    }
}

fn settings_file_for_write(root: &Path) -> CoreResult<PathBuf> {
    let settings_dir = root.join(".neuralnote");
    if !settings_dir.exists() {
        std::fs::create_dir(&settings_dir).map_err(|error| {
            CoreError::Io(format!(
                "could not create template settings directory {}: {error}",
                settings_dir.display()
            ))
        })?;
    }
    let settings_dir = ensure_within(root, &settings_dir)?;
    if !settings_dir.is_dir() {
        return Err(CoreError::Io(format!(
            "template settings directory is not a directory: {}",
            settings_dir.display()
        )));
    }
    Ok(settings_dir.join("template-settings.json"))
}

fn settings_file_entry(root: &Path) -> CoreResult<PathBuf> {
    let settings_dir = root.join(".neuralnote");
    match std::fs::symlink_metadata(&settings_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(settings_dir.join("template-settings.json"));
        }
        Err(error) => {
            return Err(CoreError::Io(format!(
                "could not inspect template settings directory {}: {error}",
                settings_dir.display()
            )));
        }
        Ok(_) => {}
    }
    let settings_dir = ensure_within(root, &settings_dir)?;
    if !settings_dir.is_dir() {
        return Err(CoreError::Io(format!(
            "template settings directory is not a directory: {}",
            settings_dir.display()
        )));
    }
    Ok(settings_dir.join("template-settings.json"))
}
