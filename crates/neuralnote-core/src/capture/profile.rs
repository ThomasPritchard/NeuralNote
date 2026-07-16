//! Versioned, vault-scoped routing profile contract.

use crate::capture::CaptureError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROFILE_SCHEMA_VERSION: u32 = 1;
pub const MAX_VAULT_PROFILE_BYTES: usize = 64 * 1_024;
pub const MAX_PROFILE_SKILLS: usize = 64;
const MAX_SKILL_ID_BYTES: usize = 128;
const MAX_PROFILE_FOLDER_BYTES: usize = 1_024;

/// The serialisable profile stored at `<vault>/.neuralnote/profile.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultProfile {
    pub schema_version: u32,
    pub skills: BTreeMap<String, SkillRoutingProfile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultProfileSchemaProbe {
    schema_version: u32,
}

/// Routing remembered independently for each installed skill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillRoutingProfile {
    pub scheme: PersistedVaultScheme,
    pub default_folder: Option<String>,
    pub moc_policy: MocPolicy,
}

/// Persistable schemes deliberately exclude `Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PersistedVaultScheme {
    Para,
    FlatZettelkasten,
    TopicFolders,
    DateBased,
    JohnnyDecimal,
}

/// Whether a multi-video run may follow an existing MOC convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MocPolicy {
    Never,
    ExistingConventionOnly,
}

/// Raw-byte profile storage seam. Filesystem access belongs to the host shell.
pub trait VaultProfileIo: Send + Sync {
    fn load(&self) -> Result<Option<Vec<u8>>, CaptureError>;
    fn save(&self, bytes: &[u8]) -> Result<(), CaptureError>;
}

/// Core-safe placeholder used until a host supplies vault profile I/O.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnavailableVaultProfileIo;

impl VaultProfileIo for UnavailableVaultProfileIo {
    fn load(&self) -> Result<Option<Vec<u8>>, CaptureError> {
        Err(profile_error("vault profile I/O is unavailable"))
    }

    fn save(&self, _bytes: &[u8]) -> Result<(), CaptureError> {
        Err(profile_error("vault profile I/O is unavailable"))
    }
}

/// Parse and validate an untrusted routing profile.
pub fn parse_vault_profile(bytes: &[u8]) -> Result<VaultProfile, CaptureError> {
    if bytes.len() > MAX_VAULT_PROFILE_BYTES {
        return Err(profile_error("vault profile exceeds the byte limit"));
    }

    if serde_json::from_slice::<VaultProfileSchemaProbe>(bytes)
        .is_ok_and(|probe| probe.schema_version != PROFILE_SCHEMA_VERSION)
    {
        return Err(profile_error("unsupported vault profile schema version"));
    }

    let profile: VaultProfile = serde_json::from_slice(bytes)
        .map_err(|_| profile_error("vault profile is not valid JSON"))?;
    validate_vault_profile(&profile)?;
    Ok(profile)
}

/// Validate and encode a routing profile in its stable JSON wire shape.
pub fn serialize_vault_profile(profile: &VaultProfile) -> Result<Vec<u8>, CaptureError> {
    validate_vault_profile(profile)?;
    let bytes = serde_json::to_vec_pretty(profile)
        .map_err(|_| profile_error("vault profile could not be encoded"))?;
    if bytes.len() > MAX_VAULT_PROFILE_BYTES {
        return Err(profile_error("vault profile exceeds the byte limit"));
    }
    Ok(bytes)
}

pub(crate) fn validate_skill_routing_profile(
    profile: &SkillRoutingProfile,
) -> Result<(), CaptureError> {
    if let Some(folder) = profile.default_folder.as_deref() {
        validate_folder_path(folder)?;
    }
    Ok(())
}

/// Validate a saved routing folder through the shared portable vault-relative
/// predicate — [`crate::paths::parse_portable_rel_path`], the same grammar the
/// frontmatter, routing-inventory, and vault-scheme boundaries use (absolute,
/// traversal, empty-component, separator, drive-prefix, and invisible-character
/// rejection, the `<>:"|?*` portability class, reserved Windows device names, and
/// no component with a leading space or a trailing dot or space) — plus this
/// boundary's own extras that the shared predicate does not cover: a byte cap and
/// no surrounding whitespace on the whole string (which also catches non-ASCII
/// boundary whitespace such as U+00A0 that the per-component leading/trailing-space
/// rule does not).
pub(crate) fn validate_folder_path(path: &str) -> Result<(), CaptureError> {
    if path.is_empty() || path.len() > MAX_PROFILE_FOLDER_BYTES || path.trim() != path {
        return Err(profile_error(
            "default folder is empty or exceeds its limit",
        ));
    }
    if crate::paths::parse_portable_rel_path(path).is_err() {
        return Err(profile_error(
            "default folder must be a portable vault-relative path",
        ));
    }
    Ok(())
}

fn validate_vault_profile(profile: &VaultProfile) -> Result<(), CaptureError> {
    if profile.schema_version != PROFILE_SCHEMA_VERSION {
        return Err(profile_error("unsupported vault profile schema version"));
    }
    if profile.skills.len() > MAX_PROFILE_SKILLS {
        return Err(profile_error("vault profile has too many skill routes"));
    }

    for (skill_id, routing) in &profile.skills {
        if skill_id.is_empty()
            || skill_id.len() > MAX_SKILL_ID_BYTES
            || !skill_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(profile_error("vault profile contains an invalid skill id"));
        }
        validate_skill_routing_profile(routing)?;
    }
    Ok(())
}

fn profile_error(detail: &str) -> CaptureError {
    CaptureError::ProfileInvalid(detail.into())
}
