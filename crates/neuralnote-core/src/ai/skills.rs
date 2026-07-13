//! Built-in skill manifests, pure requirement policy, and registry lookup.
//!
//! Skills are instruction markdown plus capability names. This module never probes
//! the host: callers supply hardware and the exact app-data binaries they detected.

use crate::ai::local::HardwareSpec;
use crate::ai::requirement_binaries::validate_requirement_binary_name;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// Stable id of the network-free framework fixture shipped with Slice 4.
pub const FIXTURE_SKILL_ID: &str = "fixture-note-workflow";
/// Stable id of the Slice 5 YouTube capture workflow.
pub const YOUTUBE_DISTIL_SKILL_ID: &str = "youtube-distil";

/// One prerequisite a skill needs before its instructions can run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Requirement {
    Binary { name: String },
    Asset { name: String },
    FreeDiskSpace { min_bytes: u64 },
    Platform { os: String, arch: String },
}

/// Settings-facing state for one evaluated skill requirement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum RequirementStatus {
    Installed,
    Unmet {
        reasons: Vec<String>,
    },
    Undetected {
        reasons: Vec<String>,
    },
    UnmetAndUndetected {
        unmet: Vec<String>,
        undetected: Vec<String>,
    },
}

/// One requirement paired with its host-specific Settings status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillRequirement {
    pub requirement: Requirement,
    pub status: RequirementStatus,
}

/// Compact Settings projection of a built-in skill manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillListing {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub enabled: bool,
    pub requirements: Vec<SkillRequirement>,
}

/// A compiled-in skill definition. `instructions` is progressively disclosed only
/// after activation; the system prompt receives the compact catalogue instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub icon: String,
    pub instructions: String,
    pub tools: Vec<String>,
    pub requirements: Vec<Requirement>,
    /// Requirements for a fallback capability that does not block base activation.
    pub optional_requirements: Vec<Requirement>,
    pub max_iterations: Option<usize>,
    /// Optional larger tool-result budget for skills whose validated source
    /// records are intrinsically longer than conversational retrieval snippets.
    pub max_context_chars: Option<usize>,
}

/// Host facts used by the pure requirement evaluator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillEnvironment {
    pub hardware: HardwareSpec,
    pub app_data_bin_dir: PathBuf,
    /// Exact app-data requirement paths detected by the host. The legacy field
    /// name covers both executable [`Requirement::Binary`] files and inert
    /// [`Requirement::Asset`] files so adding the asset kind stays additive.
    pub available_binaries: BTreeSet<PathBuf>,
}

/// Aggregate eligibility that preserves detection failures separately from facts
/// that were detected and did not meet a requirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Eligibility {
    Eligible,
    Unmet {
        reasons: Vec<String>,
    },
    Undetected {
        reasons: Vec<String>,
    },
    UnmetAndUndetected {
        unmet: Vec<String>,
        undetected: Vec<String>,
    },
}

impl Eligibility {
    /// Evaluate requirements using only caller-supplied facts.
    pub fn evaluate(requirements: &[Requirement], env: &SkillEnvironment) -> Self {
        let mut unmet = Vec::new();
        let mut undetected = Vec::new();

        for requirement in requirements {
            match requirement {
                Requirement::Binary { name } => evaluate_requirement_file(
                    name,
                    "binary",
                    "app-data bin directory",
                    &env.app_data_bin_dir,
                    env,
                    &mut unmet,
                    &mut undetected,
                ),
                Requirement::Asset { name } => evaluate_requirement_file(
                    name,
                    "asset",
                    "app-data assets directory",
                    &app_data_assets_dir(&env.app_data_bin_dir),
                    env,
                    &mut unmet,
                    &mut undetected,
                ),
                Requirement::FreeDiskSpace { min_bytes } => {
                    evaluate_free_disk_space(min_bytes, env, &mut unmet, &mut undetected)
                }
                Requirement::Platform { os, arch } => {
                    evaluate_platform(os, arch, env, &mut unmet, &mut undetected)
                }
            }
        }

        match (unmet.is_empty(), undetected.is_empty()) {
            (true, true) => Self::Eligible,
            (false, true) => Self::Unmet { reasons: unmet },
            (true, false) => Self::Undetected {
                reasons: undetected,
            },
            (false, false) => Self::UnmetAndUndetected { unmet, undetected },
        }
    }

    /// Whether every requirement is known and satisfied.
    pub fn is_eligible(&self) -> bool {
        matches!(self, Self::Eligible)
    }
}

impl std::fmt::Display for Eligibility {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Eligible => write!(f, "eligible"),
            Self::Unmet { reasons } => write!(f, "unmet requirements: {}", reasons.join("; ")),
            Self::Undetected { reasons } => {
                write!(
                    f,
                    "requirements could not be detected: {}",
                    reasons.join("; ")
                )
            }
            Self::UnmetAndUndetected { unmet, undetected } => write!(
                f,
                "unmet requirements: {}; requirements could not be detected: {}",
                unmet.join("; "),
                undetected.join("; ")
            ),
        }
    }
}

fn evaluate_free_disk_space(
    min_bytes: &u64,
    env: &SkillEnvironment,
    unmet: &mut Vec<String>,
    undetected: &mut Vec<String>,
) {
    if env.hardware.free_disk_bytes == 0 {
        undetected.push("free disk space could not be detected".into());
    } else if env.hardware.free_disk_bytes < *min_bytes {
        unmet.push(format!(
            "free disk space is below the required {min_bytes} bytes"
        ));
    }
}

fn evaluate_platform(
    os: &str,
    arch: &str,
    env: &SkillEnvironment,
    unmet: &mut Vec<String>,
    undetected: &mut Vec<String>,
) {
    let os_unknown = env.hardware.os.trim().is_empty();
    let arch_unknown = env.hardware.arch.trim().is_empty();
    if os_unknown {
        undetected.push("platform OS could not be detected".into());
    }
    if arch_unknown {
        undetected.push("platform architecture could not be detected".into());
    }

    let os_mismatch = !os_unknown && !env.hardware.os.eq_ignore_ascii_case(os);
    let arch_mismatch = !arch_unknown && !env.hardware.arch.eq_ignore_ascii_case(arch);
    if os_mismatch || arch_mismatch {
        let mismatched_axes = match (os_mismatch, arch_mismatch) {
            (true, true) => "OS/architecture",
            (true, false) => "OS",
            (false, true) => "architecture",
            (false, false) => unreachable!("guarded by a known mismatch"),
        };
        unmet.push(format!(
            "platform {mismatched_axes} requires {os}/{arch}, detected {}/{}",
            env.hardware.os, env.hardware.arch
        ));
    }
}

fn evaluate_requirement_file(
    name: &str,
    kind: &str,
    directory_label: &str,
    directory: &Path,
    env: &SkillEnvironment,
    unmet: &mut Vec<String>,
    undetected: &mut Vec<String>,
) {
    if directory.as_os_str().is_empty() {
        undetected.push(format!("{directory_label} for '{name}' was not provided"));
        return;
    }
    if validate_requirement_binary_name(name).is_err() {
        unmet.push(format!(
            "{kind} requirement '{name}' is not a valid file name"
        ));
        return;
    }
    let expected = directory.join(name);
    if !env.available_binaries.contains(&expected) {
        unmet.push(format!(
            "required {kind} '{name}' is missing from the {directory_label}"
        ));
    }
}

fn app_data_assets_dir(bin_dir: &Path) -> PathBuf {
    if bin_dir.as_os_str().is_empty() {
        return PathBuf::new();
    }
    bin_dir
        .parent()
        .map(|app_data_dir| app_data_dir.join("assets"))
        .unwrap_or_default()
}

/// Why a registry lookup cannot return a manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillLookupError {
    Unknown(String),
    Disabled(String),
    Duplicate(String),
}

impl std::fmt::Display for SkillLookupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown(id) => write!(f, "unknown skill '{id}'"),
            Self::Disabled(id) => write!(f, "skill '{id}' is disabled"),
            Self::Duplicate(id) => write!(f, "duplicate skill id '{id}'"),
        }
    }
}

impl std::error::Error for SkillLookupError {}

/// The built-in skill catalogue plus persisted disable state.
#[derive(Debug, Clone)]
pub struct SkillRegistry {
    manifests: Vec<SkillManifest>,
    disabled: BTreeSet<String>,
}

impl SkillRegistry {
    /// Build a registry, rejecting duplicate stable ids before any prompt is made.
    pub fn new(
        manifests: Vec<SkillManifest>,
        disabled: &[String],
    ) -> Result<Self, SkillLookupError> {
        let mut ids = BTreeSet::new();
        for manifest in &manifests {
            if !ids.insert(manifest.id.clone()) {
                return Err(SkillLookupError::Duplicate(manifest.id.clone()));
            }
        }
        Ok(Self {
            manifests,
            disabled: disabled.iter().cloned().collect(),
        })
    }

    /// Registry of skills compiled into this app build.
    pub fn built_in(disabled: &[String]) -> Result<Self, SkillLookupError> {
        Self::new(
            vec![fixture_manifest(), youtube_distil_manifest()],
            disabled,
        )
    }

    /// Whether a stable id exists, regardless of its enabled state.
    pub fn contains_id(&self, id: &str) -> bool {
        self.manifests.iter().any(|manifest| manifest.id == id)
    }

    /// Find an enabled skill by stable id.
    pub fn lookup(&self, id: &str) -> Result<&SkillManifest, SkillLookupError> {
        let manifest = self
            .manifests
            .iter()
            .find(|manifest| manifest.id == id)
            .ok_or_else(|| SkillLookupError::Unknown(id.to_string()))?;
        if self.disabled.contains(id) {
            Err(SkillLookupError::Disabled(id.to_string()))
        } else {
            Ok(manifest)
        }
    }

    /// Settings projections for every compiled-in skill, including disabled ones.
    pub fn listings(&self, env: &SkillEnvironment) -> Vec<SkillListing> {
        self.manifests
            .iter()
            .map(|manifest| SkillListing {
                id: manifest.id.clone(),
                name: manifest.name.clone(),
                description: manifest.description.clone(),
                icon: manifest.icon.clone(),
                enabled: !self.disabled.contains(&manifest.id),
                requirements: manifest
                    .requirements
                    .iter()
                    .map(|requirement| {
                        let status =
                            match Eligibility::evaluate(std::slice::from_ref(requirement), env) {
                                Eligibility::Eligible => RequirementStatus::Installed,
                                Eligibility::Unmet { reasons } => {
                                    RequirementStatus::Unmet { reasons }
                                }
                                Eligibility::Undetected { reasons } => {
                                    RequirementStatus::Undetected { reasons }
                                }
                                Eligibility::UnmetAndUndetected { unmet, undetected } => {
                                    RequirementStatus::UnmetAndUndetected { unmet, undetected }
                                }
                            };
                        SkillRequirement {
                            requirement: requirement.clone(),
                            status,
                        }
                    })
                    .collect(),
            })
            .collect()
    }

    /// Compact prompt catalogue: one enabled `id: description` line per skill.
    pub fn catalogue(&self) -> String {
        self.manifests
            .iter()
            .filter(|manifest| !self.disabled.contains(&manifest.id))
            .map(|manifest| {
                format!(
                    "{}: {}",
                    manifest.id,
                    manifest
                        .description
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// A successful activation returned by the shared preload/`use_skill` policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillActivation {
    pub manifest: SkillManifest,
    pub newly_activated: bool,
}

/// Active capability state for one run.
#[derive(Debug, Clone)]
pub struct ActiveSkills {
    base_max_iterations: usize,
    manifests: BTreeMap<String, SkillManifest>,
}

impl ActiveSkills {
    pub fn new(base_max_iterations: usize) -> Self {
        Self {
            base_max_iterations,
            manifests: BTreeMap::new(),
        }
    }

    /// Activate through the same lookup and requirement policy used by explicit
    /// preloads and the model-facing `use_skill` tool.
    pub fn activate(
        &mut self,
        id: &str,
        registry: &SkillRegistry,
        environment: &SkillEnvironment,
    ) -> Result<SkillActivation, String> {
        let manifest = registry.lookup(id).map_err(|error| error.to_string())?;
        let eligibility = Eligibility::evaluate(&manifest.requirements, environment);
        if !eligibility.is_eligible() {
            return Err(format!("skill '{id}' is not eligible: {eligibility}"));
        }

        let newly_activated = !self.manifests.contains_key(id);
        if newly_activated {
            self.manifests.insert(id.to_string(), manifest.clone());
        }
        Ok(SkillActivation {
            manifest: manifest.clone(),
            newly_activated,
        })
    }

    pub fn contains(&self, id: &str) -> bool {
        self.manifests.contains_key(id)
    }

    /// Set-union of every tool declared by active skills.
    pub fn authorized_tools(&self) -> BTreeSet<String> {
        self.manifests
            .values()
            .flat_map(|manifest| manifest.tools.iter().cloned())
            .collect()
    }

    /// Absolute run ceiling. Overrides may raise the base ceiling but never grant
    /// N extra turns; `consumed` prevents a late activation from lowering history.
    pub fn max_iterations(&self, consumed: usize) -> usize {
        self.manifests
            .values()
            .filter_map(|manifest| manifest.max_iterations)
            .fold(self.base_max_iterations.max(consumed), usize::max)
    }

    /// Active skills may raise the base tool-result budget, but never lower it.
    pub fn max_context_chars(&self, base: usize) -> usize {
        self.manifests
            .values()
            .filter_map(|manifest| manifest.max_context_chars)
            .fold(base, usize::max)
    }
}

fn fixture_manifest() -> SkillManifest {
    SkillManifest {
        id: FIXTURE_SKILL_ID.into(),
        name: "Fixture note workflow".into(),
        version: "1.0.0".into(),
        description: "Demonstrate progress, elicitation, and a guarded note write.".into(),
        icon: "flask".into(),
        instructions: include_str!("fixtures/fixture_skill/SKILL.md").into(),
        tools: vec!["skill_step".into(), "ask_user".into(), "write_note".into()],
        requirements: Vec::new(),
        optional_requirements: Vec::new(),
        max_iterations: Some(12),
        max_context_chars: None,
    }
}

fn youtube_distil_manifest() -> SkillManifest {
    SkillManifest {
        id: YOUTUBE_DISTIL_SKILL_ID.into(),
        name: "YouTube distil".into(),
        version: "1.0.0".into(),
        description: "Turn YouTube videos and playlists into routed literature notes, concept-scoped atomic notes, and timestamped transcript records.".into(),
        icon: "youtube".into(),
        instructions: include_str!("fixtures/youtube_distil/SKILL.md").into(),
        tools: vec![
            "skill_step".into(),
            "ask_user".into(),
            "write_note".into(),
            "fetch_video_info".into(),
            "fetch_captions".into(),
            "transcribe_audio".into(),
            "select_playlist_videos".into(),
            "resolve_distil_route".into(),
        ],
        requirements: vec![Requirement::Binary {
            name: "yt-dlp".into(),
        }],
        optional_requirements: vec![
            Requirement::Binary {
                name: "whisper-cli".into(),
            },
            Requirement::Asset {
                name: "ggml-small.en.bin".into(),
            },
            Requirement::FreeDiskSpace {
                min_bytes: 1_000_000_000,
            },
        ],
        // A normal run needs metadata, captions, routing, convention reads,
        // dedup searches, and several writes; 16 leaves room for one extractor
        // retry while keeping the agent loop bounded.
        max_iterations: Some(16),
        // A one-hour transcript can cross the 60k conversational search cap.
        // 96k retains a typical long-form source plus routing/write results while
        // staying within the supported local model's 32k-token prompt budget.
        max_context_chars: Some(96_000),
    }
}
