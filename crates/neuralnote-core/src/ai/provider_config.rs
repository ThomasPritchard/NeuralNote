//! AI provider preferences, persisted as JSON in the app config dir.
//!
//! The key itself remains shell-owned in the OS keychain; this core file stores
//! only non-secret routing/model preferences so every client can share the same
//! migration and tolerant-read behaviour.

use crate::ai::approval::{retain_known_tool_overrides, ApprovalMode, ApprovalPolicy, GatedTool};
use crate::ai::{capabilities::ReasoningSupport, DEFAULT_MODEL};
use crate::error::{CoreError, CoreResult};
use crate::temp_sibling::create_temp_sibling;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use ts_rs::TS;

const AI_CONFIG_FILE: &str = "ai-config.json";

/// This site's own temp-name counter, so a busy AI-config write never advances the
/// counter another write path is walking.
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

/// A reasoning-capability verdict paired with the exact model it was probed
/// against. The two are only meaningful together — a verdict without its model, or
/// a model without its verdict, is unusable — so they travel as one value and the
/// illegal half-set state is unrepresentable. Persisted as the `reasoningProbe`
/// object in `ai-config.json`; `None` on the owning [`ProviderConfig`] field means
/// "never probed".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbedReasoning {
    pub model: String,
    pub support: ReasoningSupport,
}

/// How the user wants this model to reason: whether at all, and — when the
/// model published an effort menu and the user picked from it — at what effort.
///
/// The two travel together because an effort without an opt-in is not a
/// request, and both are one user decision about one model. `effort` is a value
/// the model's own menu offered, stored VERBATIM: never normalised, never
/// invented, and never carried across a model change (see
/// `invalidate_reasoning_probe`).
///
/// Persisted as the `reasoningPreference` object in `ai-config.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningPreference {
    /// Whether to request reasoning tokens at all. Defaults to off, because they
    /// bill as output.
    #[serde(default)]
    pub enabled: bool,
    /// The effort to name on the wire, or `None` to take the model's own default.
    /// Only ever `Some` when the user chose it off a probed menu.
    #[serde(default)]
    pub effort: Option<String>,
}

/// The strict runtime AI-preferences value.
///
/// It carries no serde field attributes: reading goes through the tolerant
/// [`RawProviderConfig`] mirror (which owns every `default`) and writing through
/// [`WireProviderConfig`] (which owns the on-disk shape, legacy mirror
/// included). Both directions are written out by hand and both are exhaustive
/// over this struct, so a field added here fails to compile until each side says
/// what to do with it — the format cannot drift by an attribute nobody noticed,
/// nor by a field nobody wired up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderConfig {
    pub active_provider: Option<ProviderKind>,
    pub model: String,
    pub local_model_tag: Option<String>,
    /// Whether to request reasoning tokens, and at what effort. Folded on read
    /// from whichever shape the file carried — see [`fold_reasoning_preference`].
    pub reasoning_preference: ReasoningPreference,
    /// Cached reasoning verdict paired with the model it belongs to. `None` = never
    /// probed. The pairing is all-or-nothing by construction (see [`ProbedReasoning`]),
    /// so a stale `Unsupported` can never outlive the model it was probed against.
    pub reasoning_probe: Option<ProbedReasoning>,
    /// Monotonic cross-process ownership token for reasoning-capability probes.
    /// A probe result may commit only while this generation and its target still
    /// match. Legacy configs start at zero.
    pub reasoning_probe_generation: u64,
    /// Stable skill ids the user disabled. An explicit empty list enables every
    /// built-in skill; missing legacy state applies only the compiled-in defaults.
    /// Existing skills remain enabled, while incomplete new skills can ship off.
    pub disabled_skills: Vec<String>,
    /// The global approval default. Its `#[serde(default)]` on the raw mirror is
    /// load-bearing exactly as the reasoning opt-in's is: an `ai-config.json`
    /// written before this field existed reads back as `ApprovalMode::default()`
    /// = `AlwaysAsk`, so every existing install migrates to the SAFE mode for
    /// free, with no migration code. Getting this backwards would silently grant
    /// unattended vault writes to every existing install, which is why it has its
    /// own named test.
    pub approval_mode: ApprovalMode,
    /// Per-tool exceptions, keyed by the `TOOL_*` constants. Absent and empty both
    /// mean "every tool takes its COMPILED default" — inherit-the-global for six
    /// of the seven, and `AlwaysAsk` for `transcribe_audio`. So a legacy config
    /// and a deliberately-cleared list are the same thing, and neither one
    /// silently unpins the process-spawning tool. A stored entry REPLACES that
    /// compiled default.
    ///
    /// `BTreeMap`, not `HashMap`: deterministic serialisation order, so the config
    /// file does not churn in diffs and a golden-file test is stable. (This repo
    /// has been bitten by JSON key reordering before.)
    pub tool_approval_overrides: BTreeMap<String, ApprovalMode>,
}

/// The on-disk shape this build writes.
///
/// `reasoningPreference` is authoritative. `reasoning` is written beside it as a
/// legacy MIRROR of `enabled`, derived on every write so the two cannot drift.
///
/// It is written for a build that predates the preference object: without it,
/// such a build would read the opt-in as `false` and silently revert the user to
/// reasoning-off. It is not, however, dead on read — [`RawProviderConfig`] still
/// reads `reasoning` as [`fold_reasoning_preference`]'s legacy input, and that
/// is the entire migration path for every config written before this key
/// existed. What this build never does is read it back out of a file that also
/// carries `reasoningPreference`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireProviderConfig<'a> {
    active_provider: Option<ProviderKind>,
    model: &'a str,
    local_model_tag: Option<&'a str>,
    reasoning: bool,
    reasoning_preference: &'a ReasoningPreference,
    reasoning_probe: Option<&'a ProbedReasoning>,
    reasoning_probe_generation: u64,
    disabled_skills: &'a [String],
    approval_mode: ApprovalMode,
    tool_approval_overrides: &'a BTreeMap<String, ApprovalMode>,
}

impl Serialize for ProviderConfig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        // Destructured, not accessed field-by-field: a new field on
        // `ProviderConfig` then fails to COMPILE here rather than being silently
        // left out of the file. `Deserialize` and `Default` are already
        // exhaustive struct literals, so this is the one direction that could
        // have drifted without the compiler saying so.
        let ProviderConfig {
            active_provider,
            model,
            local_model_tag,
            reasoning_preference,
            reasoning_probe,
            reasoning_probe_generation,
            disabled_skills,
            approval_mode,
            tool_approval_overrides,
        } = self;

        WireProviderConfig {
            active_provider: *active_provider,
            model,
            local_model_tag: local_model_tag.as_deref(),
            reasoning: reasoning_preference.enabled,
            reasoning_preference,
            reasoning_probe: reasoning_probe.as_ref(),
            reasoning_probe_generation: *reasoning_probe_generation,
            disabled_skills,
            approval_mode: *approval_mode,
            tool_approval_overrides,
        }
        .serialize(serializer)
    }
}

fn default_disabled_skills() -> Vec<String> {
    Vec::new()
}

/// Tolerant on-disk mirror of [`ProviderConfig`]. It accepts every shape the format
/// has ever written and is folded into the strict runtime type by the manual
/// `Deserialize` below. Three migrations live here:
///
/// * **Reasoning preference:** the current `reasoningPreference` object is read
///   directly; a file carrying only the older `reasoning` bool is folded into it.
///   The bool KEEPS its type here on purpose — see [`fold_reasoning_preference`].
/// * **Reasoning cache (issue #15):** the current `reasoningProbe` object is read
///   directly; a pre-#15 file carrying the two independent `reasoningSupport` /
///   `reasoningProbedModel` fields is folded into the paired value.
/// * **Key-configured flag (issue #14):** the old `keyConfigured` bool is no longer
///   a field — keychain presence is the authoritative source — so it is simply
///   absent here. serde drops the now-unknown key, so an old file still loads and
///   its model / provider preferences are preserved.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProviderConfig {
    #[serde(default)]
    active_provider: Option<ProviderKind>,
    model: String,
    #[serde(default)]
    local_model_tag: Option<String>,
    #[serde(default)]
    reasoning: bool,
    #[serde(default)]
    reasoning_preference: Option<ReasoningPreference>,
    #[serde(default)]
    reasoning_probe: Option<ProbedReasoning>,
    #[serde(default)]
    reasoning_support: Option<ReasoningSupport>,
    #[serde(default)]
    reasoning_probed_model: Option<String>,
    #[serde(default)]
    reasoning_probe_generation: u64,
    #[serde(default = "default_disabled_skills")]
    disabled_skills: Vec<String>,
    #[serde(default)]
    approval_mode: ApprovalMode,
    #[serde(default)]
    tool_approval_overrides: BTreeMap<String, ApprovalMode>,
}

/// Fold whichever reasoning-preference shape the file carried into the current
/// value. Same "current shape wins" precedence as [`fold_reasoning_probe`]: a
/// present `reasoningPreference` is authoritative, and otherwise the legacy
/// `reasoning` bool becomes the opt-in.
///
/// No effort is recovered from a legacy file, because the concept did not exist
/// there and one is never invented: an effort is only ever a value read off a
/// probed menu (§4.2).
///
/// **The legacy key keeps its `bool` type on `RawProviderConfig`, deliberately.**
/// Reusing `reasoning` for the object would make an object arriving there a hard
/// deserialize error, and that fails the WHOLE parse — an older build reading a
/// newer config would lose the user's provider, model and approval mode in one
/// go. An unknown key is merely dropped, which is the property the new key buys.
fn fold_reasoning_preference(
    current: Option<ReasoningPreference>,
    legacy_enabled: bool,
) -> ReasoningPreference {
    current.unwrap_or(ReasoningPreference {
        enabled: legacy_enabled,
        effort: None,
    })
}

/// Fold whichever reasoning-cache shape the file carried into the paired value. The
/// current `reasoningProbe` wins when present. Otherwise the legacy pair is folded
/// only when BOTH halves are present; a half-populated legacy state (a verdict with
/// no model, or a model with no verdict) is normalized to `None`. That state was
/// already unusable — `cached_reasoning_support` treated it as `Unknown` — so
/// dropping it loses nothing and keeps the fail-open guarantee: an unknown verdict
/// never blocks usage.
fn fold_reasoning_probe(
    paired: Option<ProbedReasoning>,
    legacy_support: Option<ReasoningSupport>,
    legacy_model: Option<String>,
) -> Option<ProbedReasoning> {
    if paired.is_some() {
        return paired;
    }
    match (legacy_model, legacy_support) {
        (Some(model), Some(support)) => Some(ProbedReasoning { model, support }),
        _ => None,
    }
}

impl<'de> Deserialize<'de> for ProviderConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawProviderConfig::deserialize(deserializer)?;
        Ok(ProviderConfig {
            active_provider: raw.active_provider,
            model: raw.model,
            local_model_tag: raw.local_model_tag,
            reasoning_preference: fold_reasoning_preference(
                raw.reasoning_preference,
                raw.reasoning,
            ),
            reasoning_probe: fold_reasoning_probe(
                raw.reasoning_probe,
                raw.reasoning_support,
                raw.reasoning_probed_model,
            ),
            reasoning_probe_generation: raw.reasoning_probe_generation,
            disabled_skills: raw.disabled_skills,
            approval_mode: raw.approval_mode,
            // An UNKNOWN key is dropped on read rather than erroring, so a config
            // written by a newer build (one that gates an eighth tool) still
            // loads in an older one instead of bricking it.
            tool_approval_overrides: retain_known_tool_overrides(raw.tool_approval_overrides),
        })
    }
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            active_provider: None,
            model: DEFAULT_MODEL.to_string(),
            local_model_tag: None,
            reasoning_preference: ReasoningPreference::default(),
            reasoning_probe: None,
            reasoning_probe_generation: 0,
            disabled_skills: default_disabled_skills(),
            approval_mode: ApprovalMode::default(),
            tool_approval_overrides: BTreeMap::new(),
        }
    }
}

impl ProviderConfig {
    /// The approval mode in force for one tool, after the per-tool clamp.
    pub fn effective_approval_mode(&self, tool: GatedTool) -> ApprovalMode {
        crate::ai::approval::effective_mode(self.approval_mode, &self.tool_approval_overrides, tool)
    }

    /// The run policy, resolved against whether the active provider can run the
    /// judge. The local lane cannot (§9.5.2), and that is decided HERE rather
    /// than in the UI: a settings-layer-only guard is one a stale config or a
    /// direct IPC call walks straight through.
    ///
    /// The user's stored preference is **not** overwritten when it is momentarily
    /// unusable — switching back to a cloud provider restores it. Silently
    /// rewriting a stored choice is its own bug.
    pub fn approval_policy(&self, key_present: bool) -> ApprovalPolicy {
        let classifier_available = matches!(
            self.effective_provider(key_present),
            Some(ProviderKind::OpenRouter)
        );
        ApprovalPolicy::new(
            self.approval_mode,
            self.tool_approval_overrides.clone(),
            classifier_available,
        )
    }

    fn reasoning_probe_identity(&self, key_present: bool) -> Option<(ProviderKind, String)> {
        Some((
            self.effective_provider(key_present)?,
            self.selected_model(key_present)?.to_string(),
        ))
    }

    /// Apply a config mutation and invalidate outstanding reasoning probes when the
    /// effective provider/model target changes across it. The key-presence transition
    /// is supplied explicitly (`key_present_before` / `key_present_after`) because the
    /// effective OpenRouter provider is derived from the keychain, not persisted: a
    /// save (absent → present) or clear (present → absent) is a target change even
    /// when no config field moves. Mutations to dormant-provider settings and unrelated
    /// preferences, where presence is constant and no target field moves, keep their
    /// ownership generation unchanged.
    pub fn mutate_with_reasoning_probe_invalidation<T>(
        &mut self,
        key_present_before: bool,
        key_present_after: bool,
        mutation: impl FnOnce(&mut Self) -> CoreResult<T>,
    ) -> CoreResult<T> {
        let previous_target = self.reasoning_probe_identity(key_present_before);
        let mut candidate = self.clone();
        let result = mutation(&mut candidate)?;
        if candidate.reasoning_probe_identity(key_present_after) != previous_target {
            candidate.invalidate_reasoning_probe()?;
        }
        *self = candidate;
        Ok(result)
    }

    /// Drop everything that belonged to the model being left behind: the cached
    /// verdict, and the chosen effort.
    ///
    /// The effort was a value off THIS model's published menu and means nothing
    /// on the next one — §4.2 allows an effort on the wire only when it was read
    /// off a probed menu, so a remembered one from a previous model is exactly
    /// the guess that rule forbids. The opt-in stays: whether to reason at all is
    /// the user's preference, not the model's.
    fn invalidate_reasoning_probe(&mut self) -> CoreResult<()> {
        let generation = self.next_reasoning_probe_generation()?;
        self.reasoning_probe_generation = generation;
        self.reasoning_probe = None;
        self.reasoning_preference.effort = None;
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

    /// The effective provider. An explicit `active_provider` always wins; otherwise
    /// a present OpenRouter key (from the keychain — the authoritative source, passed
    /// in as `key_present`) bridges old OpenRouter-only installs without rewriting
    /// their config on read. No explicit provider and no key means none.
    pub fn effective_provider(&self, key_present: bool) -> Option<ProviderKind> {
        if let Some(kind) = self.active_provider {
            Some(kind)
        } else if key_present {
            Some(ProviderKind::OpenRouter)
        } else {
            None
        }
    }

    /// The model string of the effective provider: OpenRouter uses `model`, Local
    /// uses `local_model_tag`, and no provider has no selected model.
    pub fn selected_model(&self, key_present: bool) -> Option<&str> {
        match self.effective_provider(key_present)? {
            ProviderKind::OpenRouter => Some(&self.model),
            ProviderKind::Local => self.local_model_tag.as_deref(),
        }
    }

    /// The cached reasoning verdict if it is still valid for the current selected
    /// model; otherwise `Unknown` (never probed, or stale after a model change).
    /// Fail-open by construction.
    pub fn cached_reasoning_support(&self, key_present: bool) -> ReasoningSupport {
        match (self.selected_model(key_present), &self.reasoning_probe) {
            (Some(current), Some(probe)) if current == probe.model => probe.support,
            _ => ReasoningSupport::Unknown,
        }
    }

    /// Allocate the next persisted ownership token before a provider probe starts.
    /// Returns `None` when there is no complete provider/model target to probe.
    pub fn start_reasoning_probe(
        &mut self,
        key_present: bool,
    ) -> CoreResult<Option<ReasoningProbeTarget>> {
        let Some(provider) = self.effective_provider(key_present) else {
            return Ok(None);
        };
        let Some(model) = self.selected_model(key_present).map(str::to_owned) else {
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
        key_present: bool,
        target: &ReasoningProbeTarget,
        support: ReasoningSupport,
    ) -> bool {
        let target_is_current = self.effective_provider(key_present) == Some(target.provider)
            && self.selected_model(key_present) == Some(target.model.as_str())
            && self.reasoning_probe_generation == target.generation;
        if !target_is_current {
            return false;
        }
        self.reasoning_probe = Some(ProbedReasoning {
            model: target.model.clone(),
            support,
        });
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
    let (tmp, mut file) = create_temp_sibling(
        parent,
        &file_name,
        &AI_CONFIG_TMP_SEQ,
        "could not write AI config",
    )?;

    if let Err(e) = file.write_all(&bytes) {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(CoreError::Io(format!("could not write AI config: {e}")));
    }
    drop(file);
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
    use crate::temp_sibling::MAX_TEMP_ATTEMPTS;
    use crate::CoreError;
    use std::fs;
    use std::sync::atomic::Ordering;

    fn default_config() -> ProviderConfig {
        ProviderConfig::default()
    }

    fn probed(model: &str, support: ReasoningSupport) -> Option<ProbedReasoning> {
        Some(ProbedReasoning {
            model: model.into(),
            support,
        })
    }

    #[test]
    fn roundtrip_preserves_all_fields() {
        let dir = tempfile::tempdir().unwrap();
        let config = ProviderConfig {
            active_provider: Some(ProviderKind::Local),
            model: " openai/gpt-4.1 ".into(),
            local_model_tag: Some("qwen2.5:7b".into()),
            reasoning_preference: ReasoningPreference {
                enabled: true,
                effort: None,
            },
            reasoning_probe: probed("qwen2.5:7b", ReasoningSupport::Supported),
            reasoning_probe_generation: 9,
            disabled_skills: vec![FIXTURE_SKILL_ID.into()],
            approval_mode: ApprovalMode::Yolo,
            tool_approval_overrides: BTreeMap::from([(
                GatedTool::WriteNote.name().to_string(),
                ApprovalMode::AlwaysAsk,
            )]),
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
    fn a_pre_feature_ai_config_loads_as_always_ask_with_no_overrides() {
        // THE migration test, and it is non-negotiable. Getting this backwards
        // silently grants unattended vault writes to every existing install,
        // which is the single worst outcome available in this phase. The config
        // below is a real pre-feature shape: it has a model, a provider, and a
        // reasoning opt-in, and it has never heard of approval.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{
                "activeProvider": "openRouter",
                "model": "anthropic/claude-sonnet-4.5",
                "reasoning": true,
                "reasoningProbeGeneration": 3
            }"#,
        )
        .unwrap();

        let config = read_provider_config(dir.path()).unwrap();

        assert_eq!(config.approval_mode, ApprovalMode::AlwaysAsk);
        assert!(config.tool_approval_overrides.is_empty());
        // …and every one of the seven tools resolves to asking, not just the
        // stored default. A safe global with an inherited permissive per-tool
        // value would be the same bug wearing a different hat.
        for tool in crate::ai::approval::ALL_GATED_TOOLS {
            assert_eq!(
                config.effective_approval_mode(tool),
                ApprovalMode::AlwaysAsk,
                "{} must migrate to asking",
                tool.name()
            );
        }
        // The rest of the pre-feature config still loads.
        assert!(config.reasoning_preference.enabled);
        assert_eq!(config.reasoning_probe_generation, 3);
    }

    #[test]
    fn an_empty_config_file_also_loads_as_always_ask() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(config_file(dir.path()), r#"{"model":""}"#).unwrap();
        let config = read_provider_config(dir.path()).unwrap();
        assert_eq!(config.approval_mode, ApprovalMode::AlwaysAsk);
        assert!(config.tool_approval_overrides.is_empty());
    }

    #[test]
    fn a_missing_config_file_defaults_to_always_ask() {
        let dir = tempfile::tempdir().unwrap();
        let config = read_provider_config(dir.path()).unwrap();
        assert_eq!(config.approval_mode, ApprovalMode::AlwaysAsk);
    }

    #[test]
    fn an_override_key_from_a_newer_build_is_dropped_rather_than_erroring() {
        // A downgrade after a future tool joins the gated set must not brick the
        // config. The known entry survives; the unknown one is simply not read.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{
                "model": "anthropic/claude-sonnet-4.5",
                "approvalMode": "approveForMe",
                "toolApprovalOverrides": {
                    "write_note": "alwaysAsk",
                    "delete_note": "yolo"
                }
            }"#,
        )
        .unwrap();

        let config = read_provider_config(dir.path()).unwrap();

        assert_eq!(config.approval_mode, ApprovalMode::ApproveForMe);
        assert_eq!(
            config.tool_approval_overrides,
            BTreeMap::from([(
                GatedTool::WriteNote.name().to_string(),
                ApprovalMode::AlwaysAsk
            )])
        );
    }

    #[test]
    fn overrides_serialise_in_a_stable_key_order() {
        // `BTreeMap`, so the file does not churn in diffs on rewrite.
        let config = ProviderConfig {
            tool_approval_overrides: BTreeMap::from([
                (
                    GatedTool::WriteNote.name().to_string(),
                    ApprovalMode::AlwaysAsk,
                ),
                (
                    GatedTool::UseSkill.name().to_string(),
                    ApprovalMode::AlwaysAsk,
                ),
                (
                    GatedTool::FetchCaptions.name().to_string(),
                    ApprovalMode::AlwaysAsk,
                ),
            ]),
            ..ProviderConfig::default()
        };
        let encoded = serde_json::to_string(&config).unwrap();
        let start = encoded.find("toolApprovalOverrides").unwrap();
        assert!(
            encoded[start..].starts_with(
                r#"toolApprovalOverrides":{"fetch_captions":"alwaysAsk","use_skill":"alwaysAsk","write_note":"alwaysAsk"}"#
            ),
            "{encoded}"
        );
    }

    #[test]
    fn the_local_lane_reports_no_classifier_while_keeping_the_stored_preference() {
        // §9.5.2, enforced in Rust. The stored mode is untouched — switching back
        // to a cloud provider restores it — but the policy the run receives says
        // the judge is unavailable, so `ApproveForMe` falls back to asking.
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::Local),
            local_model_tag: Some("qwen3.5:9b".into()),
            approval_mode: ApprovalMode::ApproveForMe,
            ..ProviderConfig::default()
        };
        let local = config.approval_policy(false);
        assert!(!local.classifier_available);
        assert_eq!(local.mode, ApprovalMode::ApproveForMe);
        assert_eq!(config.approval_mode, ApprovalMode::ApproveForMe);

        config.active_provider = Some(ProviderKind::OpenRouter);
        assert!(config.approval_policy(true).classifier_available);
    }

    #[test]
    fn no_configured_provider_reports_no_classifier() {
        let config = ProviderConfig {
            approval_mode: ApprovalMode::ApproveForMe,
            ..ProviderConfig::default()
        };
        assert!(!config.approval_policy(false).classifier_available);
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
                model: "openai/gpt-4.1".into(),
                ..default_config()
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
                model: "  ".into(),
                ..default_config()
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
                model: " openai/gpt-4.1 ".into(),
                ..default_config()
            },
        )
        .unwrap();
        assert_eq!(
            read_provider_config(dir.path()).unwrap().model,
            "openai/gpt-4.1"
        );
    }

    // ── Issue #14: keychain is authoritative; the persisted flag is gone ──────

    #[test]
    fn legacy_key_configured_flag_is_ignored_on_read_and_prefs_are_preserved() {
        // An old file carrying `keyConfigured` still loads: the now-unknown key is
        // dropped and the model / provider preferences beside it survive untouched.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{"model":"openai/gpt-4.1","keyConfigured":true,"localModelTag":"qwen2.5:7b"}"#,
        )
        .unwrap();

        let config = read_provider_config(dir.path()).unwrap();

        assert_eq!(config.active_provider, None);
        assert_eq!(config.model, "openai/gpt-4.1");
        assert_eq!(config.local_model_tag.as_deref(), Some("qwen2.5:7b"));
        assert_eq!(config.reasoning_probe, None);
        assert_eq!(config.disabled_skills, default_config().disabled_skills);
    }

    #[test]
    fn key_configured_is_never_reserialized() {
        // The flag is not a field, so it can never be written back — the persisted
        // shape no longer carries key state at all (keychain owns it).
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{"model":"openai/gpt-4.1","keyConfigured":true}"#,
        )
        .unwrap();

        let config = read_provider_config(dir.path()).unwrap();
        write_provider_config(dir.path(), &config).unwrap();

        let raw = fs::read_to_string(config_file(dir.path())).unwrap();
        assert!(!raw.contains("keyConfigured"));
    }

    #[test]
    fn effective_provider_bridges_openrouter_only_when_a_key_is_present() {
        // Legacy install: no explicit provider. The bridge fires only when the
        // keychain says a key is present — the caller supplies that fact.
        let config = ProviderConfig {
            model: "openai/gpt-4.1".into(),
            ..default_config()
        };

        assert_eq!(
            config.effective_provider(true),
            Some(ProviderKind::OpenRouter)
        );
        assert_eq!(config.effective_provider(false), None);
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
            r#"{"model":"openai/gpt-4.1","disabledSkills":[]}"#,
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
            ..default_config()
        };

        write_provider_config(dir.path(), &config).unwrap();
        let read = read_provider_config(dir.path()).unwrap();

        assert_eq!(read.active_provider, Some(ProviderKind::Local));
        assert_eq!(read.effective_provider(false), Some(ProviderKind::Local));
    }

    #[test]
    fn local_model_tag_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let config = ProviderConfig {
            local_model_tag: Some("qwen2.5:7b".into()),
            ..default_config()
        };

        write_provider_config(dir.path(), &config).unwrap();

        assert_eq!(
            read_provider_config(dir.path()).unwrap().local_model_tag,
            Some("qwen2.5:7b".into())
        );
    }

    #[test]
    fn effective_provider_policy_cases() {
        assert_eq!(default_config().effective_provider(false), None);

        // A present key with no explicit provider bridges to OpenRouter.
        assert_eq!(
            default_config().effective_provider(true),
            Some(ProviderKind::OpenRouter)
        );

        // An explicit provider always wins over the keychain bridge.
        assert_eq!(
            ProviderConfig {
                active_provider: Some(ProviderKind::Local),
                ..default_config()
            }
            .effective_provider(true),
            Some(ProviderKind::Local)
        );
    }

    #[test]
    fn selected_model_uses_openrouter_model_when_key_present() {
        let config = ProviderConfig {
            model: "openai/gpt-4.1".into(),
            ..default_config()
        };

        assert_eq!(config.selected_model(true), Some("openai/gpt-4.1"));
        assert_eq!(config.selected_model(false), None);
    }

    #[test]
    fn selected_model_uses_local_model_tag_for_local_provider() {
        let config = ProviderConfig {
            active_provider: Some(ProviderKind::Local),
            local_model_tag: Some("qwen2.5:7b".into()),
            ..default_config()
        };

        assert_eq!(config.selected_model(false), Some("qwen2.5:7b"));
    }

    #[test]
    fn selected_model_is_none_without_effective_provider() {
        assert_eq!(default_config().selected_model(false), None);
    }

    // ── Issue #15: the reasoning cache is one atomic paired value ─────────────

    #[test]
    fn old_two_field_reasoning_cache_migrates_to_paired_value() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{"model":"openai/gpt-4.1","reasoningSupport":"supported","reasoningProbedModel":"openai/gpt-4.1"}"#,
        )
        .unwrap();

        let config = read_provider_config(dir.path()).unwrap();

        assert_eq!(
            config.reasoning_probe,
            probed("openai/gpt-4.1", ReasoningSupport::Supported)
        );
    }

    #[test]
    fn half_populated_legacy_reasoning_cache_normalizes_to_none() {
        // A verdict with no model, or a model with no verdict, was always unusable.
        // Both halves-only shapes normalize to `None` — fail open, never blocking.
        let dir = tempfile::tempdir().unwrap();

        fs::write(
            config_file(dir.path()),
            r#"{"model":"openai/gpt-4.1","reasoningSupport":"unsupported"}"#,
        )
        .unwrap();
        assert_eq!(
            read_provider_config(dir.path()).unwrap().reasoning_probe,
            None
        );

        fs::write(
            config_file(dir.path()),
            r#"{"model":"openai/gpt-4.1","reasoningProbedModel":"openai/gpt-4.1"}"#,
        )
        .unwrap();
        assert_eq!(
            read_provider_config(dir.path()).unwrap().reasoning_probe,
            None
        );
    }

    #[test]
    fn paired_reasoning_probe_serializes_without_legacy_fields() {
        let dir = tempfile::tempdir().unwrap();
        let config = ProviderConfig {
            model: "openai/gpt-4.1".into(),
            reasoning_probe: probed("openai/gpt-4.1", ReasoningSupport::Supported),
            ..default_config()
        };

        write_provider_config(dir.path(), &config).unwrap();

        let raw = fs::read_to_string(config_file(dir.path())).unwrap();
        assert!(raw.contains("reasoningProbe"));
        assert!(!raw.contains("reasoningSupport"));
        assert!(!raw.contains("reasoningProbedModel"));
        assert_eq!(read_provider_config(dir.path()).unwrap(), config);
    }

    #[test]
    fn new_reasoning_probe_shape_wins_over_legacy_fields_when_both_present() {
        // A file written mid-migration could carry both shapes; the paired value is
        // authoritative and the stray legacy fields are ignored.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{"model":"openai/gpt-4.1","reasoningProbe":{"model":"new/model","support":"supported"},"reasoningSupport":"unsupported","reasoningProbedModel":"old/model"}"#,
        )
        .unwrap();

        assert_eq!(
            read_provider_config(dir.path()).unwrap().reasoning_probe,
            probed("new/model", ReasoningSupport::Supported)
        );
    }

    #[test]
    fn probe_generations_are_monotonic_and_only_the_latest_same_target_result_applies() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/current".into(),
            ..default_config()
        };

        let older = config.start_reasoning_probe(true).unwrap().unwrap();
        let newer = config.start_reasoning_probe(true).unwrap().unwrap();

        assert_eq!(older.generation, 1);
        assert_eq!(newer.generation, 2);
        assert!(config.apply_reasoning_probe(true, &newer, ReasoningSupport::Unsupported));
        assert!(!config.apply_reasoning_probe(true, &older, ReasoningSupport::Supported));
        assert_eq!(
            config.cached_reasoning_support(true),
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

        let target = config.start_reasoning_probe(true).unwrap().unwrap();
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
            reasoning_probe_generation: u64::MAX,
            ..default_config()
        };

        let error = config.start_reasoning_probe(true).unwrap_err();

        assert!(matches!(error, CoreError::InvalidContent(_)));
        assert_eq!(config.reasoning_probe_generation, u64::MAX);
    }

    #[test]
    fn effective_target_change_invalidates_probe_ownership_and_cached_verdict() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/a".into(),
            reasoning_probe: probed("vendor/a", ReasoningSupport::Supported),
            reasoning_probe_generation: 4,
            ..default_config()
        };

        config
            .mutate_with_reasoning_probe_invalidation(true, true, |config| {
                config.model = "vendor/b".into();
                Ok(())
            })
            .unwrap();

        assert_eq!(config.reasoning_probe_generation, 5);
        assert_eq!(config.reasoning_probe, None);
    }

    #[test]
    fn key_presence_change_invalidates_the_probe_even_when_no_field_moves() {
        // Clearing the OpenRouter key (present → absent) changes the effective
        // provider from OpenRouter to none, so the cached verdict must be invalidated
        // even though the empty mutation touches no config field.
        let mut config = ProviderConfig {
            model: "vendor/a".into(),
            reasoning_probe: probed("vendor/a", ReasoningSupport::Supported),
            reasoning_probe_generation: 4,
            ..default_config()
        };

        config
            .mutate_with_reasoning_probe_invalidation(true, false, |_config| Ok(()))
            .unwrap();

        assert_eq!(config.reasoning_probe_generation, 5);
        assert_eq!(config.reasoning_probe, None);
    }

    #[test]
    fn dormant_provider_and_unrelated_preference_changes_do_not_advance_ownership() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::Local),
            model: "vendor/old".into(),
            local_model_tag: Some("qwen2.5:7b".into()),
            reasoning_preference: ReasoningPreference::default(),
            reasoning_probe: probed("qwen2.5:7b", ReasoningSupport::Supported),
            reasoning_probe_generation: 4,
            ..default_config()
        };

        config
            .mutate_with_reasoning_probe_invalidation(true, true, |config| {
                config.model = "vendor/new".into();
                config.reasoning_preference.enabled = true;
                config.disabled_skills.push(FIXTURE_SKILL_ID.into());
                Ok(())
            })
            .unwrap();

        assert_eq!(config.reasoning_probe_generation, 4);
        assert_eq!(
            config.reasoning_probe,
            probed("qwen2.5:7b", ReasoningSupport::Supported)
        );
    }

    #[test]
    fn target_change_generation_exhaustion_restores_the_original_config() {
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/a".into(),
            reasoning_probe: probed("vendor/a", ReasoningSupport::Unsupported),
            reasoning_probe_generation: u64::MAX,
            ..default_config()
        };
        let original = config.clone();

        let error = config
            .mutate_with_reasoning_probe_invalidation(true, true, |config| {
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
            reasoning_probe_generation: 3,
            ..default_config()
        };
        let original = config.clone();

        let error = config
            .mutate_with_reasoning_probe_invalidation(true, true, |config| {
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
            local_model_tag: Some("shared/model".into()),
            reasoning_probe: probed("shared/model", ReasoningSupport::Supported),
            reasoning_probe_generation: 2,
            ..default_config()
        };

        config
            .mutate_with_reasoning_probe_invalidation(true, true, |config| {
                config.active_provider = Some(ProviderKind::Local);
                Ok(())
            })
            .unwrap();

        assert_eq!(config.reasoning_probe_generation, 3);
        assert_eq!(
            config.cached_reasoning_support(true),
            ReasoningSupport::Unknown
        );
    }

    #[test]
    fn cached_reasoning_support_returns_valid_model_verdict() {
        let config = ProviderConfig {
            model: "openai/gpt-4.1".into(),
            reasoning_probe: probed("openai/gpt-4.1", ReasoningSupport::Supported),
            ..default_config()
        };

        assert_eq!(
            config.cached_reasoning_support(true),
            ReasoningSupport::Supported
        );
    }

    #[test]
    fn cached_reasoning_support_is_unknown_after_model_change() {
        // The verdict belongs to `old/model`; the selected model is now `new/model`,
        // so the cache for A is not used for B.
        let config = ProviderConfig {
            model: "new/model".into(),
            reasoning_probe: probed("old/model", ReasoningSupport::Unsupported),
            ..default_config()
        };

        assert_eq!(
            config.cached_reasoning_support(true),
            ReasoningSupport::Unknown
        );
    }

    #[test]
    fn cached_reasoning_support_is_unknown_without_verdict() {
        let config = ProviderConfig {
            model: "openai/gpt-4.1".into(),
            reasoning_probe: None,
            ..default_config()
        };

        assert_eq!(
            config.cached_reasoning_support(true),
            ReasoningSupport::Unknown
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
            local_model_tag: Some("qwen2.5:7b".into()),
            reasoning_preference: ReasoningPreference {
                enabled: true,
                effort: None,
            },
            reasoning_probe: probed("qwen2.5:7b", ReasoningSupport::Supported),
            reasoning_probe_generation: 7,
            disabled_skills: vec![FIXTURE_SKILL_ID.into()],
            approval_mode: ApprovalMode::ApproveForMe,
            tool_approval_overrides: BTreeMap::new(),
        })
        .unwrap();

        assert!(value.get("activeProvider").is_some());
        assert!(value.get("keyConfigured").is_none());
        assert!(value.get("localModelTag").is_some());
        assert_eq!(
            value.get("reasoningPreference"),
            Some(&serde_json::json!({"enabled": true, "effort": null}))
        );
        // The legacy mirror, still a bool and still true — that is what keeps an
        // older build reading the opt-in rather than reverting it to off.
        assert_eq!(value.get("reasoning"), Some(&serde_json::json!(true)));
        assert_eq!(
            value.get("reasoningProbe"),
            Some(&serde_json::json!({"model":"qwen2.5:7b","support":"supported"}))
        );
        assert!(value.get("reasoningSupport").is_none());
        assert!(value.get("reasoningProbedModel").is_none());
        assert_eq!(
            value.get("approvalMode"),
            Some(&serde_json::json!("approveForMe"))
        );
        assert_eq!(
            value.get("toolApprovalOverrides"),
            Some(&serde_json::json!({}))
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

        assert_eq!(
            read_provider_config(dir.path())
                .unwrap()
                .reasoning_preference,
            ReasoningPreference::default()
        );
    }

    #[test]
    fn reasoning_flag_round_trips_true_then_false() {
        // The exact persistence `set_reasoning` performs: flip the flag on, then back
        // off, and confirm each state survives a write/read cycle.
        let dir = tempfile::tempdir().unwrap();

        let mut cfg = read_provider_config(dir.path()).unwrap();
        cfg.reasoning_preference.enabled = true;
        write_provider_config(dir.path(), &cfg).unwrap();
        assert!(
            read_provider_config(dir.path())
                .unwrap()
                .reasoning_preference
                .enabled
        );

        cfg.reasoning_preference.enabled = false;
        write_provider_config(dir.path(), &cfg).unwrap();
        assert!(
            !read_provider_config(dir.path())
                .unwrap()
                .reasoning_preference
                .enabled
        );
    }

    /// Two `ai-config.json` files written by the build currently on disk, copied
    /// verbatim off a real install rather than authored here. A hand-written one
    /// inherits whatever the *first* migration assumed the file looks like, so it
    /// can only prove the two migrations agree with each other.
    const SHIPPED_OPENROUTER_CONFIG: &str =
        include_str!("fixtures/ai_config_shipped_openrouter.json");
    const SHIPPED_LOCAL_CONFIG: &str = include_str!("fixtures/ai_config_shipped_local.json");

    #[test]
    fn a_shipped_config_keeps_every_preference_and_folds_its_reasoning_flag() {
        // The outcome this migration exists to avoid is silently resetting a
        // user's config, so every field is asserted — not just the one moving.
        let dir = tempfile::tempdir().unwrap();
        fs::write(config_file(dir.path()), SHIPPED_OPENROUTER_CONFIG).unwrap();

        let config = read_provider_config(dir.path()).unwrap();

        assert_eq!(
            config,
            ProviderConfig {
                active_provider: Some(ProviderKind::OpenRouter),
                model: "deepseek/deepseek-v4-flash-0731".into(),
                local_model_tag: Some("qwen3.5:27b".into()),
                reasoning_preference: ReasoningPreference {
                    enabled: true,
                    // Nothing on disk names an effort, and one is never invented:
                    // an effort is only ever read off a probed menu.
                    effort: None,
                },
                reasoning_probe: probed(
                    "deepseek/deepseek-v4-flash-0731",
                    ReasoningSupport::Supported
                ),
                reasoning_probe_generation: 36,
                disabled_skills: vec![],
                approval_mode: ApprovalMode::ApproveForMe,
                tool_approval_overrides: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn a_shipped_local_config_keeps_its_provider_and_always_ask_mode() {
        // The second shipped shape: the local lane, and the approval mode whose
        // loss would be the difference between an app that asks and one that
        // does not.
        let dir = tempfile::tempdir().unwrap();
        fs::write(config_file(dir.path()), SHIPPED_LOCAL_CONFIG).unwrap();

        let config = read_provider_config(dir.path()).unwrap();

        assert_eq!(config.active_provider, Some(ProviderKind::Local));
        assert_eq!(config.local_model_tag.as_deref(), Some("qwen3.5:27b"));
        assert_eq!(config.model, "moonshotai/kimi-k3");
        assert_eq!(config.approval_mode, ApprovalMode::AlwaysAsk);
        assert_eq!(
            config.reasoning_probe,
            probed("qwen3.5:27b", ReasoningSupport::Supported)
        );
        assert_eq!(config.reasoning_probe_generation, 97);
        assert_eq!(
            config.reasoning_preference,
            ReasoningPreference {
                enabled: true,
                effort: None
            }
        );
    }

    #[test]
    fn the_legacy_shape_carries_populated_skill_and_override_state_across() {
        // Both shipped fixtures happen to hold an empty `disabledSkills` and an
        // empty `toolApprovalOverrides`, and empty is ALSO what a silent reset
        // produces — so those two assertions cannot fail there. This is the same
        // legacy shape with both fields populated, which is the case that can.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            serde_json::to_string(&serde_json::json!({
                "activeProvider": "openRouter",
                "model": "vendor/legacy",
                "reasoning": true,
                "reasoningProbeGeneration": 12,
                "disabledSkills": [FIXTURE_SKILL_ID],
                "approvalMode": "yolo",
                "toolApprovalOverrides": { GatedTool::WriteNote.name(): "alwaysAsk" },
            }))
            .unwrap(),
        )
        .unwrap();

        let config = read_provider_config(dir.path()).unwrap();

        assert_eq!(config.disabled_skills, vec![FIXTURE_SKILL_ID.to_string()]);
        assert_eq!(
            config.tool_approval_overrides,
            BTreeMap::from([(
                GatedTool::WriteNote.name().to_string(),
                ApprovalMode::AlwaysAsk
            )])
        );
        assert_eq!(config.approval_mode, ApprovalMode::Yolo);
        assert_eq!(config.reasoning_probe_generation, 12);
        assert!(config.reasoning_preference.enabled);
    }

    #[test]
    fn a_build_that_never_heard_of_the_preference_key_still_reads_the_whole_config() {
        // Direction 2, made real rather than inferred: the pre-change on-disk
        // shape, mirrored locally, deserialising a file THIS build wrote. An
        // older build drops `reasoningPreference` as an unknown key and must
        // still recover every other preference — including the opt-in, off the
        // legacy bool.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PreChangeConfig {
            active_provider: Option<ProviderKind>,
            model: String,
            #[serde(default)]
            reasoning: bool,
            #[serde(default)]
            reasoning_probe: Option<ProbedReasoning>,
            #[serde(default)]
            reasoning_probe_generation: u64,
            #[serde(default)]
            disabled_skills: Vec<String>,
            #[serde(default)]
            approval_mode: ApprovalMode,
            #[serde(default)]
            tool_approval_overrides: BTreeMap<String, ApprovalMode>,
        }

        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: Some(ProviderKind::OpenRouter),
                model: "vendor/current".into(),
                reasoning_preference: ReasoningPreference {
                    enabled: true,
                    effort: Some("xhigh".into()),
                },
                reasoning_probe: probed("vendor/current", ReasoningSupport::Supported),
                reasoning_probe_generation: 4,
                disabled_skills: vec![FIXTURE_SKILL_ID.into()],
                approval_mode: ApprovalMode::Yolo,
                tool_approval_overrides: BTreeMap::from([(
                    GatedTool::WriteNote.name().to_string(),
                    ApprovalMode::AlwaysAsk,
                )]),
                ..default_config()
            },
        )
        .unwrap();

        let old: PreChangeConfig =
            serde_json::from_str(&fs::read_to_string(config_file(dir.path())).unwrap())
                .expect("an older build must still parse a file this build wrote");

        assert_eq!(old.active_provider, Some(ProviderKind::OpenRouter));
        assert_eq!(old.model, "vendor/current");
        assert!(old.reasoning, "the opt-in survives the downgrade");
        assert_eq!(
            old.reasoning_probe,
            probed("vendor/current", ReasoningSupport::Supported)
        );
        assert_eq!(old.reasoning_probe_generation, 4);
        assert_eq!(old.disabled_skills, vec![FIXTURE_SKILL_ID.to_string()]);
        assert_eq!(old.approval_mode, ApprovalMode::Yolo);
        assert_eq!(
            old.tool_approval_overrides,
            BTreeMap::from([(
                GatedTool::WriteNote.name().to_string(),
                ApprovalMode::AlwaysAsk
            )])
        );
        // The effort is the one thing an older build cannot represent. It is
        // left on disk untouched by a read; only a WRITE from that older build
        // drops it, which is the accepted cost of the new key.
    }

    #[test]
    fn the_current_preference_shape_wins_over_the_legacy_flag() {
        // Same "current shape wins" precedence `fold_reasoning_probe` already
        // uses. A file written mid-migration can carry both.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            config_file(dir.path()),
            r#"{"model":"openai/gpt-4.1","reasoning":false,"reasoningPreference":{"enabled":true,"effort":"xhigh"}}"#,
        )
        .unwrap();

        assert_eq!(
            read_provider_config(dir.path())
                .unwrap()
                .reasoning_preference,
            ReasoningPreference {
                enabled: true,
                effort: Some("xhigh".into()),
            }
        );
    }

    #[test]
    fn an_effort_round_trips_verbatim_through_the_config_file() {
        // The value came off the model's own menu; nothing here may normalise it.
        let dir = tempfile::tempdir().unwrap();
        let config = ProviderConfig {
            reasoning_preference: ReasoningPreference {
                enabled: true,
                effort: Some("ludicrous-Speed".into()),
            },
            ..default_config()
        };

        write_provider_config(dir.path(), &config).unwrap();

        assert_eq!(read_provider_config(dir.path()).unwrap(), config);
    }

    #[test]
    fn a_config_this_build_writes_still_tells_an_older_build_the_opt_in() {
        // The reason for a NEW key rather than a changed type: `reasoning` stays
        // a bool on disk, so a build that predates `reasoningPreference` still
        // parses the file (it drops the unknown key) AND still reads the opt-in
        // correctly instead of silently reverting the user to off.
        let dir = tempfile::tempdir().unwrap();

        write_provider_config(
            dir.path(),
            &ProviderConfig {
                reasoning_preference: ReasoningPreference {
                    enabled: true,
                    effort: Some("high".into()),
                },
                ..default_config()
            },
        )
        .unwrap();

        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(config_file(dir.path())).unwrap()).unwrap();
        assert_eq!(on_disk.get("reasoning"), Some(&serde_json::json!(true)));
        assert_eq!(
            on_disk.get("reasoningPreference"),
            Some(&serde_json::json!({"enabled": true, "effort": "high"}))
        );

        // And the round trip back: an older build rewrites the file with only the
        // legacy bool, which this build must read as the opt-in it is.
        fs::write(
            config_file(dir.path()),
            serde_json::to_string(&serde_json::json!({
                "model": DEFAULT_MODEL,
                "reasoning": true,
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_provider_config(dir.path())
                .unwrap()
                .reasoning_preference,
            ReasoningPreference {
                enabled: true,
                effort: None,
            }
        );
    }

    #[test]
    fn an_effort_never_outlives_the_model_whose_menu_offered_it() {
        // §4.2: an effort is only ever sent when it was read off a PROBED menu —
        // no remembered effort from a previous model. The opt-in is model-agnostic
        // and survives; the effort is not and does not.
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/menu-model".into(),
            reasoning_preference: ReasoningPreference {
                enabled: true,
                effort: Some("xhigh".into()),
            },
            reasoning_probe: probed("vendor/menu-model", ReasoningSupport::Supported),
            ..default_config()
        };

        config
            .mutate_with_reasoning_probe_invalidation(true, true, |cfg| {
                cfg.model = "vendor/other-model".into();
                Ok(())
            })
            .unwrap();

        assert_eq!(
            config.reasoning_preference,
            ReasoningPreference {
                enabled: true,
                effort: None,
            }
        );
        assert_eq!(config.reasoning_probe, None);
    }

    #[test]
    fn a_provider_switch_clears_the_effort_the_same_way_a_model_change_does() {
        // The target is provider AND model, so a switch to the local lane leaves
        // the hosted model's menu behind just as surely as picking another
        // model does. Correct by construction today; one refactor of
        // `reasoning_probe_identity` from being wrong.
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/menu-model".into(),
            local_model_tag: Some("qwen2.5:7b".into()),
            reasoning_preference: ReasoningPreference {
                enabled: true,
                effort: Some("xhigh".into()),
            },
            ..default_config()
        };

        config
            .mutate_with_reasoning_probe_invalidation(true, true, |cfg| {
                cfg.active_provider = Some(ProviderKind::Local);
                Ok(())
            })
            .unwrap();

        assert_eq!(
            config.reasoning_preference,
            ReasoningPreference {
                enabled: true,
                effort: None,
            }
        );
    }

    #[test]
    fn toggling_reasoning_off_and_on_again_restores_the_same_models_effort() {
        // `set_reasoning` writes only `enabled`, so an effort can outlive an
        // opt-out. That is deliberate rather than a leak: the model has not
        // changed, so the effort is still a value off ITS menu, and a user who
        // turns reasoning back on gets the setting they chose rather than a
        // silent reset to the provider default.
        let dir = tempfile::tempdir().unwrap();
        let stored = ProviderConfig {
            reasoning_preference: ReasoningPreference {
                enabled: true,
                effort: Some("xhigh".into()),
            },
            ..default_config()
        };
        write_provider_config(dir.path(), &stored).unwrap();

        let mut config = read_provider_config(dir.path()).unwrap();
        config.reasoning_preference.enabled = false;
        write_provider_config(dir.path(), &config).unwrap();
        let off = read_provider_config(dir.path()).unwrap();
        assert_eq!(off.reasoning_preference.effort.as_deref(), Some("xhigh"));

        config.reasoning_preference.enabled = true;
        write_provider_config(dir.path(), &config).unwrap();

        assert_eq!(read_provider_config(dir.path()).unwrap(), stored);
    }

    #[test]
    fn a_mutation_that_keeps_the_target_keeps_the_effort() {
        // The other half of the rule: the effort is cleared by a TARGET change,
        // not by any config write. An unrelated preference edit must not silently
        // drop the user's chosen effort.
        let mut config = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/menu-model".into(),
            reasoning_preference: ReasoningPreference {
                enabled: true,
                effort: Some("xhigh".into()),
            },
            ..default_config()
        };

        config
            .mutate_with_reasoning_probe_invalidation(true, true, |cfg| {
                cfg.approval_mode = ApprovalMode::Yolo;
                Ok(())
            })
            .unwrap();

        assert_eq!(config.reasoning_preference.effort.as_deref(), Some("xhigh"));
    }

    /// How many consecutive temp names the guard below occupies, starting at
    /// whatever the live counter reads.
    ///
    /// A write walks [`MAX_TEMP_ATTEMPTS`] names from wherever `AI_CONFIG_TMP_SEQ`
    /// stands when it runs, and other tests in this binary move that counter while
    /// the band is being planted. Eight windows wide, the band absorbs seven windows of that
    /// interference and the write's whole window still falls on squatted names.
    /// Exceeding even that is not a false pass: the write would find a free name
    /// and SUCCEED, which is what the guard asserts against.
    const SQUATTED_BAND: u64 = MAX_TEMP_ATTEMPTS as u64 * 8;

    /// Every temp name one `write_provider_config` call can reach, lowest first.
    fn temp_name_band(parent: &Path) -> Vec<PathBuf> {
        let first = AI_CONFIG_TMP_SEQ.load(Ordering::Relaxed);
        (first..first + SQUATTED_BAND)
            .map(|sequence| {
                parent.join(format!(
                    ".{AI_CONFIG_FILE}.{}.{sequence}.nn-tmp",
                    std::process::id()
                ))
            })
            .collect()
    }

    /// A symlink squatting the temp sibling an AI-config write renames into place
    /// must never be opened *through*. The plain `std::fs::write` this path used
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
    fn a_symlink_squatting_the_temp_sibling_is_never_written_through() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "outside stays intact").unwrap();
        let band = temp_name_band(dir.path());
        for name in &band {
            symlink(outside.path(), name).unwrap();
        }

        let result = write_provider_config(dir.path(), &default_config());

        assert_eq!(
            fs::read_to_string(outside.path()).unwrap(),
            "outside stays intact",
            "the AI-config write was made THROUGH a symlink squatting its temp sibling"
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
        assert!(!config_file(dir.path()).exists());
    }
}
