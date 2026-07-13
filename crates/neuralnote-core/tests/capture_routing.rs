use neuralnote_core::capture::{
    detect_vault_scheme, parse_vault_profile, resolve_distil_route, serialize_vault_profile,
    MocPolicy, PersistedVaultScheme, SkillRoutingProfile, UnavailableVaultProfileIo, VaultFolder,
    VaultInventory, VaultNote, VaultProfile, VaultProfileIo, VaultScheme, MAX_PROFILE_SKILLS,
    MAX_VAULT_PROFILE_BYTES, PROFILE_SCHEMA_VERSION,
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

fn inventory(folders: Vec<VaultFolder>, notes: Vec<VaultNote>) -> VaultInventory {
    VaultInventory { folders, notes }
}

#[test]
fn detects_para_from_the_complete_top_level_tree() {
    let vault = inventory(
        vec![
            folder("Projects", 3),
            folder("Areas", 8),
            folder("Resources", 12),
            folder("Archive", 30),
            folder("Areas/Programming", 5),
        ],
        vec![note("Areas/Programming/Rust.md")],
    );

    assert_eq!(detect_vault_scheme(&vault), VaultScheme::Para);
}

#[test]
fn detects_flat_zettelkasten_from_root_note_dominance() {
    let vault = inventory(
        vec![folder("attachments", 1)],
        (0..12).map(|n| note(&format!("{n}.md"))).collect(),
    );

    assert_eq!(detect_vault_scheme(&vault), VaultScheme::FlatZettelkasten);
}

#[test]
fn detects_populated_topic_folders() {
    let vault = inventory(
        vec![
            folder("Architecture", 9),
            folder("Gardening", 7),
            folder("Psychology", 4),
        ],
        vec![note("Architecture/Queues.md")],
    );

    assert_eq!(detect_vault_scheme(&vault), VaultScheme::TopicFolders);
}

#[test]
fn detects_repeated_year_month_paths() {
    let vault = inventory(
        vec![
            folder("2025/12", 10),
            folder("2026/01", 12),
            folder("2026/02", 8),
        ],
        vec![note("2026/02/2026-02-03.md")],
    );

    assert_eq!(detect_vault_scheme(&vault), VaultScheme::DateBased);
}

#[test]
fn detects_johnny_decimal_ranges_and_categories() {
    let vault = inventory(
        vec![
            folder("10-19 Programming", 20),
            folder("10-19 Programming/11 Architecture", 8),
            folder("20-29 Life", 14),
            folder("20-29 Life/21 Health", 5),
        ],
        vec![note("10-19 Programming/11 Architecture/Queues.md")],
    );

    assert_eq!(detect_vault_scheme(&vault), VaultScheme::JohnnyDecimal);
}

#[test]
fn mixed_structural_signals_are_unknown_instead_of_guessed() {
    let vault = inventory(
        vec![
            folder("2026/01", 4),
            folder("2026/02", 4),
            folder("10-19 Programming", 8),
            folder("10-19 Programming/11 Architecture", 8),
            folder("20-29 Life", 8),
            folder("20-29 Life/21 Health", 8),
        ],
        vec![],
    );

    assert_eq!(detect_vault_scheme(&vault), VaultScheme::Unknown);
}

#[test]
fn profile_round_trip_uses_the_versioned_per_skill_wire_shape() {
    let profile = VaultProfile {
        schema_version: PROFILE_SCHEMA_VERSION,
        skills: BTreeMap::from([(
            "youtube-distil".into(),
            SkillRoutingProfile {
                scheme: PersistedVaultScheme::TopicFolders,
                default_folder: Some("Programming/AI".into()),
                moc_policy: MocPolicy::ExistingConventionOnly,
            },
        )]),
    };

    let encoded = serialize_vault_profile(&profile).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(
        value["skills"]["youtube-distil"],
        serde_json::json!({
            "scheme": "topicFolders",
            "defaultFolder": "Programming/AI",
            "mocPolicy": "existingConventionOnly",
        })
    );
    assert_eq!(parse_vault_profile(&encoded).unwrap(), profile);
}

#[test]
fn profile_future_schema_version_precedes_future_shape_validation() {
    let error = parse_vault_profile(
        br#"{"schemaVersion":2,"skills":{},"futurePolicy":{"route":"adaptive"}}"#,
    )
    .unwrap_err();

    assert_eq!(error.detail(), "unsupported vault profile schema version");
}

#[test]
fn profile_garbage_reports_invalid_json() {
    let error = parse_vault_profile(b"{ definitely not JSON").unwrap_err();

    assert_eq!(error.detail(), "vault profile is not valid JSON");
}

#[test]
fn profile_current_schema_unknown_field_still_uses_strict_parse() {
    let error =
        parse_vault_profile(br#"{"schemaVersion":1,"skills":{},"extra":true}"#).unwrap_err();

    assert_eq!(error.detail(), "vault profile is not valid JSON");
}

#[test]
fn profile_rejects_unknown_fields_versions_and_unsafe_folders() {
    for raw in [
        r#"{"schemaVersion":2,"skills":{}}"#,
        r#"{"schemaVersion":1,"extra":true,"skills":{}}"#,
        r#"{"schemaVersion":1,"skills":{"youtube-distil":{"scheme":"topicFolders","defaultFolder":"/absolute","mocPolicy":"never"}}}"#,
        r#"{"schemaVersion":1,"skills":{"youtube-distil":{"scheme":"topicFolders","defaultFolder":"../escape","mocPolicy":"never"}}}"#,
        r#"{"schemaVersion":1,"skills":{"youtube-distil":{"scheme":"unknown","defaultFolder":null,"mocPolicy":"never"}}}"#,
    ] {
        assert!(parse_vault_profile(raw.as_bytes()).is_err(), "{raw}");
    }
}

#[test]
fn persisted_profile_wins_when_its_existing_folder_is_still_valid() {
    let vault = inventory(
        vec![folder("Architecture", 4), folder("Programming/AI", 7)],
        vec![
            note("Programming/AI/Agents.md"),
            note("Programming/AI/RAG.md"),
            note("Programming/AI/Third.md"),
        ],
    );
    let profile = SkillRoutingProfile {
        scheme: PersistedVaultScheme::TopicFolders,
        default_folder: Some("Programming/AI".into()),
        moc_policy: MocPolicy::ExistingConventionOnly,
    };

    let route = resolve_distil_route("agents", &vault, Some(&profile)).unwrap();

    assert_eq!(route.scheme, VaultScheme::TopicFolders);
    assert_eq!(route.suggested_folder.as_deref(), Some("Programming/AI"));
    assert_eq!(
        route.sample_note_paths,
        ["Programming/AI/Agents.md", "Programming/AI/RAG.md"]
    );
    assert!(route.why.contains("saved vault profile"));
    assert!(route.why.contains("existing MOC convention"));
}

#[test]
fn saved_never_moc_policy_is_visible_to_the_model_facing_route_reason() {
    let vault = inventory(vec![folder("Programming/AI", 2)], vec![]);
    let profile = SkillRoutingProfile {
        scheme: PersistedVaultScheme::TopicFolders,
        default_folder: Some("Programming/AI".into()),
        moc_policy: MocPolicy::Never,
    };

    let route = resolve_distil_route("AI", &vault, Some(&profile)).unwrap();

    assert!(route.why.contains("Do not create a playlist MOC"));
}

#[test]
fn para_resolution_uses_existing_areas_resources_projects_then_inbox() {
    let vault = inventory(
        vec![
            folder("Projects", 2),
            folder("Areas", 3),
            folder("Resources", 4),
            folder("Archive", 1),
            folder("Areas/Artificial Intelligence", 2),
            folder("Resources/Artificial Intelligence", 2),
            folder("Inbox", 1),
        ],
        vec![note("Areas/Artificial Intelligence/Agents.md")],
    );

    let route = resolve_distil_route("Artificial Intelligence", &vault, None).unwrap();

    assert_eq!(route.scheme, VaultScheme::Para);
    assert_eq!(
        route.suggested_folder.as_deref(),
        Some("Areas/Artificial Intelligence")
    );
}

#[test]
fn route_never_synthesizes_a_missing_topic_folder() {
    let vault = inventory(
        vec![folder("Architecture", 2), folder("Gardening", 2)],
        vec![note("Architecture/Queues.md")],
    );

    let route = resolve_distil_route("Artificial Intelligence", &vault, None).unwrap();

    assert_eq!(route.scheme, VaultScheme::TopicFolders);
    assert_eq!(route.suggested_folder, None);
    assert!(route.why.contains("ask the user"));
}

#[test]
fn empty_or_structurally_weak_inventory_is_unknown() {
    assert_eq!(
        detect_vault_scheme(&inventory(vec![], vec![])),
        VaultScheme::Unknown
    );
    assert_eq!(
        detect_vault_scheme(&inventory(
            vec![folder("Misc", 1)],
            vec![note("Misc/one.md")]
        )),
        VaultScheme::Unknown
    );
}

#[test]
fn profile_rejects_additional_unsafe_relative_folder_shapes() {
    for folder in [
        r"C:\escape",
        r"folder\child",
        "folder//child",
        "folder/./child",
        "folder/child.",
        "folder/child\nforged",
    ] {
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
}

#[test]
fn profile_raw_bytes_and_skill_count_are_bounded() {
    let oversized = vec![b' '; MAX_VAULT_PROFILE_BYTES + 1];
    assert!(parse_vault_profile(&oversized).is_err());

    let skills = (0..=MAX_PROFILE_SKILLS)
        .map(|index| {
            (
                format!("skill-{index}"),
                SkillRoutingProfile {
                    scheme: PersistedVaultScheme::FlatZettelkasten,
                    default_folder: None,
                    moc_policy: MocPolicy::Never,
                },
            )
        })
        .collect();
    let profile = VaultProfile {
        schema_version: PROFILE_SCHEMA_VERSION,
        skills,
    };

    assert!(serialize_vault_profile(&profile).is_err());
}

#[test]
fn unavailable_profile_io_fails_loudly_for_load_and_save() {
    let io = UnavailableVaultProfileIo;

    assert!(io.load().is_err());
    assert!(io.save(br#"{"schemaVersion":1,"skills":{}}"#).is_err());
}

#[test]
fn para_resolution_falls_through_only_to_existing_priority_folders() {
    let cases = [
        (
            vec![
                folder("Resources/AI", 2),
                folder("Projects/AI", 2),
                folder("Inbox", 1),
            ],
            Some("Resources/AI"),
        ),
        (
            vec![folder("Projects/AI", 2), folder("Inbox", 1)],
            Some("Projects/AI"),
        ),
        (vec![folder("Inbox", 1)], Some("Inbox")),
        (vec![], None),
    ];

    for (extra_folders, expected) in cases {
        let mut folders = vec![
            folder("Projects", 3),
            folder("Areas", 3),
            folder("Resources", 3),
            folder("Archive", 3),
        ];
        folders.extend(extra_folders);
        let route = resolve_distil_route("AI", &inventory(folders, vec![]), None).unwrap();

        assert_eq!(route.suggested_folder.as_deref(), expected);
    }
}

#[test]
fn stale_profile_folder_is_never_returned_or_recreated() {
    let vault = inventory(
        vec![folder("Architecture", 2), folder("Gardening", 2)],
        vec![note("Architecture/Queues.md")],
    );
    let profile = SkillRoutingProfile {
        scheme: PersistedVaultScheme::TopicFolders,
        default_folder: Some("Missing/AI".into()),
        moc_policy: MocPolicy::ExistingConventionOnly,
    };

    let route = resolve_distil_route("AI", &vault, Some(&profile)).unwrap();

    assert_eq!(route.suggested_folder, None);
    assert!(!route.why.contains("Missing/AI"));
    assert!(route.why.contains("ask the user"));
}

#[test]
fn route_topic_is_bounded_and_cannot_carry_control_characters() {
    let vault = inventory(
        vec![folder("Architecture", 2), folder("Gardening", 2)],
        vec![],
    );

    assert!(resolve_distil_route("", &vault, None).is_err());
    assert!(resolve_distil_route(&"x".repeat(201), &vault, None).is_err());
    assert!(resolve_distil_route("AI\nforged", &vault, None).is_err());
}

#[test]
fn every_persisted_scheme_routes_without_persisting_unknown() {
    let cases = [
        (
            PersistedVaultScheme::Para,
            inventory(
                vec![
                    folder("Projects", 1),
                    folder("Areas", 1),
                    folder("Resources", 1),
                    folder("Archive", 1),
                    folder("Areas/AI", 1),
                ],
                vec![],
            ),
            VaultScheme::Para,
            Some("Areas/AI"),
        ),
        (
            PersistedVaultScheme::FlatZettelkasten,
            inventory(
                vec![],
                vec![note("Zeta.md"), note("Alpha.md"), note("Beta.md")],
            ),
            VaultScheme::FlatZettelkasten,
            None,
        ),
        (
            PersistedVaultScheme::TopicFolders,
            inventory(vec![folder("AI", 1)], vec![]),
            VaultScheme::TopicFolders,
            Some("AI"),
        ),
        (
            PersistedVaultScheme::DateBased,
            inventory(vec![folder("2026/07", 1)], vec![]),
            VaultScheme::DateBased,
            None,
        ),
        (
            PersistedVaultScheme::JohnnyDecimal,
            inventory(
                vec![
                    folder("10-19 Programming", 1),
                    folder("10-19 Programming/11 AI", 1),
                ],
                vec![],
            ),
            VaultScheme::JohnnyDecimal,
            Some("10-19 Programming/11 AI"),
        ),
    ];

    for (scheme, vault, expected_scheme, expected_folder) in cases {
        let profile = SkillRoutingProfile {
            scheme,
            default_folder: None,
            moc_policy: MocPolicy::Never,
        };
        let route = resolve_distil_route("AI", &vault, Some(&profile)).unwrap();

        assert_eq!(route.scheme, expected_scheme);
        assert_eq!(route.suggested_folder.as_deref(), expected_folder);
        assert!(route.why.contains("saved vault profile"));
    }
}

#[test]
fn detected_schemes_explain_root_routes_and_missing_choices() {
    let flat = inventory(
        vec![],
        vec![
            note("Zeta.md"),
            note("alpha.md"),
            note("Beta.md"),
            note("Delta.md"),
            note("Epsilon.md"),
        ],
    );
    let flat_route = resolve_distil_route("AI", &flat, None).unwrap();
    assert_eq!(flat_route.scheme, VaultScheme::FlatZettelkasten);
    assert_eq!(flat_route.sample_note_paths, ["alpha.md", "Beta.md"]);
    assert!(flat_route.why.contains("vault root"));

    let date_route = resolve_distil_route(
        "AI",
        &inventory(
            vec![folder("2026/06", 1), folder("2026/07", 1)],
            vec![note("Unrelated.md")],
        ),
        None,
    )
    .unwrap();
    assert_eq!(date_route.scheme, VaultScheme::DateBased);
    assert!(date_route.sample_note_paths.is_empty());
    assert!(date_route.why.contains("ask the user"));

    let unknown_route =
        resolve_distil_route("AI", &inventory(vec![], vec![note("Unrelated.md")]), None).unwrap();
    assert_eq!(unknown_route.scheme, VaultScheme::Unknown);
    assert!(unknown_route.sample_note_paths.is_empty());
    assert!(unknown_route.why.contains("ask the user"));
}

#[test]
fn detected_topic_and_johnny_decimal_routes_only_return_inventory_paths() {
    let topic = inventory(
        vec![
            folder("AI", 3),
            folder("Deep/AI", 3),
            folder("Gardening", 3),
        ],
        vec![note("AI/Zeta.md"), note("AI/Alpha.md")],
    );
    let topic_route = resolve_distil_route("AI", &topic, None).unwrap();
    assert_eq!(topic_route.scheme, VaultScheme::TopicFolders);
    assert_eq!(topic_route.suggested_folder.as_deref(), Some("AI"));
    assert_eq!(topic_route.sample_note_paths, ["AI/Alpha.md", "AI/Zeta.md"]);

    let johnny = inventory(
        vec![
            folder("10-19 Programming", 4),
            folder("10-19 Programming/11 AI", 2),
            folder("20-29 Life", 4),
            folder("20-29 Life/21 Health", 2),
        ],
        vec![],
    );
    let johnny_route = resolve_distil_route("AI", &johnny, None).unwrap();
    assert_eq!(johnny_route.scheme, VaultScheme::JohnnyDecimal);
    assert_eq!(
        johnny_route.suggested_folder.as_deref(),
        Some("10-19 Programming/11 AI")
    );
}
