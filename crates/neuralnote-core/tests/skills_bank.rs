use neuralnote_core::ai::skills::YOUTUBE_DISTIL_SKILL_ID;
use neuralnote_core::ai::{
    ActiveSkills, Eligibility, HardwareSpec, Requirement, RequirementStatus, SkillEnvironment,
    SkillLookupError, SkillManifest, SkillRegistry, FIXTURE_SKILL_ID,
};
use std::collections::BTreeSet;
use std::path::PathBuf;

fn hardware(os: &str, arch: &str, free_disk_bytes: u64) -> HardwareSpec {
    HardwareSpec {
        total_ram_bytes: 16_000_000_000,
        cpu_cores: 8,
        cpu_brand: "test cpu".into(),
        gpu_label: None,
        arch: arch.into(),
        os: os.into(),
        free_disk_bytes,
    }
}

fn environment(os: &str, arch: &str, free_disk_bytes: u64, binaries: &[&str]) -> SkillEnvironment {
    let bin_dir = PathBuf::from("/app-data/bin");
    environment_with_available(
        os,
        arch,
        free_disk_bytes,
        binaries
            .iter()
            .map(|name| bin_dir.join(name))
            .collect::<BTreeSet<_>>(),
    )
}

fn environment_with_available(
    os: &str,
    arch: &str,
    free_disk_bytes: u64,
    available_binaries: BTreeSet<PathBuf>,
) -> SkillEnvironment {
    SkillEnvironment {
        hardware: hardware(os, arch, free_disk_bytes),
        available_binaries,
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
    }
}

fn registry_with_requirements(requirements: Vec<Requirement>) -> SkillRegistry {
    SkillRegistry::new(
        vec![SkillManifest {
            id: "requirements-fixture".into(),
            name: "Requirements fixture".into(),
            version: "1.0.0".into(),
            description: "Exercise per-requirement settings state.".into(),
            icon: "test-tube".into(),
            instructions: "These instructions must not appear in a listing.".into(),
            tools: Vec::new(),
            requirements,
            optional_requirements: Vec::new(),
            max_iterations: None,
            max_context_chars: None,
        }],
        &[],
    )
    .unwrap()
}

#[test]
fn eligible_display_uses_the_documented_string() {
    assert_eq!(Eligibility::Eligible.to_string(), "eligible");
}

#[test]
fn unmet_display_joins_reasons_with_semicolons() {
    let eligibility = Eligibility::Unmet {
        reasons: vec!["disk is too small".into(), "binary is missing".into()],
    };

    assert_eq!(
        eligibility.to_string(),
        "unmet requirements: disk is too small; binary is missing"
    );
}

#[test]
fn undetected_display_joins_reasons_with_semicolons() {
    let eligibility = Eligibility::Undetected {
        reasons: vec!["OS is unknown".into(), "architecture is unknown".into()],
    };

    assert_eq!(
        eligibility.to_string(),
        "requirements could not be detected: OS is unknown; architecture is unknown"
    );
}

#[test]
fn mixed_display_joins_unmet_and_undetected_reasons() {
    let eligibility = Eligibility::UnmetAndUndetected {
        unmet: vec!["disk is too small".into(), "binary is missing".into()],
        undetected: vec!["OS is unknown".into(), "architecture is unknown".into()],
    };

    assert_eq!(
        eligibility.to_string(),
        "unmet requirements: disk is too small; binary is missing; requirements could not be detected: OS is unknown; architecture is unknown"
    );
}

#[test]
fn built_in_fixture_manifest_is_complete_and_instruction_backed() {
    let registry = SkillRegistry::built_in(&[]).unwrap();
    let skill = registry.lookup(FIXTURE_SKILL_ID).unwrap();

    assert_eq!(skill.id, FIXTURE_SKILL_ID);
    assert!(!skill.name.is_empty());
    assert_eq!(skill.version, "1.0.0");
    assert!(!skill.description.is_empty());
    assert!(!skill.icon.is_empty());
    assert!(skill.instructions.contains("# Fixture skill"));
    assert_eq!(skill.tools, ["skill_step", "ask_user", "write_note"]);
    assert!(skill.requirements.is_empty());
    assert_eq!(skill.max_iterations, Some(12));
    assert_eq!(skill.max_context_chars, None);
}

#[test]
fn youtube_manifest_freezes_tools_requirement_tiers_and_iteration_ceiling() {
    let registry = SkillRegistry::built_in(&[]).unwrap();
    let skill = registry.lookup(YOUTUBE_DISTIL_SKILL_ID).unwrap();

    assert_eq!(skill.version, "1.0.0");
    assert_eq!(skill.max_iterations, Some(16));
    assert_eq!(skill.max_context_chars, Some(96_000));
    assert_eq!(
        skill.tools,
        [
            "skill_step",
            "ask_user",
            "write_note",
            "fetch_video_info",
            "fetch_captions",
            "transcribe_audio",
            "select_playlist_videos",
            "resolve_distil_route",
        ]
    );
    assert_eq!(
        skill.requirements,
        [Requirement::Binary {
            name: "yt-dlp".into(),
        }]
    );
    assert_eq!(
        skill.optional_requirements,
        [
            Requirement::Binary {
                name: "whisper-cli".into(),
            },
            Requirement::Asset {
                name: "ggml-small.en.bin".into(),
            },
            Requirement::FreeDiskSpace {
                min_bytes: 1_000_000_000,
            },
        ]
    );
    assert!(skill.instructions.contains("# YouTube distil"));
    assert!(skill.instructions.contains("never invent a folder"));
    assert!(skill.instructions.contains("concept-scoped"));
    assert!(skill.instructions.contains("compiles whisper-cli locally"));
    assert!(skill.instructions.contains("Xcode Command Line Tools"));
    assert!(skill.instructions.contains("CMake 3.28"));
    assert!(skill.instructions.contains("several minutes"));
}

#[test]
fn youtube_skill_activates_with_yt_dlp_alone() {
    let registry = SkillRegistry::built_in(&[]).unwrap();
    let environment = environment("macos", "aarch64", 2_000_000_000, &["yt-dlp"]);
    let mut active = ActiveSkills::new(8);

    let activation = active
        .activate(YOUTUBE_DISTIL_SKILL_ID, &registry, &environment)
        .unwrap();

    assert!(activation.newly_activated);
    assert!(active.contains(YOUTUBE_DISTIL_SKILL_ID));
}

#[test]
fn youtube_skill_can_ship_disabled_without_hiding_its_settings_listing() {
    let registry = SkillRegistry::built_in(&[YOUTUBE_DISTIL_SKILL_ID.into()]).unwrap();

    assert!(matches!(
        registry.lookup(YOUTUBE_DISTIL_SKILL_ID),
        Err(SkillLookupError::Disabled(id)) if id == YOUTUBE_DISTIL_SKILL_ID
    ));
    let listing = registry
        .listings(&environment("macos", "aarch64", 2_000_000_000, &[]))
        .into_iter()
        .find(|listing| listing.id == YOUTUBE_DISTIL_SKILL_ID)
        .expect("disabled YouTube skill remains visible in Settings");
    assert!(!listing.enabled);
}

#[test]
fn catalogue_is_compact_and_excludes_full_instructions() {
    let registry = SkillRegistry::built_in(&[YOUTUBE_DISTIL_SKILL_ID.into()]).unwrap();
    let skill = registry.lookup(FIXTURE_SKILL_ID).unwrap();

    assert_eq!(
        registry.catalogue(),
        format!("{}: {}", skill.id, skill.description)
    );
    assert!(!registry.catalogue().contains("# Fixture skill"));
    assert_eq!(registry.catalogue().lines().count(), 1);
}

#[test]
fn disabled_and_unknown_skill_lookups_are_distinct() {
    let disabled = SkillRegistry::built_in(&[
        FIXTURE_SKILL_ID.to_string(),
        YOUTUBE_DISTIL_SKILL_ID.to_string(),
    ])
    .unwrap();
    assert!(disabled.catalogue().is_empty());
    assert!(matches!(
        disabled.lookup(FIXTURE_SKILL_ID),
        Err(SkillLookupError::Disabled(id)) if id == FIXTURE_SKILL_ID
    ));
    assert!(matches!(
        disabled.lookup("not-a-skill"),
        Err(SkillLookupError::Unknown(id)) if id == "not-a-skill"
    ));

    let registry = SkillRegistry::built_in(&["future-skill".into()]).unwrap();
    assert!(registry.lookup(FIXTURE_SKILL_ID).is_ok());
}

#[test]
fn unknown_skill_error_display_names_the_skill() {
    let registry = SkillRegistry::built_in(&[]).unwrap();

    let error = registry.lookup("not-a-skill").unwrap_err();

    assert!(matches!(
        &error,
        SkillLookupError::Unknown(id) if id == "not-a-skill"
    ));
    assert_eq!(error.to_string(), "unknown skill 'not-a-skill'");
}

#[test]
fn disabled_skill_error_display_names_the_skill() {
    let registry = SkillRegistry::built_in(&[FIXTURE_SKILL_ID.into()]).unwrap();

    let error = registry.lookup(FIXTURE_SKILL_ID).unwrap_err();

    assert!(matches!(
        &error,
        SkillLookupError::Disabled(id) if id == FIXTURE_SKILL_ID
    ));
    assert_eq!(
        error.to_string(),
        format!("skill '{FIXTURE_SKILL_ID}' is disabled")
    );
}

#[test]
fn registry_rejects_duplicate_skill_ids() {
    let manifest = SkillManifest {
        id: "duplicate-skill".into(),
        name: "Duplicate skill".into(),
        version: "1.0.0".into(),
        description: "Exercise duplicate-id validation.".into(),
        icon: "copy".into(),
        instructions: "Duplicate fixture instructions.".into(),
        tools: Vec::new(),
        requirements: Vec::new(),
        optional_requirements: Vec::new(),
        max_iterations: None,
        max_context_chars: None,
    };

    let error = SkillRegistry::new(vec![manifest.clone(), manifest], &[]).unwrap_err();

    assert!(matches!(
        &error,
        SkillLookupError::Duplicate(id) if id == "duplicate-skill"
    ));
    assert_eq!(error.to_string(), "duplicate skill id 'duplicate-skill'");
}

#[test]
fn listings_include_the_enabled_fixture_without_instructions() {
    let registry = SkillRegistry::built_in(&[YOUTUBE_DISTIL_SKILL_ID.into()]).unwrap();
    let manifest = registry.lookup(FIXTURE_SKILL_ID).unwrap();

    let listings = registry.listings(&environment("macos", "aarch64", 1, &[]));

    let listing = listings
        .iter()
        .find(|listing| listing.id == FIXTURE_SKILL_ID)
        .unwrap();
    assert_eq!(listing.id, manifest.id);
    assert_eq!(listing.name, manifest.name);
    assert_eq!(listing.description, manifest.description);
    assert_eq!(listing.icon, manifest.icon);
    assert!(listing.enabled);
    assert!(listing.requirements.is_empty());
    assert!(serde_json::to_value(listing)
        .unwrap()
        .get("instructions")
        .is_none());
}

#[test]
fn listings_include_the_disabled_fixture() {
    let registry =
        SkillRegistry::built_in(&[FIXTURE_SKILL_ID.into(), YOUTUBE_DISTIL_SKILL_ID.into()])
            .unwrap();

    let listings = registry.listings(&environment("macos", "aarch64", 1, &[]));

    let listing = listings
        .iter()
        .find(|listing| listing.id == FIXTURE_SKILL_ID)
        .unwrap();
    assert!(!listing.enabled);
}

#[test]
fn contains_id_validates_skills_independently_of_disabled_state() {
    let enabled = SkillRegistry::built_in(&[]).unwrap();
    let disabled = SkillRegistry::built_in(&[FIXTURE_SKILL_ID.into()]).unwrap();

    assert!(enabled.contains_id(FIXTURE_SKILL_ID));
    assert!(disabled.contains_id(FIXTURE_SKILL_ID));
    assert!(!disabled.contains_id("not-a-skill"));
}

#[test]
fn listing_maps_an_eligible_binary_requirement_to_installed() {
    let registry = registry_with_requirements(vec![Requirement::Binary {
        name: "fixture-bin".into(),
    }]);

    let listings = registry.listings(&environment("macos", "aarch64", 1, &["fixture-bin"]));

    assert_eq!(
        listings[0].requirements[0].status,
        RequirementStatus::Installed
    );
}

#[test]
fn listing_maps_an_eligible_asset_requirement_to_installed() {
    let registry = registry_with_requirements(vec![Requirement::Asset {
        name: "bgutil-plugin.zip".into(),
    }]);
    let environment = environment_with_available(
        "macos",
        "aarch64",
        1,
        BTreeSet::from([PathBuf::from("/app-data/assets/bgutil-plugin.zip")]),
    );

    let listings = registry.listings(&environment);

    assert_eq!(
        listings[0].requirements[0].status,
        RequirementStatus::Installed
    );
}

#[test]
fn asset_in_bin_does_not_satisfy_an_asset_requirement() {
    let result = Eligibility::evaluate(
        &[Requirement::Asset {
            name: "shared-name".into(),
        }],
        &environment("macos", "aarch64", 1, &["shared-name"]),
    );

    assert!(matches!(result, Eligibility::Unmet { .. }));
}

#[test]
fn binary_in_assets_does_not_satisfy_a_binary_requirement() {
    let environment = environment_with_available(
        "macos",
        "aarch64",
        1,
        BTreeSet::from([PathBuf::from("/app-data/assets/shared-name")]),
    );
    let result = Eligibility::evaluate(
        &[Requirement::Binary {
            name: "shared-name".into(),
        }],
        &environment,
    );

    assert!(matches!(result, Eligibility::Unmet { .. }));
}

#[test]
fn missing_asset_requirement_is_named_as_a_non_executable_asset() {
    let result = Eligibility::evaluate(
        &[Requirement::Asset {
            name: "bgutil-plugin.zip".into(),
        }],
        &environment("macos", "aarch64", 1, &[]),
    );

    assert!(matches!(
        result,
        Eligibility::Unmet { reasons }
            if reasons == ["required asset 'bgutil-plugin.zip' is missing from the app-data assets directory"]
    ));
}

#[test]
fn asset_requirement_serializes_additively() {
    assert_eq!(
        serde_json::to_value(Requirement::Asset {
            name: "ggml-small.en.bin".into(),
        })
        .unwrap(),
        serde_json::json!({
            "type": "asset",
            "name": "ggml-small.en.bin",
        })
    );
}

#[test]
fn listing_preserves_unmet_requirement_reasons() {
    let registry = registry_with_requirements(vec![Requirement::FreeDiskSpace { min_bytes: 100 }]);

    let listings = registry.listings(&environment("macos", "aarch64", 99, &[]));

    assert_eq!(
        listings[0].requirements[0].status,
        RequirementStatus::Unmet {
            reasons: vec!["free disk space is below the required 100 bytes".into()],
        }
    );
}

#[test]
fn listing_preserves_undetected_requirement_reasons() {
    let registry = registry_with_requirements(vec![Requirement::FreeDiskSpace { min_bytes: 100 }]);

    let listings = registry.listings(&environment("macos", "aarch64", 0, &[]));

    assert_eq!(
        listings[0].requirements[0].status,
        RequirementStatus::Undetected {
            reasons: vec!["free disk space could not be detected".into()],
        }
    );
}

#[test]
fn listing_preserves_mixed_platform_requirement_reasons() {
    let registry = registry_with_requirements(vec![Requirement::Platform {
        os: "macos".into(),
        arch: "aarch64".into(),
    }]);

    let listings = registry.listings(&environment("linux", "", 1, &[]));

    assert_eq!(
        listings[0].requirements[0].status,
        RequirementStatus::UnmetAndUndetected {
            unmet: vec!["platform OS requires macos/aarch64, detected linux/".into()],
            undetected: vec!["platform architecture could not be detected".into()],
        }
    );
}

#[test]
fn listings_serialize_the_camel_case_settings_contract() {
    let registry = registry_with_requirements(vec![Requirement::FreeDiskSpace { min_bytes: 100 }]);
    let listings = registry.listings(&environment("macos", "aarch64", 99, &[]));

    let value = serde_json::to_value(&listings[0]).unwrap();

    assert_eq!(
        value,
        serde_json::json!({
            "id": "requirements-fixture",
            "name": "Requirements fixture",
            "description": "Exercise per-requirement settings state.",
            "icon": "test-tube",
            "enabled": true,
            "requirements": [{
                "requirement": {
                    "type": "freeDiskSpace",
                    "minBytes": 100
                },
                "status": {
                    "status": "unmet",
                    "reasons": ["free disk space is below the required 100 bytes"]
                }
            }]
        })
    );
}

#[test]
fn eligibility_accepts_matching_platform_disk_and_binary() {
    let requirements = vec![
        Requirement::Platform {
            os: "macos".into(),
            arch: "aarch64".into(),
        },
        Requirement::FreeDiskSpace {
            min_bytes: 2_000_000_000,
        },
        Requirement::Binary {
            name: "fixture-bin".into(),
        },
    ];

    assert_eq!(
        Eligibility::evaluate(
            &requirements,
            &environment("macos", "aarch64", 3_000_000_000, &["fixture-bin"]),
        ),
        Eligibility::Eligible
    );
}

#[test]
fn eligibility_reports_platform_disk_and_binary_as_unmet() {
    let requirements = vec![
        Requirement::Platform {
            os: "macos".into(),
            arch: "aarch64".into(),
        },
        Requirement::FreeDiskSpace { min_bytes: 100 },
        Requirement::Binary {
            name: "fixture-bin".into(),
        },
    ];

    let result = Eligibility::evaluate(&requirements, &environment("linux", "x86_64", 99, &[]));
    let Eligibility::Unmet { reasons } = result else {
        panic!("expected unmet requirements, got {result:?}");
    };
    assert_eq!(reasons.len(), 3);
    assert!(reasons.iter().any(|reason| reason.contains("platform")));
    assert!(reasons.iter().any(|reason| reason.contains("disk")));
    assert!(reasons.iter().any(|reason| reason.contains("fixture-bin")));
}

#[test]
fn zero_disk_is_undetected_instead_of_unmet() {
    assert!(matches!(
        Eligibility::evaluate(
            &[Requirement::FreeDiskSpace { min_bytes: 1 }],
            &environment("macos", "aarch64", 0, &[]),
        ),
        Eligibility::Undetected { reasons } if reasons.iter().any(|reason| reason.contains("disk"))
    ));
}

#[test]
fn mixed_detection_failure_and_unmet_requirement_preserves_both() {
    let result = Eligibility::evaluate(
        &[
            Requirement::Platform {
                os: "macos".into(),
                arch: "aarch64".into(),
            },
            Requirement::FreeDiskSpace { min_bytes: 1 },
        ],
        &environment("linux", "x86_64", 0, &[]),
    );

    assert!(matches!(
        result,
        Eligibility::UnmetAndUndetected { unmet, undetected }
            if unmet.len() == 1 && undetected.len() == 1
    ));
}

#[test]
fn missing_binary_probe_directory_is_a_detection_failure() {
    let mut env = environment("macos", "aarch64", 1, &[]);
    env.app_data_bin_dir = PathBuf::new();

    assert!(matches!(
        Eligibility::evaluate(&[Requirement::Binary { name: "x".into() }], &env,),
        Eligibility::Undetected { .. }
    ));
}

#[test]
fn eligibility_reuses_requirement_binary_name_validation() {
    let mut env = environment("macos", "aarch64", 1, &[]);
    let invalid_name = "bad\nname";
    env.available_binaries
        .insert(env.app_data_bin_dir.join(invalid_name));

    assert!(matches!(
        Eligibility::evaluate(
            &[Requirement::Binary {
                name: invalid_name.into(),
            }],
            &env,
        ),
        Eligibility::Unmet { reasons }
            if reasons.iter().any(|reason| reason.contains("not a valid file name"))
    ));
}

#[test]
fn platform_and_disk_matrix_isolates_each_boundary() {
    struct Case {
        os: &'static str,
        arch: &'static str,
        disk: u64,
        expected: &'static str,
    }

    for case in [
        Case {
            os: "macos",
            arch: "aarch64",
            disk: 100,
            expected: "eligible",
        },
        Case {
            os: "linux",
            arch: "aarch64",
            disk: 100,
            expected: "unmet",
        },
        Case {
            os: "macos",
            arch: "x86_64",
            disk: 100,
            expected: "unmet",
        },
        Case {
            os: "macos",
            arch: "aarch64",
            disk: 99,
            expected: "unmet",
        },
        Case {
            os: "macos",
            arch: "aarch64",
            disk: 0,
            expected: "undetected",
        },
    ] {
        let result = Eligibility::evaluate(
            &[
                Requirement::Platform {
                    os: "macos".into(),
                    arch: "aarch64".into(),
                },
                Requirement::FreeDiskSpace { min_bytes: 100 },
            ],
            &environment(case.os, case.arch, case.disk, &[]),
        );
        let actual = match result {
            Eligibility::Eligible => "eligible",
            Eligibility::Unmet { .. } => "unmet",
            Eligibility::Undetected { .. } => "undetected",
            Eligibility::UnmetAndUndetected { .. } => "mixed",
        };
        assert_eq!(
            actual, case.expected,
            "{}/{}/{}",
            case.os, case.arch, case.disk
        );
    }
}

#[test]
fn partially_detected_platform_preserves_known_mismatch_and_unknown_axis() {
    let result = Eligibility::evaluate(
        &[Requirement::Platform {
            os: "macos".into(),
            arch: "aarch64".into(),
        }],
        &environment("linux", "", 1, &[]),
    );

    assert!(matches!(
        result,
        Eligibility::UnmetAndUndetected { unmet, undetected }
            if unmet.iter().any(|reason| reason.contains("OS"))
                && undetected.iter().any(|reason| reason.contains("architecture"))
    ));
}

#[test]
fn undetected_platform_reports_both_missing_axes() {
    let result = Eligibility::evaluate(
        &[Requirement::Platform {
            os: "macos".into(),
            arch: "aarch64".into(),
        }],
        &environment("", "", 1, &[]),
    );

    let Eligibility::Undetected { reasons } = result else {
        panic!("expected undetected requirements, got {result:?}");
    };
    assert_eq!(
        reasons,
        [
            "platform OS could not be detected",
            "platform architecture could not be detected",
        ]
    );
}

#[test]
fn platform_mismatch_names_both_axes() {
    let result = Eligibility::evaluate(
        &[Requirement::Platform {
            os: "macos".into(),
            arch: "aarch64".into(),
        }],
        &environment("linux", "x86_64", 1, &[]),
    );

    let Eligibility::Unmet { reasons } = result else {
        panic!("expected unmet requirements, got {result:?}");
    };
    assert_eq!(reasons.len(), 1);
    assert!(reasons[0].contains("platform OS/architecture"));
}
