#[path = "youtube_support/route.rs"]
mod route_support;
mod support;
mod youtube_support;

use neuralnote_core::ai::tools::{ToolOutcome, TOOL_RESOLVE_DISTIL_ROUTE};
use neuralnote_core::ai::{KeywordRetriever, YoutubeToolSession};
use neuralnote_core::capture::{parse_vault_profile, PersistedVaultScheme};
use route_support::{write_note, ErrorProfileIo, FailingRetrieval, RetrievalFailure};
use std::fs;
use std::sync::Mutex;
use youtube_support::{call, MemoryProfileIo, PlaylistIo, ScriptedPrompt};

#[test]
fn unknown_scheme_elicits_existing_folder_and_persists_concrete_profile() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Programming/AI")).unwrap();
    fs::write(vault.path().join("Programming/AI/Agents.md"), "# Agents").unwrap();
    fs::write(vault.path().join("Programming/AI/RAG.md"), "# RAG").unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let prompt = ScriptedPrompt::with_answers([
        vec!["date_based".into()],
        vec!["folder:Programming/AI".into()],
    ]);
    let profile = MemoryProfileIo::default();

    let result = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":"Artificial Intelligence"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["scheme"], "dateBased");
    assert_eq!(value["suggested_folder"], "Programming/AI");
    assert_eq!(value["sample_note_paths"].as_array().unwrap().len(), 2);

    let saved = profile.saved.lock().unwrap();
    assert_eq!(saved.len(), 1);
    let persisted = parse_vault_profile(&saved[0]).unwrap();
    let route = &persisted.skills["youtube-distil"];
    assert_eq!(route.scheme, PersistedVaultScheme::DateBased);
    assert_eq!(route.default_folder.as_deref(), Some("Programming/AI"));
}

#[test]
fn unknown_large_vault_pages_route_options_instead_of_rejecting() {
    let vault = tempfile::tempdir().unwrap();
    for index in 0..201 {
        fs::create_dir(vault.path().join(format!("Folder{index:03}"))).unwrap();
    }
    let retriever = KeywordRetriever::new(vault.path());
    let prompt = ScriptedPrompt::with_answers([
        vec!["topic_folders".into()],
        vec!["next".into()],
        vec!["next".into()],
        vec!["next".into()],
        vec!["next".into()],
        vec!["folder:Folder200".into()],
    ]);
    let profile = MemoryProfileIo::default();

    let result = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":"Unmatched topic"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["suggested_folder"], "Folder200");
    let seen = prompt.seen.lock().unwrap();
    assert_eq!(seen.len(), 6);
    assert!(seen
        .iter()
        .all(|elicitation| elicitation.options.len() <= 52));
}

#[test]
fn route_rejects_malformed_arguments_invalid_topics_and_inventory_failures() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();

    let malformed = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":1}"#,
    );
    assert_eq!(malformed.outcome, ToolOutcome::Rejected);
    assert!(malformed
        .content
        .contains("invalid resolve_distil_route arguments"));

    let invalid_topic = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":""}"#,
    );
    assert_eq!(invalid_topic.outcome, ToolOutcome::Rejected);
    assert!(invalid_topic.content.contains("invalid_metadata"));

    for (failure, expected) in [
        (RetrievalFailure::Folders, "could not inspect vault folders"),
        (RetrievalFailure::Notes, "could not inspect vault notes"),
    ] {
        let result = call(
            vault.path(),
            &FailingRetrieval(failure),
            &PlaylistIo::default(),
            &mut YoutubeToolSession::default(),
            &profile,
            &prompt,
            TOOL_RESOLVE_DISTIL_ROUTE,
            r#"{"topic":"Testing"}"#,
        );
        assert_eq!(result.outcome, ToolOutcome::Rejected);
        assert!(result.content.contains(expected), "{}", result.content);
    }
}

#[test]
fn route_surfaces_profile_load_parse_and_save_failures() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let prompt = ScriptedPrompt::default();

    let load_failure = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &ErrorProfileIo {
            fail_load: true,
            fail_save: false,
        },
        &prompt,
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":"Testing"}"#,
    );
    assert_eq!(load_failure.outcome, ToolOutcome::Rejected);
    assert!(load_failure.content.contains("profile load failed"));

    let malformed_profile = MemoryProfileIo {
        loaded: Mutex::new(Some(b"not json".to_vec())),
        saved: Mutex::new(Vec::new()),
    };
    let parse_failure = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &malformed_profile,
        &prompt,
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":"Testing"}"#,
    );
    assert_eq!(parse_failure.outcome, ToolOutcome::Rejected);
    assert!(parse_failure.content.contains("profile_invalid"));

    let prompt = ScriptedPrompt::with_answers([vec!["flat_zettelkasten".into()]]);
    let save_failure = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &ErrorProfileIo {
            fail_load: false,
            fail_save: true,
        },
        &prompt,
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":"Testing"}"#,
    );
    assert_eq!(save_failure.outcome, ToolOutcome::Rejected);
    assert!(save_failure.content.contains("profile save failed"));
}

#[test]
fn route_uses_a_valid_loaded_profile_without_prompting_or_rewriting_it() {
    let vault = tempfile::tempdir().unwrap();
    write_note(vault.path(), "Programming/Neighbour.md");
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo {
        loaded: Mutex::new(Some(
            br#"{
                "schemaVersion": 1,
                "skills": {
                    "youtube-distil": {
                        "scheme": "topicFolders",
                        "defaultFolder": "Programming",
                        "mocPolicy": "existingConventionOnly"
                    }
                }
            }"#
            .to_vec(),
        )),
        saved: Mutex::new(Vec::new()),
    };
    let prompt = ScriptedPrompt::default();

    let result = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":"Testing"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["scheme"], "topicFolders");
    assert_eq!(value["suggested_folder"], "Programming");
    assert_eq!(
        value["sample_note_paths"],
        serde_json::json!(["Programming/Neighbour.md"])
    );
    assert!(prompt.seen.lock().unwrap().is_empty());
    assert!(profile.saved.lock().unwrap().is_empty());
}

#[test]
fn detected_flat_vault_routes_to_root_without_elicitation() {
    let vault = tempfile::tempdir().unwrap();
    for index in 0..5 {
        write_note(vault.path(), &format!("Root {index}.md"));
    }
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();

    let result = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":"Testing"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["scheme"], "flatZettelkasten");
    assert!(value["suggested_folder"].is_null());
    assert_eq!(value["sample_note_paths"].as_array().unwrap().len(), 2);
    assert!(prompt.seen.lock().unwrap().is_empty());
    assert!(profile.saved.lock().unwrap().is_empty());
}

#[test]
fn route_surfaces_scheme_and_folder_prompt_rejection() {
    let unknown_vault = tempfile::tempdir().unwrap();
    let unknown_retriever = KeywordRetriever::new(unknown_vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();
    let scheme_rejection = call(
        unknown_vault.path(),
        &unknown_retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":"Testing"}"#,
    );
    assert_eq!(scheme_rejection.outcome, ToolOutcome::Rejected);
    assert!(scheme_rejection.content.contains("scheme selection failed"));

    let dated_vault = tempfile::tempdir().unwrap();
    fs::create_dir_all(dated_vault.path().join("2025/01")).unwrap();
    fs::create_dir_all(dated_vault.path().join("2025/02")).unwrap();
    let dated_retriever = KeywordRetriever::new(dated_vault.path());
    let route_rejection = call(
        dated_vault.path(),
        &dated_retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &ScriptedPrompt::default(),
        TOOL_RESOLVE_DISTIL_ROUTE,
        r#"{"topic":"Testing"}"#,
    );
    assert_eq!(route_rejection.outcome, ToolOutcome::Rejected);
    assert!(route_rejection.content.contains("route selection failed"));
}

#[test]
fn detected_schemes_persist_only_existing_selected_folders() {
    struct Case {
        scheme: PersistedVaultScheme,
        selected_folder: &'static str,
        setup: fn(&std::path::Path),
    }

    let cases = [
        Case {
            scheme: PersistedVaultScheme::Para,
            selected_folder: "Resources",
            setup: |vault| {
                for folder in ["Projects", "Areas", "Resources", "Archive"] {
                    fs::create_dir_all(vault.join(folder)).unwrap();
                }
            },
        },
        Case {
            scheme: PersistedVaultScheme::TopicFolders,
            selected_folder: "Cooking",
            setup: |vault| {
                for folder in ["Programming", "Cooking"] {
                    write_note(vault, &format!("{folder}/One.md"));
                    write_note(vault, &format!("{folder}/Two.md"));
                }
            },
        },
        Case {
            scheme: PersistedVaultScheme::DateBased,
            selected_folder: "2025/01",
            setup: |vault| {
                fs::create_dir_all(vault.join("2025/01")).unwrap();
                fs::create_dir_all(vault.join("2025/02")).unwrap();
            },
        },
        Case {
            scheme: PersistedVaultScheme::JohnnyDecimal,
            selected_folder: "10-19 Personal/10 Health",
            setup: |vault| {
                fs::create_dir_all(vault.join("10-19 Personal/10 Health")).unwrap();
                fs::create_dir_all(vault.join("20-29 Work/20 Projects")).unwrap();
            },
        },
    ];

    for case in cases {
        let vault = tempfile::tempdir().unwrap();
        (case.setup)(vault.path());
        let retriever = KeywordRetriever::new(vault.path());
        let profile = MemoryProfileIo::default();
        let prompt =
            ScriptedPrompt::with_answers([vec![format!("folder:{}", case.selected_folder)]]);

        let result = call(
            vault.path(),
            &retriever,
            &PlaylistIo::default(),
            &mut YoutubeToolSession::default(),
            &profile,
            &prompt,
            TOOL_RESOLVE_DISTIL_ROUTE,
            r#"{"topic":"Unmatched"}"#,
        );

        assert_eq!(result.outcome, ToolOutcome::Action, "{}", result.content);
        let saved = profile.saved.lock().unwrap();
        assert_eq!(saved.len(), 1);
        let persisted = parse_vault_profile(&saved[0]).unwrap();
        let routing = &persisted.skills["youtube-distil"];
        assert_eq!(routing.scheme, case.scheme);
        assert_eq!(
            routing.default_folder.as_deref(),
            Some(case.selected_folder)
        );
    }
}

#[test]
fn unknown_scheme_can_persist_each_remaining_user_selected_scheme() {
    let cases = [
        ("para", Some("Holding"), PersistedVaultScheme::Para),
        (
            "flat_zettelkasten",
            None,
            PersistedVaultScheme::FlatZettelkasten,
        ),
        (
            "johnny_decimal",
            Some("Holding"),
            PersistedVaultScheme::JohnnyDecimal,
        ),
    ];

    for (answer, folder, expected) in cases {
        let vault = tempfile::tempdir().unwrap();
        if let Some(folder) = folder {
            fs::create_dir_all(vault.path().join(folder)).unwrap();
        }
        let retriever = KeywordRetriever::new(vault.path());
        let profile = MemoryProfileIo::default();
        let mut answers = vec![vec![answer.into()]];
        if let Some(folder) = folder {
            answers.push(vec![format!("folder:{folder}")]);
        }
        let prompt = ScriptedPrompt::with_answers(answers);

        let result = call(
            vault.path(),
            &retriever,
            &PlaylistIo::default(),
            &mut YoutubeToolSession::default(),
            &profile,
            &prompt,
            TOOL_RESOLVE_DISTIL_ROUTE,
            r#"{"topic":"Testing"}"#,
        );

        assert_eq!(result.outcome, ToolOutcome::Action, "{}", result.content);
        let saved = profile.saved.lock().unwrap();
        let persisted = parse_vault_profile(&saved[0]).unwrap();
        assert_eq!(persisted.skills["youtube-distil"].scheme, expected);
    }
}
