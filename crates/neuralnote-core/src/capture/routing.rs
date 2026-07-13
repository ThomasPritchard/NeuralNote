//! Pure route resolution over a detected vault scheme and optional profile.

use crate::capture::profile::{validate_skill_routing_profile, MocPolicy, PersistedVaultScheme};
use crate::capture::{
    detect_vault_scheme, CaptureError, SkillRoutingProfile, VaultInventory, VaultScheme,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const MAX_ROUTE_TOPIC_BYTES: usize = 200;
const MAX_ROUTE_SAMPLE_NOTES: usize = 2;
const MAX_INVENTORY_PATH_BYTES: usize = 1_024;

/// Model-facing evidence for a route decision. Every returned path came from
/// the host inventory; core never manufactures a folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteResolution {
    pub scheme: VaultScheme,
    pub suggested_folder: Option<String>,
    pub why: String,
    pub sample_note_paths: Vec<String>,
}

/// Resolve an existing destination and neighbouring convention samples.
///
/// The model still owns the final choice and announcement. A missing suggestion
/// tells it to ask the user rather than invent a folder.
pub fn resolve_distil_route(
    topic: &str,
    inventory: &VaultInventory,
    profile: Option<&SkillRoutingProfile>,
) -> Result<RouteResolution, CaptureError> {
    let topic = validate_topic(topic)?;

    if let Some(profile) = profile {
        validate_skill_routing_profile(profile)?;
        if let Some(saved_folder) = profile.default_folder.as_deref() {
            if let Some(existing) = existing_folder(inventory, saved_folder) {
                return Ok(with_moc_policy(
                    RouteResolution {
                        scheme: profile.scheme.into(),
                        sample_note_paths: sample_notes(inventory, Some(&existing)),
                        suggested_folder: Some(existing),
                        why: "Using the existing folder from the saved vault profile.".into(),
                    },
                    profile.moc_policy,
                ));
            }
            // Stale remembered paths are ignored completely. In particular,
            // they must not leak back as proposed folders.
        } else {
            return Ok(with_moc_policy(
                resolve_for_scheme(profile.scheme.into(), topic, inventory, true),
                profile.moc_policy,
            ));
        }
    }

    let scheme = detect_vault_scheme(inventory);
    let route = resolve_for_scheme(scheme, topic, inventory, false);
    Ok(match default_moc_policy(scheme) {
        Some(policy) => with_moc_policy(route, policy),
        None => route,
    })
}

fn default_moc_policy(scheme: VaultScheme) -> Option<MocPolicy> {
    match scheme {
        VaultScheme::Para | VaultScheme::TopicFolders | VaultScheme::JohnnyDecimal => {
            Some(MocPolicy::ExistingConventionOnly)
        }
        VaultScheme::FlatZettelkasten | VaultScheme::DateBased => Some(MocPolicy::Never),
        VaultScheme::Unknown => None,
    }
}

fn with_moc_policy(mut route: RouteResolution, policy: MocPolicy) -> RouteResolution {
    let guidance = match policy {
        MocPolicy::Never => "Do not create a playlist MOC for this route.",
        MocPolicy::ExistingConventionOnly => {
            "Create a playlist MOC only when neighbouring notes show an existing MOC convention."
        }
    };
    route.why.push(' ');
    route.why.push_str(guidance);
    route
}

fn resolve_for_scheme(
    scheme: VaultScheme,
    topic: &str,
    inventory: &VaultInventory,
    from_profile: bool,
) -> RouteResolution {
    let suggested_folder = match scheme {
        VaultScheme::Para => resolve_para(topic, inventory),
        VaultScheme::TopicFolders => find_topic_folder(topic, inventory),
        VaultScheme::JohnnyDecimal => find_johnny_decimal_category(topic, inventory),
        VaultScheme::FlatZettelkasten | VaultScheme::DateBased | VaultScheme::Unknown => None,
    };

    let why = if from_profile {
        match (&suggested_folder, scheme) {
            (Some(_), _) => "Following the saved vault profile and an existing matching folder.",
            (None, VaultScheme::FlatZettelkasten) => {
                "The saved vault profile says this is a flat vault; use the vault root."
            }
            (None, _) => {
                "The saved vault profile identifies the scheme but no existing folder matches; ask the user."
            }
        }
    } else {
        match (&suggested_folder, scheme) {
            (Some(_), VaultScheme::Para) => {
                "Matched an existing PARA folder using Areas, Resources, Projects, then Inbox priority."
            }
            (Some(_), VaultScheme::TopicFolders) => {
                "Matched the topic to an existing topic folder."
            }
            (Some(_), VaultScheme::JohnnyDecimal) => {
                "Matched the topic to an existing Johnny.Decimal category."
            }
            (Some(_), _) => "Matched an existing folder in the detected vault scheme.",
            (None, VaultScheme::FlatZettelkasten) => {
                "The detected vault is flat; use the vault root and copy a root note's conventions."
            }
            (None, VaultScheme::Unknown) => {
                "The vault scheme is unknown; ask the user and persist their choice."
            }
            (None, VaultScheme::DateBased) => {
                "The vault is date-based but no date route was supplied; ask the user."
            }
            (None, _) => "No existing folder matches the topic; ask the user.",
        }
    };

    let samples = match (scheme, suggested_folder.as_deref()) {
        (VaultScheme::FlatZettelkasten, None) => sample_notes(inventory, None),
        (_, Some(folder)) => sample_notes(inventory, Some(folder)),
        (_, None) => Vec::new(),
    };

    RouteResolution {
        scheme,
        suggested_folder,
        why: why.into(),
        sample_note_paths: samples,
    }
}

fn resolve_para(topic: &str, inventory: &VaultInventory) -> Option<String> {
    for root in ["Areas", "Resources", "Projects"] {
        if let Some(folder) = best_matching_folder(inventory, |candidate| {
            let mut components = candidate.split('/');
            components
                .next()
                .is_some_and(|component| component.eq_ignore_ascii_case(root))
                && candidate
                    .rsplit('/')
                    .next()
                    .is_some_and(|leaf| leaf.eq_ignore_ascii_case(topic))
        }) {
            return Some(folder);
        }
    }
    existing_folder(inventory, "Inbox")
}

fn find_topic_folder(topic: &str, inventory: &VaultInventory) -> Option<String> {
    best_matching_folder(inventory, |candidate| {
        candidate
            .rsplit('/')
            .next()
            .is_some_and(|leaf| leaf.eq_ignore_ascii_case(topic))
    })
}

fn find_johnny_decimal_category(topic: &str, inventory: &VaultInventory) -> Option<String> {
    best_matching_folder(inventory, |candidate| {
        let Some(leaf) = candidate.rsplit('/').next() else {
            return false;
        };
        let Some((number, label)) = leaf.split_once(' ') else {
            return false;
        };
        number.len() == 2
            && number.bytes().all(|byte| byte.is_ascii_digit())
            && label.eq_ignore_ascii_case(topic)
    })
}

fn best_matching_folder(
    inventory: &VaultInventory,
    predicate: impl Fn(&str) -> bool,
) -> Option<String> {
    let mut matches: Vec<_> = inventory
        .folders
        .iter()
        .map(|folder| folder.rel_path.as_str())
        .filter(|path| is_safe_inventory_path(path) && predicate(path))
        .collect();
    matches.sort_by(|left, right| {
        left.matches('/')
            .count()
            .cmp(&right.matches('/').count())
            .then_with(|| left.to_ascii_lowercase().cmp(&right.to_ascii_lowercase()))
            .then_with(|| left.cmp(right))
    });
    matches.first().map(|path| (*path).to_owned())
}

fn existing_folder(inventory: &VaultInventory, expected: &str) -> Option<String> {
    inventory
        .folders
        .iter()
        .find(|folder| {
            is_safe_inventory_path(&folder.rel_path)
                && folder.rel_path.eq_ignore_ascii_case(expected)
        })
        .map(|folder| folder.rel_path.clone())
}

fn sample_notes(inventory: &VaultInventory, folder: Option<&str>) -> Vec<String> {
    let prefix = folder.map(|folder| format!("{folder}/"));
    let samples: BTreeSet<_> = inventory
        .notes
        .iter()
        .map(|note| note.rel_path.as_str())
        .filter(|path| is_safe_inventory_path(path))
        .filter(|path| match prefix.as_deref() {
            Some(prefix) => path.starts_with(prefix),
            None => !path.contains('/'),
        })
        .map(str::to_owned)
        .collect();

    let mut samples: Vec<_> = samples.into_iter().collect();
    samples.sort_by(|left, right| {
        left.to_ascii_lowercase()
            .cmp(&right.to_ascii_lowercase())
            .then_with(|| left.cmp(right))
    });
    samples.truncate(MAX_ROUTE_SAMPLE_NOTES);
    samples
}

fn validate_topic(topic: &str) -> Result<&str, CaptureError> {
    let topic = topic.trim();
    if topic.is_empty()
        || topic.len() > MAX_ROUTE_TOPIC_BYTES
        || topic.chars().any(char::is_control)
    {
        return Err(CaptureError::InvalidMetadata(
            "route topic is empty, unsafe, or exceeds its byte limit".into(),
        ));
    }
    Ok(topic)
}

// TODO(path-safety-unify): replace this local rule set with one shared
// vault-relative path policy.
fn is_safe_inventory_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_INVENTORY_PATH_BYTES
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|component| !component.is_empty() && !matches!(component, "." | ".."))
}

impl From<PersistedVaultScheme> for VaultScheme {
    fn from(scheme: PersistedVaultScheme) -> Self {
        match scheme {
            PersistedVaultScheme::Para => Self::Para,
            PersistedVaultScheme::FlatZettelkasten => Self::FlatZettelkasten,
            PersistedVaultScheme::TopicFolders => Self::TopicFolders,
            PersistedVaultScheme::DateBased => Self::DateBased,
            PersistedVaultScheme::JohnnyDecimal => Self::JohnnyDecimal,
        }
    }
}
