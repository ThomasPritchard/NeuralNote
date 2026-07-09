//! AI provider preferences, persisted as JSON in the app config dir.
//!
//! The key itself remains shell-owned in the OS keychain; this core file stores
//! only non-secret routing/model preferences so every client can share the same
//! migration and tolerant-read behaviour.

use crate::ai::DEFAULT_MODEL;
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use ts_rs::TS;

const AI_CONFIG_FILE: &str = "ai-config.json";
static AI_CONFIG_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ProviderKind {
    OpenRouter,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(default)]
    pub active_provider: Option<ProviderKind>,
    pub model: String,
    pub key_configured: bool,
    #[serde(default)]
    pub local_model_tag: Option<String>,
    /// Whether to request OpenRouter's (billed) reasoning tokens on the answer turn.
    /// `#[serde(default)]` is load-bearing: an existing `ai-config.json` written
    /// before this field existed reads back as `bool::default()` = `false`, so old
    /// installs migrate to "off" for free. OpenRouter-only — the Local (Ollama) path
    /// has no reasoning concept and always sends `false`.
    #[serde(default)]
    pub reasoning: bool,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            active_provider: None,
            model: DEFAULT_MODEL.to_string(),
            key_configured: false,
            local_model_tag: None,
            reasoning: false,
        }
    }
}

impl ProviderConfig {
    /// Bridges old OpenRouter-only installs without rewriting their config on read.
    pub fn effective_provider(&self) -> Option<ProviderKind> {
        if let Some(kind) = self.active_provider {
            Some(kind)
        } else if self.key_configured {
            Some(ProviderKind::OpenRouter)
        } else {
            None
        }
    }
}

pub fn config_file(config_dir: &Path) -> PathBuf {
    config_dir.join(AI_CONFIG_FILE)
}

fn normalized_model(model: &str) -> String {
    let model = model.trim();
    if model.is_empty() {
        DEFAULT_MODEL.to_string()
    } else {
        model.to_string()
    }
}

fn normalize(mut config: ProviderConfig) -> ProviderConfig {
    config.model = normalized_model(&config.model);
    config
}

pub fn read_provider_config(config_dir: &Path) -> CoreResult<ProviderConfig> {
    let path = config_file(config_dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProviderConfig::default());
        }
        Err(e) => {
            return Err(CoreError::Io(format!(
                "could not read AI config at {}: {e}",
                path.display()
            )))
        }
    };

    serde_json::from_str::<ProviderConfig>(&raw)
        .map(normalize)
        .map_err(|e| {
            CoreError::Io(format!(
                "could not parse AI config at {}: {e}",
                path.display()
            ))
        })
}

pub fn write_provider_config(config_dir: &Path, config: &ProviderConfig) -> CoreResult<()> {
    std::fs::create_dir_all(config_dir)
        .map_err(|e| CoreError::Io(format!("could not create AI config dir: {e}")))?;
    let bytes = serde_json::to_vec_pretty(&normalize(config.clone()))
        .map_err(|e| CoreError::Io(format!("could not serialize AI config: {e}")))?;
    let path = config_file(config_dir);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| AI_CONFIG_FILE.into());
    let parent = path.parent().ok_or_else(|| {
        CoreError::Io(format!("AI config path has no parent: {}", path.display()))
    })?;
    let seq = AI_CONFIG_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{file_name}.{}.{seq}.nn-tmp", std::process::id()));

    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(CoreError::Io(format!("could not write AI config: {e}")));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(CoreError::Io(format!("could not replace AI config: {e}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::DEFAULT_MODEL;
    use crate::CoreError;
    use std::fs;

    fn default_config() -> ProviderConfig {
        ProviderConfig {
            active_provider: None,
            model: DEFAULT_MODEL.to_string(),
            key_configured: false,
            local_model_tag: None,
            reasoning: false,
        }
    }

    #[test]
    fn roundtrip_preserves_all_fields() {
        let dir = tempfile::tempdir().unwrap();
        let config = ProviderConfig {
            active_provider: Some(ProviderKind::Local),
            model: " openai/gpt-4.1 ".into(),
            key_configured: true,
            local_model_tag: Some("qwen2.5:7b".into()),
            reasoning: true,
        };

        write_provider_config(dir.path(), &config).unwrap();
        let read = read_provider_config(dir.path()).unwrap();

        assert_eq!(
            read,
            ProviderConfig {
                model: "openai/gpt-4.1".into(),
                ..config
            }
        );
    }

    #[test]
    fn fallible_read_surfaces_corrupt_file_with_path() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(config_file(dir.path()), "{not json").unwrap();

        match read_provider_config(dir.path()).unwrap_err() {
            CoreError::Io(msg) => {
                assert!(msg.contains("could not parse"));
                assert!(msg.contains("ai-config.json"));
            }
            other => panic!("expected CoreError::Io, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn write_provider_config_replaces_config_file_instead_of_writing_through_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let external = dir.path().join("external-target.json");
        fs::write(&external, "do-not-change").unwrap();
        std::os::unix::fs::symlink(&external, config_file(dir.path())).unwrap();

        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: None,
                model: "openai/gpt-4.1".into(),
                key_configured: true,
                local_model_tag: None,
                reasoning: false,
            },
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&external).unwrap(), "do-not-change");
        assert!(!fs::symlink_metadata(config_file(dir.path()))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn absent_config_reads_default_without_creating_file() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(read_provider_config(dir.path()).unwrap(), default_config());
        assert!(!config_file(dir.path()).exists());
    }

    #[test]
    fn write_then_read_normalizes_model() {
        let dir = tempfile::tempdir().unwrap();

        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: None,
                model: "  ".into(),
                key_configured: false,
                local_model_tag: None,
                reasoning: false,
            },
        )
        .unwrap();
        assert_eq!(
            read_provider_config(dir.path()).unwrap().model,
            DEFAULT_MODEL
        );

        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: None,
                model: " openai/gpt-4.1 ".into(),
                key_configured: false,
                local_model_tag: None,
                reasoning: false,
            },
        )
        .unwrap();
        assert_eq!(
            read_provider_config(dir.path()).unwrap().model,
            "openai/gpt-4.1"
        );
    }

    #[test]
    fn old_file_migrates_and_uses_key_configured_bridge() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{"model":"openai/gpt-4.1","keyConfigured":true}"#,
        )
        .unwrap();

        let config = read_provider_config(dir.path()).unwrap();

        assert_eq!(config.active_provider, None);
        assert_eq!(config.model, "openai/gpt-4.1");
        assert!(config.key_configured);
        assert_eq!(config.local_model_tag, None);
        assert_eq!(config.effective_provider(), Some(ProviderKind::OpenRouter));
    }

    #[test]
    fn active_provider_roundtrips_and_wins_without_key() {
        let dir = tempfile::tempdir().unwrap();
        let config = ProviderConfig {
            active_provider: Some(ProviderKind::Local),
            model: DEFAULT_MODEL.to_string(),
            key_configured: false,
            local_model_tag: None,
            reasoning: false,
        };

        write_provider_config(dir.path(), &config).unwrap();
        let read = read_provider_config(dir.path()).unwrap();

        assert_eq!(read.active_provider, Some(ProviderKind::Local));
        assert_eq!(read.effective_provider(), Some(ProviderKind::Local));
    }

    #[test]
    fn local_model_tag_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let config = ProviderConfig {
            active_provider: None,
            model: DEFAULT_MODEL.to_string(),
            key_configured: false,
            local_model_tag: Some("qwen2.5:7b".into()),
            reasoning: false,
        };

        write_provider_config(dir.path(), &config).unwrap();

        assert_eq!(
            read_provider_config(dir.path()).unwrap().local_model_tag,
            Some("qwen2.5:7b".into())
        );
    }

    #[test]
    fn effective_provider_policy_cases() {
        assert_eq!(default_config().effective_provider(), None);

        assert_eq!(
            ProviderConfig {
                key_configured: true,
                ..default_config()
            }
            .effective_provider(),
            Some(ProviderKind::OpenRouter)
        );

        assert_eq!(
            ProviderConfig {
                active_provider: Some(ProviderKind::Local),
                key_configured: true,
                ..default_config()
            }
            .effective_provider(),
            Some(ProviderKind::Local)
        );
    }

    #[test]
    fn serde_uses_camel_case_names() {
        assert_eq!(
            serde_json::to_value(ProviderKind::OpenRouter).unwrap(),
            serde_json::json!("openRouter")
        );

        let value = serde_json::to_value(ProviderConfig {
            active_provider: Some(ProviderKind::Local),
            model: "openai/gpt-4.1".into(),
            key_configured: true,
            local_model_tag: Some("qwen2.5:7b".into()),
            reasoning: true,
        })
        .unwrap();

        assert!(value.get("activeProvider").is_some());
        assert!(value.get("keyConfigured").is_some());
        assert!(value.get("localModelTag").is_some());
        assert_eq!(value.get("reasoning"), Some(&serde_json::json!(true)));
    }

    #[test]
    fn reasoning_defaults_to_false_when_absent_from_file() {
        // The migration guarantee: an `ai-config.json` written before the reasoning
        // field existed must read back as `false` (billed tokens stay off), never fail
        // to parse. `#[serde(default)]` is what makes this true.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{"model":"openai/gpt-4.1","keyConfigured":true}"#,
        )
        .unwrap();

        assert!(!read_provider_config(dir.path()).unwrap().reasoning);
    }

    #[test]
    fn reasoning_flag_round_trips_true_then_false() {
        // The exact persistence `set_reasoning` performs: flip the flag on, then back
        // off, and confirm each state survives a write/read cycle.
        let dir = tempfile::tempdir().unwrap();

        let mut cfg = read_provider_config(dir.path()).unwrap();
        cfg.reasoning = true;
        write_provider_config(dir.path(), &cfg).unwrap();
        assert!(read_provider_config(dir.path()).unwrap().reasoning);

        cfg.reasoning = false;
        write_provider_config(dir.path(), &cfg).unwrap();
        assert!(!read_provider_config(dir.path()).unwrap().reasoning);
    }
}
