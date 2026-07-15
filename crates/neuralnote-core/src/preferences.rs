//! Global, client-independent application preferences.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::config_io::write_json_atomic;
use crate::error::{CoreError, CoreResult};

const PREFERENCES_FILE: &str = "preferences.json";
const MAX_WHATS_NEW_VERSION_BYTES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ThemeId {
    NeuralVioletLight,
    NeuralVioletDark,
    OceanBlueLight,
    OceanBlueDark,
    ForestLight,
    ForestDark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FontScale {
    Small,
    Default,
    Large,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FontFamily {
    Inter,
    AtkinsonHyperlegible,
    SourceSerif4,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppPreferences {
    pub automatic_update_checks: bool,
    pub theme: ThemeId,
    pub font_scale: FontScale,
    pub font_family: FontFamily,
    #[serde(default)]
    pub last_seen_whats_new_version: Option<String>,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            automatic_update_checks: true,
            theme: ThemeId::NeuralVioletDark,
            font_scale: FontScale::Default,
            font_family: FontFamily::Inter,
            last_seen_whats_new_version: None,
        }
    }
}

/// Load outcome kept distinct from I/O failure: corrupt JSON has a safe launch
/// fallback, but the host must surface `recovery_message` persistently and use
/// `recovered_from_corrupt` to suppress background update checks for this launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppPreferencesLoad {
    pub preferences: AppPreferences,
    pub recovered_from_corrupt: bool,
    pub recovery_message: Option<String>,
}

pub fn preferences_file(config_dir: &Path) -> PathBuf {
    config_dir.join(PREFERENCES_FILE)
}

pub fn load_app_preferences(config_dir: &Path) -> CoreResult<AppPreferencesLoad> {
    let path = preferences_file(config_dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AppPreferencesLoad {
                preferences: AppPreferences::default(),
                recovered_from_corrupt: false,
                recovery_message: None,
            });
        }
        Err(error) => {
            return Err(CoreError::Io(format!(
                "could not read app preferences at {}: {error}",
                path.display()
            )));
        }
    };

    let parsed: Result<AppPreferences, String> = serde_json::from_str::<AppPreferences>(&raw)
        .map_err(|error| error.to_string())
        .and_then(|preferences| {
            validate_whats_new_version(preferences.last_seen_whats_new_version.as_deref())?;
            Ok(preferences)
        });

    match parsed {
        Ok(preferences) => Ok(AppPreferencesLoad {
            preferences,
            recovered_from_corrupt: false,
            recovery_message: None,
        }),
        Err(error) => Ok(AppPreferencesLoad {
            preferences: AppPreferences::default(),
            recovered_from_corrupt: true,
            recovery_message: Some(format!(
                "could not parse app preferences at {}: {error}",
                path.display()
            )),
        }),
    }
}

pub fn save_app_preferences(config_dir: &Path, preferences: &AppPreferences) -> CoreResult<()> {
    validate_whats_new_version(preferences.last_seen_whats_new_version.as_deref())
        .map_err(CoreError::InvalidContent)?;
    write_json_atomic(
        &preferences_file(config_dir),
        preferences,
        "app preferences",
    )
}

fn validate_whats_new_version(version: Option<&str>) -> Result<(), String> {
    let Some(version) = version else {
        return Ok(());
    };
    let valid = !version.is_empty()
        && version.len() <= MAX_WHATS_NEW_VERSION_BYTES
        && version.as_bytes()[0].is_ascii_digit()
        && version.contains('.')
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'));
    if valid {
        Ok(())
    } else {
        Err(format!(
            "What's new version must be a bounded version identifier of at most {MAX_WHATS_NEW_VERSION_BYTES} ASCII bytes"
        ))
    }
}
