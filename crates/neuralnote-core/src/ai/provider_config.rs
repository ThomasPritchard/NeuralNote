//! AI provider preferences, persisted as JSON in the app config dir.
//!
//! The key itself remains shell-owned in the OS keychain; this core file stores
//! only non-secret routing/model preferences so every client can share the same
//! migration and tolerant-read behaviour.

use crate::ai::{capabilities::ReasoningSupport, DEFAULT_MODEL};
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

/// Ownership token for one reasoning-capability probe. The generation is
/// persisted before provider I/O begins, so it orders probes across processes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReasoningProbeTarget {
    pub provider: ProviderKind,
    pub model: String,
    pub generation: u64,
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
    /// Whether to request reasoning tokens on the answer turn.
    /// `#[serde(default)]` is load-bearing: an existing `ai-config.json` written
    /// before this field existed reads back as `bool::default()` = `false`, so old
    /// installs migrate to "off" for free.
    #[serde(default)]
    pub reasoning: bool,
    /// Cached reasoning/thinking verdict for the selected model. `None` = never probed.
    // TODO(reasoning-cache-newtype): this field and `reasoning_probed_model` are only ever
    // meaningful together — a verdict without the model it was probed against is unusable, and
    // vice versa. `cached_reasoning_support` enforces that pairing at the one read site today,
    // but the two independent `Option`s let the illegal half-set states be constructed. Fold
    // them into a single `Option<ProbedReasoning { model, support }>` to make the invariant
    // unrepresentable. Deferred, not done now: it changes the persisted ai-config.json shape,
    // so it wants a serde migration (flatten or a versioned read) — worth doing before the
    // format has real users, but out of scope for this slice.
    #[serde(default)]
    pub reasoning_support: Option<ReasoningSupport>,
    /// Which model string the cached verdict belongs to. The cache is valid ONLY when this
    /// equals the currently selected model; a mismatch (e.g. after a model upgrade) means the
    /// verdict is stale and must be re-probed. This is what stops a stale `Unsupported` from
    /// outliving a model change. See [`Self::reasoning_support`] for a planned newtype fold.
    #[serde(default)]
    pub reasoning_probed_model: Option<String>,
    /// Monotonic cross-process ownership token for reasoning-capability probes.
    /// A probe result may commit only while this generation and its target still
    /// match. Legacy configs start at zero.
    #[serde(default)]
    pub reasoning_probe_generation: u64,
    /// Stable skill ids the user disabled. An explicit empty list enables every
    /// built-in skill; missing legacy state applies only the compiled-in defaults.
    /// Existing skills remain enabled, while incomplete new skills can ship off.
    #[serde(default = "default_disabled_skills")]
    pub disabled_skills: Vec<String>,
}

fn default_disabled_skills() -> Vec<String> {
    Vec::new()
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            active_provider: None,
            model: DEFAULT_MODEL.to_string(),
            key_configured: false,
            local_model_tag: None,
            reasoning: false,
            reasoning_support: None,
            reasoning_probed_model: None,
            reasoning_probe_generation: 0,
            disabled_skills: default_disabled_skills(),
        }
    }
}

impl ProviderConfig {
    fn reasoning_probe_identity(&self) -> Option<(ProviderKind, String)> {
        Some((
            self.effective_provider()?,
            self.selected_model()?.to_string(),
        ))
    }

    /// Apply a config mutation and invalidate outstanding reasoning probes when
    /// that mutation changes the effective provider/model target. Mutations to
    /// dormant-provider settings and unrelated preferences keep their ownership
    /// generation unchanged.
    pub fn mutate_with_reasoning_probe_invalidation<T>(
        &mut self,
        mutation: impl FnOnce(&mut Self) -> CoreResult<T>,
    ) -> CoreResult<T> {
        let previous_target = self.reasoning_probe_identity();
        let mut candidate = self.clone();
        let result = mutation(&mut candidate)?;
        if candidate.reasoning_probe_identity() != previous_target {
            candidate.invalidate_reasoning_probe()?;
        }
        *self = candidate;
        Ok(result)
    }

    fn invalidate_reasoning_probe(&mut self) -> CoreResult<()> {
        let generation = self.next_reasoning_probe_generation()?;
        self.reasoning_probe_generation = generation;
        self.reasoning_support = None;
        self.reasoning_probed_model = None;
        Ok(())
    }

    fn next_reasoning_probe_generation(&self) -> CoreResult<u64> {
        self.reasoning_probe_generation
            .checked_add(1)
            .ok_or_else(|| {
                CoreError::InvalidContent(
                    "AI reasoning probe generation is exhausted; reset AI settings before retrying"
                        .into(),
                )
            })
    }

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

    /// The model string of the effective provider: OpenRouter uses `model`, Local
    /// uses `local_model_tag`, and no provider has no selected model.
    pub fn selected_model(&self) -> Option<&str> {
        match self.effective_provider()? {
            ProviderKind::OpenRouter => Some(&self.model),
            ProviderKind::Local => self.local_model_tag.as_deref(),
        }
    }

    /// The cached reasoning verdict if it is still valid for the current selected
    /// model; otherwise `Unknown` (never probed, or stale after a model change).
    /// Fail-open by construction.
    pub fn cached_reasoning_support(&self) -> ReasoningSupport {
        match (
            self.selected_model(),
            self.reasoning_probed_model.as_deref(),
            self.reasoning_support,
        ) {
            (Some(current), Some(probed), Some(support)) if current == probed => support,
            _ => ReasoningSupport::Unknown,
        }
    }

    /// Allocate the next persisted ownership token before a provider probe starts.
    /// Returns `None` when there is no complete provider/model target to probe.
    pub fn start_reasoning_probe(&mut self) -> CoreResult<Option<ReasoningProbeTarget>> {
        let Some(provider) = self.effective_provider() else {
            return Ok(None);
        };
        let Some(model) = self.selected_model().map(str::to_owned) else {
            return Ok(None);
        };
        let generation = self.next_reasoning_probe_generation()?;
        self.reasoning_probe_generation = generation;
        Ok(Some(ReasoningProbeTarget {
            provider,
            model,
            generation,
        }))
    }

    /// Apply a completed probe only if no later probe or target change superseded it.
    pub fn apply_reasoning_probe(
        &mut self,
        target: &ReasoningProbeTarget,
        support: ReasoningSupport,
    ) -> bool {
        let target_is_current = self.effective_provider() == Some(target.provider)
            && self.selected_model() == Some(target.model.as_str())
            && self.reasoning_probe_generation == target.generation;
        if !target_is_current {
            return false;
        }
        self.reasoning_support = Some(support);
        self.reasoning_probed_model = Some(target.model.clone());
        true
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
    use crate::ai::{ReasoningSupport, DEFAULT_MODEL, FIXTURE_SKILL_ID};
    use crate::CoreError;
    use std::fs;

    fn default_config() -> ProviderConfig {
        ProviderConfig::default()
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
            reasoning_support: Some(ReasoningSupport::Supported),
            reasoning_probed_model: Some("qwen2.5:7b".into()),
            reasoning_probe_generation: 9,
            disabled_skills: vec![FIXTURE_SKILL_ID.into()],
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
                reasoning_support: None,
                reasoning_probed_model: None,
                reasoning_probe_generation: 0,
                disabled_skills: Vec::new(),
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
    fn new_install_enables_every_built_in_skill() {
        assert!(ProviderConfig::default().disabled_skills.is_empty());
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
                reasoning_support: None,
                reasoning_probed_model: None,
                reasoning_probe_generation: 0,
                disabled_skills: Vec::new(),
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
                reasoning_support: None,
                reasoning_probed_model: None,
                reasoning_probe_generation: 0,
                disabled_skills: Vec::new(),
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
        assert_eq!(config.reasoning_support, None);
        assert_eq!(config.reasoning_probed_model, None);
        assert!(config.disabled_skills.is_empty());
        assert_eq!(config.disabled_skills, default_config().disabled_skills);
        assert_eq!(config.effective_provider(), Some(ProviderKind::OpenRouter));
    }

    #[test]
    fn disabled_skills_round_trip_preserves_explicit_disabled_state() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = default_config();
        config.disabled_skills = vec![FIXTURE_SKILL_ID.into()];

        write_provider_config(dir.path(), &config).unwrap();
        assert_eq!(
            read_provider_config(dir.path()).unwrap().disabled_skills,
            [FIXTURE_SKILL_ID]
        );
    }

    #[test]
    fn explicit_empty_disabled_skills_remains_enabled() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{"model":"openai/gpt-4.1","keyConfigured":true,"disabledSkills":[]}"#,
        )
        .unwrap();
        assert!(read_provider_config(dir.path())
            .unwrap()
            .disabled_skills
            .is_empty());
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
            reasoning_support: None,
            reasoning_probed_model: None,
            reasoning_probe_generation: 0,
            disabled_skills: Vec::new(),
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
            reasoning_support: None,
            reasoning_probed_model: None,
            reasoning_probe_generation: 0,
            disabled_skills: Vec::new(),
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
    fn selected_model_uses_openrouter_model_for_key_configured_install() {
        let config = ProviderConfig {
            model: "openai/gpt-4.1".into(),
            key_configured: true,
            ..default_config()
        };

        assert_eq!(config.selected_model(), Some("openai/gpt-4.1"));
    }

    #[test]
    fn selected_model_uses_local_model_tag_for_local_provider() {
        let config = ProviderConfig {
            active_provider: Some(ProviderKind::Local),
            local_model_tag: Some("qwen2.5:7b".into()),
            ..default_config()
        };

        assert_eq!(config.selected_model(), Some("qwen2.5:7b"));
    }

    #[test]
    fn selected_model_is_none_without_effective_provider() {
        assert_eq!(default_config().selected_model(), None);
    }

    #[test]
    fn probe_generations_are_monotonic_and_only_the_latest_same_target_result_applies() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/current".into(),
            key_configured: true,
            ..default_config()
        };

        let older = config.start_reasoning_probe().unwrap().unwrap();
        let newer = config.start_reasoning_probe().unwrap().unwrap();

        assert_eq!(older.generation, 1);
        assert_eq!(newer.generation, 2);
        assert!(config.apply_reasoning_probe(&newer, ReasoningSupport::Unsupported));
        assert!(!config.apply_reasoning_probe(&older, ReasoningSupport::Supported));
        assert_eq!(
            config.cached_reasoning_support(),
            ReasoningSupport::Unsupported
        );
    }

    #[test]
    fn probe_generation_defaults_for_legacy_config_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{"model":"vendor/current","keyConfigured":true}"#,
        )
        .unwrap();
        let mut config = read_provider_config(dir.path()).unwrap();
        assert_eq!(config.reasoning_probe_generation, 0);

        let target = config.start_reasoning_probe().unwrap().unwrap();
        write_provider_config(dir.path(), &config).unwrap();

        assert_eq!(target.generation, 1);
        assert_eq!(
            read_provider_config(dir.path())
                .unwrap()
                .reasoning_probe_generation,
            1
        );
    }

    #[test]
    fn probe_generation_exhaustion_is_explicit_and_never_wraps() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/current".into(),
            key_configured: true,
            reasoning_probe_generation: u64::MAX,
            ..default_config()
        };

        let error = config.start_reasoning_probe().unwrap_err();

        assert!(matches!(error, CoreError::InvalidContent(_)));
        assert_eq!(config.reasoning_probe_generation, u64::MAX);
    }

    #[test]
    fn effective_target_change_invalidates_probe_ownership_and_cached_verdict() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/a".into(),
            key_configured: true,
            reasoning_support: Some(ReasoningSupport::Supported),
            reasoning_probed_model: Some("vendor/a".into()),
            reasoning_probe_generation: 4,
            ..default_config()
        };

        config
            .mutate_with_reasoning_probe_invalidation(|config| {
                config.model = "vendor/b".into();
                Ok(())
            })
            .unwrap();

        assert_eq!(config.reasoning_probe_generation, 5);
        assert_eq!(config.reasoning_support, None);
        assert_eq!(config.reasoning_probed_model, None);
    }

    #[test]
    fn dormant_provider_and_unrelated_preference_changes_do_not_advance_ownership() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::Local),
            model: "vendor/old".into(),
            key_configured: true,
            local_model_tag: Some("qwen2.5:7b".into()),
            reasoning: false,
            reasoning_support: Some(ReasoningSupport::Supported),
            reasoning_probed_model: Some("qwen2.5:7b".into()),
            reasoning_probe_generation: 4,
            ..default_config()
        };

        config
            .mutate_with_reasoning_probe_invalidation(|config| {
                config.model = "vendor/new".into();
                config.reasoning = true;
                config.disabled_skills.push(FIXTURE_SKILL_ID.into());
                Ok(())
            })
            .unwrap();

        assert_eq!(config.reasoning_probe_generation, 4);
        assert_eq!(config.reasoning_support, Some(ReasoningSupport::Supported));
        assert_eq!(config.reasoning_probed_model.as_deref(), Some("qwen2.5:7b"));
    }

    #[test]
    fn target_change_generation_exhaustion_restores_the_original_config() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/a".into(),
            key_configured: true,
            reasoning_support: Some(ReasoningSupport::Unsupported),
            reasoning_probed_model: Some("vendor/a".into()),
            reasoning_probe_generation: u64::MAX,
            ..default_config()
        };
        let original = config.clone();

        let error = config
            .mutate_with_reasoning_probe_invalidation(|config| {
                config.model = "vendor/b".into();
                Ok(())
            })
            .unwrap_err();

        assert!(matches!(error, CoreError::InvalidContent(_)));
        assert_eq!(config, original);
    }

    #[test]
    fn failed_target_mutation_leaves_the_original_config_untouched() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/a".into(),
            key_configured: true,
            reasoning_probe_generation: 3,
            ..default_config()
        };
        let original = config.clone();

        let error = config
            .mutate_with_reasoning_probe_invalidation(|config| {
                config.model = "vendor/b".into();
                Err::<(), _>(CoreError::InvalidName("rejected mutation".into()))
            })
            .unwrap_err();

        assert!(matches!(error, CoreError::InvalidName(_)));
        assert_eq!(config, original);
    }

    #[test]
    fn provider_change_invalidates_even_when_model_strings_match() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "shared/model".into(),
            key_configured: true,
            local_model_tag: Some("shared/model".into()),
            reasoning_support: Some(ReasoningSupport::Supported),
            reasoning_probed_model: Some("shared/model".into()),
            reasoning_probe_generation: 2,
            ..default_config()
        };

        config
            .mutate_with_reasoning_probe_invalidation(|config| {
                config.active_provider = Some(ProviderKind::Local);
                Ok(())
            })
            .unwrap();

        assert_eq!(config.reasoning_probe_generation, 3);
        assert_eq!(config.cached_reasoning_support(), ReasoningSupport::Unknown);
    }

    #[test]
    fn cached_reasoning_support_returns_valid_model_verdict() {
        let config = ProviderConfig {
            model: "openai/gpt-4.1".into(),
            key_configured: true,
            reasoning_support: Some(ReasoningSupport::Supported),
            reasoning_probed_model: Some("openai/gpt-4.1".into()),
            ..default_config()
        };

        assert_eq!(
            config.cached_reasoning_support(),
            ReasoningSupport::Supported
        );
    }

    #[test]
    fn cached_reasoning_support_is_unknown_after_model_change() {
        let config = ProviderConfig {
            model: "new/model".into(),
            key_configured: true,
            reasoning_support: Some(ReasoningSupport::Unsupported),
            reasoning_probed_model: Some("old/model".into()),
            ..default_config()
        };

        assert_eq!(config.cached_reasoning_support(), ReasoningSupport::Unknown);
    }

    #[test]
    fn cached_reasoning_support_is_unknown_without_verdict() {
        let config = ProviderConfig {
            model: "openai/gpt-4.1".into(),
            key_configured: true,
            reasoning_support: None,
            reasoning_probed_model: Some("openai/gpt-4.1".into()),
            ..default_config()
        };

        assert_eq!(config.cached_reasoning_support(), ReasoningSupport::Unknown);
    }

    #[test]
    fn cached_reasoning_support_is_unknown_without_probed_model() {
        let config = ProviderConfig {
            model: "openai/gpt-4.1".into(),
            key_configured: true,
            reasoning_support: Some(ReasoningSupport::Supported),
            reasoning_probed_model: None,
            ..default_config()
        };

        assert_eq!(config.cached_reasoning_support(), ReasoningSupport::Unknown);
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
            reasoning_support: Some(ReasoningSupport::Supported),
            reasoning_probed_model: Some("qwen2.5:7b".into()),
            reasoning_probe_generation: 7,
            disabled_skills: vec![FIXTURE_SKILL_ID.into()],
        })
        .unwrap();

        assert!(value.get("activeProvider").is_some());
        assert!(value.get("keyConfigured").is_some());
        assert!(value.get("localModelTag").is_some());
        assert_eq!(value.get("reasoning"), Some(&serde_json::json!(true)));
        assert_eq!(
            value.get("reasoningSupport"),
            Some(&serde_json::json!("supported"))
        );
        assert_eq!(
            value.get("reasoningProbedModel"),
            Some(&serde_json::json!("qwen2.5:7b"))
        );
        assert_eq!(
            value.get("reasoningProbeGeneration"),
            Some(&serde_json::json!(7))
        );
        assert_eq!(
            value.get("disabledSkills"),
            Some(&serde_json::json!([FIXTURE_SKILL_ID]))
        );
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
