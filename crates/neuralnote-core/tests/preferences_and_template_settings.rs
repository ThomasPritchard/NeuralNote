use std::fs;

use chrono::{Local, TimeZone};
use neuralnote_core::preferences::{
    load_app_preferences, save_app_preferences, AppPreferences, FontFamily, FontScale, ThemeId,
};
use neuralnote_core::templates::{
    list_templates, load_template_settings, preview_template_format, reset_template_settings,
    save_template_settings, TemplateSettings, TemplateSettingsSource,
};

#[test]
fn app_preferences_default_to_the_dark_neural_theme() {
    let preferences = AppPreferences::default();

    assert!(preferences.automatic_update_checks);
    assert_eq!(preferences.theme, ThemeId::NeuralVioletDark);
    assert_eq!(preferences.font_scale, FontScale::Default);
    assert_eq!(preferences.font_family, FontFamily::Inter);
    assert_eq!(preferences.last_seen_whats_new_version, None);
}

#[test]
fn preferences_migrate_a_pre_0_2_file_without_hiding_whats_new() {
    let config = tempfile::tempdir().unwrap();
    fs::write(
        config.path().join("preferences.json"),
        r#"{"automaticUpdateChecks":false,"theme":"forestDark","fontScale":"small","fontFamily":"inter"}"#,
    )
    .unwrap();

    let loaded = load_app_preferences(config.path()).unwrap();

    assert!(!loaded.recovered_from_corrupt);
    assert_eq!(loaded.preferences.theme, ThemeId::ForestDark);
    assert_eq!(loaded.preferences.last_seen_whats_new_version, None);
}

#[test]
fn missing_preferences_file_loads_defaults_without_reporting_recovery() {
    let config = tempfile::tempdir().unwrap();

    let loaded = load_app_preferences(config.path()).unwrap();

    assert_eq!(loaded.preferences, AppPreferences::default());
    assert!(!loaded.recovered_from_corrupt);
    assert!(loaded.recovery_message.is_none());
}

#[test]
fn corrupt_preferences_recover_safely_with_a_transient_update_check_suppression_signal() {
    let config = tempfile::tempdir().unwrap();
    fs::write(config.path().join("preferences.json"), "{not-json").unwrap();

    let loaded = load_app_preferences(config.path()).unwrap();

    assert!(loaded.recovered_from_corrupt);
    assert!(
        loaded.preferences.automatic_update_checks,
        "the persisted preference remains default-on; recoveredFromCorrupt suppresses only this launch"
    );
    assert!(loaded.recovery_message.as_deref().is_some_and(|message| {
        message.contains("preferences.json") && message.contains("parse")
    }));
    assert_eq!(
        fs::read_to_string(config.path().join("preferences.json")).unwrap(),
        "{not-json",
        "loading must not overwrite the corrupt file"
    );

    let mut edited = loaded.preferences;
    edited.theme = ThemeId::ForestLight;
    save_app_preferences(config.path(), &edited).unwrap();
    let reloaded = load_app_preferences(config.path()).unwrap();
    assert_eq!(reloaded.preferences.theme, ThemeId::ForestLight);
    assert!(
        reloaded.preferences.automatic_update_checks,
        "an unrelated appearance save must not persist launch-only update suppression"
    );
}

#[test]
fn preferences_round_trip_atomically_without_leaking_temp_files() {
    let config = tempfile::tempdir().unwrap();
    let preferences = AppPreferences {
        automatic_update_checks: false,
        theme: ThemeId::OceanBlueLight,
        font_scale: FontScale::Large,
        font_family: FontFamily::AtkinsonHyperlegible,
        last_seen_whats_new_version: Some("0.2.0".into()),
    };

    save_app_preferences(config.path(), &preferences).unwrap();

    let loaded = load_app_preferences(config.path()).unwrap();
    assert_eq!(loaded.preferences, preferences);
    assert!(!loaded.recovered_from_corrupt);
    assert!(fs::read_dir(config.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".nn-tmp")));
}

#[test]
fn whats_new_version_rejects_oversized_or_non_version_input_before_persistence() {
    let config = tempfile::tempdir().unwrap();
    let mut preferences = AppPreferences {
        last_seen_whats_new_version: Some("x".repeat(65)),
        ..AppPreferences::default()
    };

    let oversized = save_app_preferences(config.path(), &preferences).unwrap_err();
    assert!(oversized.to_string().contains("What's new version"));

    preferences.last_seen_whats_new_version = Some("0.2.0\nforged".into());
    let malformed = save_app_preferences(config.path(), &preferences).unwrap_err();
    assert!(malformed.to_string().contains("What's new version"));

    assert!(!config.path().join("preferences.json").exists());
}

#[test]
fn invalid_persisted_whats_new_version_recovers_explicitly_without_rewriting() {
    let config = tempfile::tempdir().unwrap();
    let raw = r#"{"automaticUpdateChecks":true,"theme":"forestDark","fontScale":"small","fontFamily":"inter","lastSeenWhatsNewVersion":"not a version"}"#;
    fs::write(config.path().join("preferences.json"), raw).unwrap();

    let loaded = load_app_preferences(config.path()).unwrap();

    assert!(loaded.recovered_from_corrupt);
    assert_eq!(loaded.preferences, AppPreferences::default());
    assert!(loaded
        .recovery_message
        .as_deref()
        .is_some_and(|message| message.contains("What's new version")));
    assert_eq!(
        fs::read_to_string(config.path().join("preferences.json")).unwrap(),
        raw
    );
}

#[test]
fn preferences_io_failures_are_explicit_and_temp_files_are_cleaned_up() {
    let config = tempfile::tempdir().unwrap();
    fs::create_dir(config.path().join("preferences.json")).unwrap();

    let read_error = load_app_preferences(config.path()).unwrap_err();
    let write_error = save_app_preferences(config.path(), &AppPreferences::default()).unwrap_err();

    assert!(read_error
        .to_string()
        .contains("could not read app preferences"));
    assert!(write_error
        .to_string()
        .contains("could not replace app preferences"));
    assert!(fs::read_dir(config.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".nn-tmp")));
}

#[test]
fn preferences_save_fails_when_the_config_directory_is_a_file() {
    let parent = tempfile::tempdir().unwrap();
    let config_file = parent.path().join("not-a-directory");
    fs::write(&config_file, "file").unwrap();

    let error = save_app_preferences(&config_file, &AppPreferences::default()).unwrap_err();

    assert!(error
        .to_string()
        .contains("could not create app preferences directory"));
}

#[test]
fn neuralnote_template_settings_take_precedence_over_obsidian_settings() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir_all(vault.path().join(".neuralnote")).unwrap();
    fs::create_dir_all(vault.path().join(".obsidian")).unwrap();
    fs::create_dir(vault.path().join("Neural Templates")).unwrap();
    fs::create_dir(vault.path().join("Obsidian Templates")).unwrap();
    fs::write(
        vault.path().join(".neuralnote/template-settings.json"),
        r#"{"folder":"Neural Templates","dateFormat":"DD/MM/YYYY","timeFormat":"HH:mm:ss"}"#,
    )
    .unwrap();
    fs::write(
        vault.path().join(".obsidian/templates.json"),
        r#"{"folder":"Obsidian Templates","dateFormat":"YYYY","timeFormat":"hh:mm A"}"#,
    )
    .unwrap();
    fs::write(vault.path().join("Neural Templates/Daily.md"), "# Daily").unwrap();
    fs::write(vault.path().join("Obsidian Templates/Wrong.md"), "# Wrong").unwrap();

    let loaded = load_template_settings(vault.path()).unwrap();
    let templates = list_templates(vault.path()).unwrap();

    assert_eq!(loaded.source, TemplateSettingsSource::NeuralNote);
    assert!(loaded.folder_exists);
    assert_eq!(loaded.settings.folder, "Neural Templates");
    assert_eq!(templates.len(), 1);
    assert_eq!(templates[0].rel_path, "Neural Templates/Daily.md");
}

#[test]
fn neuralnote_formats_drive_existing_template_rendering() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join("Templates")).unwrap();
    fs::write(
        vault.path().join("Templates/Daily.md"),
        "{{date}} {{time}} {{title}}",
    )
    .unwrap();
    save_template_settings(
        vault.path(),
        &TemplateSettings {
            folder: "Templates".into(),
            date_format: "DD/MM/YYYY".into(),
            time_format: "hh:mm A".into(),
        },
    )
    .unwrap();

    neuralnote_core::templates::create_note_from_template(
        vault.path(),
        vault.path(),
        "Rendered",
        Some("Templates/Daily.md"),
        Local.with_ymd_and_hms(2026, 7, 13, 21, 5, 9).unwrap(),
    )
    .unwrap();

    assert_eq!(
        fs::read_to_string(vault.path().join("Rendered.md")).unwrap(),
        "13/07/2026 09:05 PM Rendered"
    );
}

#[test]
fn malformed_neuralnote_template_settings_are_surfaced_instead_of_falling_back() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir_all(vault.path().join(".neuralnote")).unwrap();
    fs::create_dir(vault.path().join("Templates")).unwrap();
    fs::write(vault.path().join("Templates/Fallback.md"), "fallback").unwrap();
    fs::write(
        vault.path().join(".neuralnote/template-settings.json"),
        "{not-json",
    )
    .unwrap();

    let error = load_template_settings(vault.path()).unwrap_err();
    let list_error = list_templates(vault.path()).unwrap_err();

    assert!(error.to_string().contains("template-settings.json"));
    assert!(error.to_string().contains("parse"));
    assert!(list_error.to_string().contains("template-settings.json"));
}

#[test]
fn missing_configured_template_folder_is_a_visible_nonfatal_state() {
    let vault = tempfile::tempdir().unwrap();
    let settings = TemplateSettings {
        folder: "Moved Templates".into(),
        date_format: "YYYY-MM-DD".into(),
        time_format: "HH:mm".into(),
    };

    let saved = save_template_settings(vault.path(), &settings).unwrap();
    let loaded = load_template_settings(vault.path()).unwrap();

    assert!(!saved.folder_exists);
    assert!(!loaded.folder_exists);
    assert_eq!(loaded.settings, settings);
    assert!(list_templates(vault.path()).unwrap().is_empty());
}

#[test]
fn invalid_template_settings_are_rejected_before_persistence() {
    let vault = tempfile::tempdir().unwrap();

    for settings in [
        TemplateSettings {
            folder: "../escape".into(),
            ..TemplateSettings::default()
        },
        TemplateSettings {
            folder: "".into(),
            ..TemplateSettings::default()
        },
        TemplateSettings {
            date_format: "[unclosed".into(),
            ..TemplateSettings::default()
        },
        TemplateSettings {
            time_format: "HH\nmm".into(),
            ..TemplateSettings::default()
        },
    ] {
        assert!(save_template_settings(vault.path(), &settings).is_err());
    }
    assert!(!vault
        .path()
        .join(".neuralnote/template-settings.json")
        .exists());
}

#[test]
fn unreadable_template_settings_and_failed_reset_are_explicit() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir_all(vault.path().join(".neuralnote/template-settings.json")).unwrap();

    let load_error = load_template_settings(vault.path()).unwrap_err();
    let reset_error = reset_template_settings(vault.path()).unwrap_err();

    assert!(load_error
        .to_string()
        .contains("could not read template settings"));
    assert!(reset_error
        .to_string()
        .contains("could not reset template settings"));
}

#[test]
fn reset_without_a_neuralnote_file_is_idempotent() {
    let vault = tempfile::tempdir().unwrap();

    let reset = reset_template_settings(vault.path()).unwrap();

    assert_eq!(reset.source, TemplateSettingsSource::Default);
    assert_eq!(reset.settings, TemplateSettings::default());
}

#[test]
fn template_save_refuses_a_neuralnote_path_that_is_not_a_directory() {
    let vault = tempfile::tempdir().unwrap();
    fs::write(vault.path().join(".neuralnote"), "file").unwrap();

    let error = save_template_settings(vault.path(), &TemplateSettings::default()).unwrap_err();

    assert!(error
        .to_string()
        .contains("template settings directory is not a directory"));
}

#[test]
fn valid_obsidian_format_settings_are_retained_with_discovered_folder() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join(".obsidian")).unwrap();
    fs::create_dir(vault.path().join("Templates")).unwrap();
    fs::write(
        vault.path().join(".obsidian/templates.json"),
        r#"{"dateFormat":"DD/MM/YYYY","timeFormat":"hh:mm A"}"#,
    )
    .unwrap();

    let loaded = load_template_settings(vault.path()).unwrap();

    assert_eq!(loaded.source, TemplateSettingsSource::Obsidian);
    assert_eq!(loaded.settings.folder, "Templates");
    assert_eq!(loaded.settings.date_format, "DD/MM/YYYY");
    assert_eq!(loaded.settings.time_format, "hh:mm A");
}

#[cfg(unix)]
#[test]
fn template_folder_symlinks_cannot_escape_the_vault() {
    use std::os::unix::fs::symlink;

    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), vault.path().join("escaped")).unwrap();
    let settings = TemplateSettings {
        folder: "escaped".into(),
        ..TemplateSettings::default()
    };

    let error = save_template_settings(vault.path(), &settings).unwrap_err();

    assert!(error.to_string().contains("outside vault"));
}

#[cfg(unix)]
#[test]
fn neuralnote_settings_directory_symlink_cannot_redirect_config_io_outside_the_vault() {
    use std::os::unix::fs::symlink;

    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), vault.path().join(".neuralnote")).unwrap();

    let error = save_template_settings(vault.path(), &TemplateSettings::default()).unwrap_err();

    assert!(error.to_string().contains("outside vault"));
    assert!(!outside.path().join("template-settings.json").exists());
}

#[cfg(unix)]
#[test]
fn resetting_a_symlinked_settings_file_never_deletes_its_in_vault_target() {
    use std::os::unix::fs::symlink;

    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join(".neuralnote")).unwrap();
    fs::write(vault.path().join("Important.md"), "keep me").unwrap();
    symlink(
        vault.path().join("Important.md"),
        vault.path().join(".neuralnote/template-settings.json"),
    )
    .unwrap();

    reset_template_settings(vault.path()).unwrap();

    assert_eq!(
        fs::read_to_string(vault.path().join("Important.md")).unwrap(),
        "keep me"
    );
    assert!(fs::symlink_metadata(vault.path().join(".neuralnote/template-settings.json")).is_err());
}

#[cfg(unix)]
#[test]
fn obsidian_config_symlink_outside_the_vault_is_not_read() {
    use std::os::unix::fs::symlink;

    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join(".obsidian")).unwrap();
    fs::create_dir(vault.path().join("Templates")).unwrap();
    fs::write(vault.path().join("Templates/Safe.md"), "safe").unwrap();
    fs::write(
        outside.path().join("templates.json"),
        r#"{"folder":"Secret Templates"}"#,
    )
    .unwrap();
    symlink(
        outside.path().join("templates.json"),
        vault.path().join(".obsidian/templates.json"),
    )
    .unwrap();

    let loaded = load_template_settings(vault.path()).unwrap();
    let templates = list_templates(vault.path()).unwrap();

    assert_eq!(loaded.source, TemplateSettingsSource::Discovery);
    assert_eq!(loaded.settings.folder, "Templates");
    assert_eq!(templates[0].rel_path, "Templates/Safe.md");
}

#[test]
fn template_formats_reject_unsafe_or_unclosed_values_and_preview_supported_tokens() {
    let now = Local.with_ymd_and_hms(2026, 7, 13, 21, 5, 9).unwrap();

    assert_eq!(
        preview_template_format("[Week] dddd, DD MMMM YYYY HH:mm:ss", now).unwrap(),
        "Week Monday, 13 July 2026 21:05:09"
    );
    assert!(preview_template_format("YYYY\nMM", now).is_err());
    assert!(preview_template_format("[unclosed YYYY", now).is_err());
    assert!(preview_template_format(&"Y".repeat(129), now).is_err());
}

#[test]
fn reset_removes_neuralnote_settings_and_restores_existing_precedence() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir_all(vault.path().join(".obsidian")).unwrap();
    fs::create_dir(vault.path().join("Obsidian Templates")).unwrap();
    fs::write(
        vault.path().join(".obsidian/templates.json"),
        r#"{"folder":"Obsidian Templates"}"#,
    )
    .unwrap();
    save_template_settings(
        vault.path(),
        &TemplateSettings {
            folder: "Neural Templates".into(),
            ..TemplateSettings::default()
        },
    )
    .unwrap();

    let reset = reset_template_settings(vault.path()).unwrap();

    assert_eq!(reset.source, TemplateSettingsSource::Obsidian);
    assert_eq!(reset.settings.folder, "Obsidian Templates");
    assert!(!vault
        .path()
        .join(".neuralnote/template-settings.json")
        .exists());
}
