use neuralnote_core::capture::{
    resolve_distil_route, serialize_vault_profile, MocPolicy, PersistedVaultScheme,
    SkillRoutingProfile, VaultFolder, VaultInventory, VaultNote, VaultProfile, MAX_PROFILE_SKILLS,
    PROFILE_SCHEMA_VERSION,
};
use std::collections::BTreeMap;

fn folder(rel_path: &str, note_count: u32) -> VaultFolder {
    VaultFolder {
        rel_path: rel_path.into(),
        note_count,
    }
}

fn note(rel_path: &str) -> VaultNote {
    VaultNote {
        rel_path: rel_path.into(),
    }
}

#[test]
fn unsafe_inventory_paths_never_become_routes_or_samples() {
    let vault = VaultInventory {
        folders: vec![folder("AI", 3), folder("Gardening", 3), folder("../AI", 9)],
        notes: vec![
            note("AI/Safe.md"),
            note("AI/../Escape.md"),
            note("AI\\Forged.md"),
        ],
    };

    let route = resolve_distil_route("AI", &vault, None).unwrap();

    assert_eq!(route.suggested_folder.as_deref(), Some("AI"));
    assert_eq!(route.sample_note_paths, ["AI/Safe.md"]);
}

#[test]
fn profile_rejects_invalid_skill_ids_and_remaining_folder_bounds() {
    for folder in ["", " folder", "folder "] {
        let profile = VaultProfile {
            schema_version: PROFILE_SCHEMA_VERSION,
            skills: BTreeMap::from([(
                "youtube-distil".into(),
                SkillRoutingProfile {
                    scheme: PersistedVaultScheme::TopicFolders,
                    default_folder: Some(folder.into()),
                    moc_policy: MocPolicy::Never,
                },
            )]),
        };
        assert!(serialize_vault_profile(&profile).is_err(), "{folder:?}");
    }

    for skill_id in ["", "contains space", "bad.skill"] {
        let profile = VaultProfile {
            schema_version: PROFILE_SCHEMA_VERSION,
            skills: BTreeMap::from([(
                skill_id.into(),
                SkillRoutingProfile {
                    scheme: PersistedVaultScheme::FlatZettelkasten,
                    default_folder: None,
                    moc_policy: MocPolicy::Never,
                },
            )]),
        };
        assert!(serialize_vault_profile(&profile).is_err(), "{skill_id:?}");
    }
}

#[test]
fn valid_individual_routes_cannot_expand_the_encoded_profile_past_its_bound() {
    let long_folder = format!("folder/{}", "x".repeat(1_010));
    let skills = (0..MAX_PROFILE_SKILLS)
        .map(|index| {
            (
                format!("skill-{index}"),
                SkillRoutingProfile {
                    scheme: PersistedVaultScheme::TopicFolders,
                    default_folder: Some(long_folder.clone()),
                    moc_policy: MocPolicy::Never,
                },
            )
        })
        .collect();

    assert!(serialize_vault_profile(&VaultProfile {
        schema_version: PROFILE_SCHEMA_VERSION,
        skills,
    })
    .is_err());
}
