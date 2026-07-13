//! Implementation-authored vault-route elicitation and profile persistence.

use crate::ai::elicitation::{elicit_user, ElicitationOutcome};
use crate::ai::events::{ElicitOption, Elicitation};
use crate::ai::llm::UserPrompt;
use crate::ai::skills::YOUTUBE_DISTIL_SKILL_ID;
use crate::ai::tools::{action, reject, ToolContext, ToolResult};
use crate::ai::youtube_tool_errors::capture_reject;
use crate::capture::{
    parse_vault_profile, resolve_distil_route, serialize_vault_profile, CaptureError, MocPolicy,
    PersistedVaultScheme, RouteResolution, SkillRoutingProfile, VaultFolder, VaultInventory,
    VaultNote, VaultProfile, VaultScheme, PROFILE_SCHEMA_VERSION,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;

const ROUTE_PAGE_SIZE: usize = 50;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteArgs {
    topic: String,
}

pub(super) async fn dispatch_resolve_distil_route(
    call_id: &str,
    args_json: &str,
    provider: &dyn crate::ai::retrieval::RetrievalProvider,
    user_prompt: &dyn UserPrompt,
    context: &mut ToolContext<'_>,
) -> ToolResult {
    let args: RouteArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid resolve_distil_route arguments: {error}")),
    };
    let (inventory, truncated, skipped) = match build_inventory(provider) {
        Ok(inventory) => inventory,
        Err(error) => return capture_reject(error),
    };
    let mut profile = match load_profile(context) {
        Ok(profile) => profile,
        Err(error) => return capture_reject(error),
    };
    let saved_route = profile.skills.get(YOUTUBE_DISTIL_SKILL_ID);
    let mut route = match resolve_distil_route(&args.topic, &inventory, saved_route) {
        Ok(route) => route,
        Err(error) => return capture_reject(error),
    };

    if route_needs_profile(&route) {
        route = match elicit_and_persist_route(
            call_id,
            &args.topic,
            route,
            &inventory,
            &mut profile,
            user_prompt,
            context,
        )
        .await
        {
            Ok(route) => route,
            Err(result) => return result,
        };
    }
    action(route_json(&route, truncated, skipped).to_string())
}

fn build_inventory(
    provider: &dyn crate::ai::retrieval::RetrievalProvider,
) -> Result<(VaultInventory, bool, u32), CaptureError> {
    let folders = provider.list_folders().map_err(|error| {
        CaptureError::ProfileInvalid(format!("could not inspect vault folders: {error}"))
    })?;
    let notes = provider.list_notes(None).map_err(|error| {
        CaptureError::ProfileInvalid(format!("could not inspect vault notes: {error}"))
    })?;
    let inventory = VaultInventory {
        folders: folders
            .into_iter()
            .map(|folder| VaultFolder {
                rel_path: folder.rel_path,
                note_count: folder.note_count,
            })
            .collect(),
        notes: notes
            .notes
            .into_iter()
            .map(|note| VaultNote {
                rel_path: note.rel_path,
            })
            .collect(),
    };
    Ok((inventory, notes.truncated, notes.skipped))
}

fn load_profile(context: &ToolContext<'_>) -> Result<VaultProfile, CaptureError> {
    match context.vault_profile_io.load()? {
        Some(bytes) => parse_vault_profile(&bytes),
        None => Ok(VaultProfile {
            schema_version: PROFILE_SCHEMA_VERSION,
            skills: BTreeMap::new(),
        }),
    }
}

fn route_needs_profile(route: &RouteResolution) -> bool {
    route.scheme == VaultScheme::Unknown
        || (route.suggested_folder.is_none() && route.scheme != VaultScheme::FlatZettelkasten)
}

#[allow(clippy::too_many_arguments)]
async fn elicit_and_persist_route(
    call_id: &str,
    topic: &str,
    route: RouteResolution,
    inventory: &VaultInventory,
    profile: &mut VaultProfile,
    user_prompt: &dyn UserPrompt,
    context: &mut ToolContext<'_>,
) -> Result<RouteResolution, ToolResult> {
    let scheme = if route.scheme == VaultScheme::Unknown {
        elicit_scheme(call_id, user_prompt, context).await?
    } else {
        persistable_scheme(route.scheme).map_err(capture_reject)?
    };
    let default_folder =
        select_default_folder(call_id, scheme, inventory, user_prompt, context).await?;
    let routing = SkillRoutingProfile {
        scheme,
        default_folder,
        moc_policy: moc_policy(scheme),
    };
    profile
        .skills
        .insert(YOUTUBE_DISTIL_SKILL_ID.into(), routing.clone());
    let bytes = serialize_vault_profile(profile).map_err(capture_reject)?;
    context
        .vault_profile_io
        .save(&bytes)
        .map_err(capture_reject)?;
    resolve_distil_route(topic, inventory, Some(&routing)).map_err(capture_reject)
}

async fn select_default_folder(
    call_id: &str,
    scheme: PersistedVaultScheme,
    inventory: &VaultInventory,
    user_prompt: &dyn UserPrompt,
    context: &mut ToolContext<'_>,
) -> Result<Option<String>, ToolResult> {
    if scheme == PersistedVaultScheme::FlatZettelkasten {
        return Ok(None);
    }
    let choice = elicit_route(call_id, inventory, user_prompt, context).await?;
    let folder = choice.strip_prefix("folder:").ok_or_else(|| {
        capture_reject(CaptureError::ProfileInvalid(
            "route elicitation returned an invalid option id".into(),
        ))
    })?;
    inventory
        .folders
        .iter()
        .find(|candidate| candidate.rel_path == folder)
        .map(|existing| Some(existing.rel_path.clone()))
        .ok_or_else(|| {
            capture_reject(CaptureError::ProfileInvalid(
                "route elicitation selected a folder outside the inventory".into(),
            ))
        })
}

async fn elicit_scheme(
    call_id: &str,
    user_prompt: &dyn UserPrompt,
    context: &mut ToolContext<'_>,
) -> Result<PersistedVaultScheme, ToolResult> {
    let options = [
        ("para", "PARA", "Projects, Areas, Resources, and Archive."),
        (
            "flat_zettelkasten",
            "Flat / Zettelkasten",
            "Notes live at the vault root.",
        ),
        (
            "topic_folders",
            "Topic folders",
            "Folders are organised by subject.",
        ),
        (
            "date_based",
            "Date based",
            "Folders are organised by year, month, or day.",
        ),
        (
            "johnny_decimal",
            "Johnny.Decimal",
            "Numbered areas and categories.",
        ),
    ]
    .into_iter()
    .map(|(id, label, description)| ElicitOption {
        id: id.into(),
        label: label.into(),
        description: Some(description.into()),
        image_data_uri: None,
    })
    .collect();
    let elicitation = Elicitation {
        id: format!("{call_id}:scheme"),
        question: "I could not confidently infer this vault's organisation. Which scheme should this skill remember?".into(),
        options,
        multi_select: false,
    };
    let choice = match elicit_user(user_prompt, context.sink, elicitation).await {
        ElicitationOutcome::Answered { mut chosen_ids } => chosen_ids.remove(0),
        ElicitationOutcome::Rejected { error } => {
            return Err(reject(format!("scheme selection failed: {error}")));
        }
    };
    match choice.as_str() {
        "para" => Ok(PersistedVaultScheme::Para),
        "flat_zettelkasten" => Ok(PersistedVaultScheme::FlatZettelkasten),
        "topic_folders" => Ok(PersistedVaultScheme::TopicFolders),
        "date_based" => Ok(PersistedVaultScheme::DateBased),
        "johnny_decimal" => Ok(PersistedVaultScheme::JohnnyDecimal),
        _ => Err(capture_reject(CaptureError::ProfileInvalid(
            "scheme elicitation returned an invalid option id".into(),
        ))),
    }
}

async fn elicit_route(
    call_id: &str,
    inventory: &VaultInventory,
    user_prompt: &dyn UserPrompt,
    context: &mut ToolContext<'_>,
) -> Result<String, ToolResult> {
    let mut folders: Vec<_> = inventory.folders.iter().collect();
    folders.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    let page_count = folders.len().max(1).div_ceil(ROUTE_PAGE_SIZE);
    for page_index in 0..page_count {
        let start = page_index * ROUTE_PAGE_SIZE;
        let end = folders.len().min(start + ROUTE_PAGE_SIZE);
        let page = &folders[start..end];
        let mut options = Vec::with_capacity(page.len() + 1);
        options.extend(page.iter().map(|folder| ElicitOption {
            id: format!("folder:{}", folder.rel_path),
            label: folder.rel_path.clone(),
            description: Some(format!("{} notes recursively", folder.note_count)),
            image_data_uri: None,
        }));
        if page_index + 1 < page_count {
            options.push(ElicitOption {
                id: "next".into(),
                label: "Next page".into(),
                description: Some("Show more existing folders.".into()),
                image_data_uri: None,
            });
        }
        let elicitation = Elicitation {
            id: format!("{call_id}:route:{}", page_index + 1),
            question: format!(
                "I could not confidently infer this vault's route. Choose an existing destination (page {} of {page_count}); I will remember it for this vault.",
                page_index + 1
            ),
            options,
            multi_select: false,
        };
        match elicit_user(user_prompt, context.sink, elicitation).await {
            ElicitationOutcome::Answered { chosen_ids }
                if chosen_ids.first().is_some_and(|choice| choice == "next") =>
            {
                continue
            }
            ElicitationOutcome::Answered { mut chosen_ids } => return Ok(chosen_ids.remove(0)),
            ElicitationOutcome::Rejected { error } => {
                return Err(reject(format!("route selection failed: {error}")));
            }
        }
    }
    Err(capture_reject(CaptureError::ProfileInvalid(
        "route picker exhausted its folder pages without a destination".into(),
    )))
}

fn persistable_scheme(detected: VaultScheme) -> Result<PersistedVaultScheme, CaptureError> {
    match detected {
        VaultScheme::Para => Ok(PersistedVaultScheme::Para),
        VaultScheme::FlatZettelkasten => Ok(PersistedVaultScheme::FlatZettelkasten),
        VaultScheme::TopicFolders => Ok(PersistedVaultScheme::TopicFolders),
        VaultScheme::DateBased => Ok(PersistedVaultScheme::DateBased),
        VaultScheme::JohnnyDecimal => Ok(PersistedVaultScheme::JohnnyDecimal),
        VaultScheme::Unknown => Err(CaptureError::ProfileInvalid(
            "Unknown cannot be persisted as a vault scheme".into(),
        )),
    }
}

fn moc_policy(scheme: PersistedVaultScheme) -> MocPolicy {
    match scheme {
        PersistedVaultScheme::Para
        | PersistedVaultScheme::TopicFolders
        | PersistedVaultScheme::JohnnyDecimal => MocPolicy::ExistingConventionOnly,
        PersistedVaultScheme::FlatZettelkasten | PersistedVaultScheme::DateBased => {
            MocPolicy::Never
        }
    }
}

fn route_json(route: &RouteResolution, truncated: bool, skipped: u32) -> serde_json::Value {
    json!({
        "scheme": route.scheme,
        "suggested_folder": route.suggested_folder,
        "why": route.why,
        "sample_note_paths": route.sample_note_paths,
        "inventory_truncated": truncated,
        "inventory_skipped": skipped,
    })
}
