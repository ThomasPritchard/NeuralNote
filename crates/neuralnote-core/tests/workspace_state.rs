use std::fs;

use neuralnote_core::workspace_state::{
    load_workspace_state, reset_workspace_state, save_workspace_state, WorkspaceState,
};

fn state(open_paths: &[&str], active_path: Option<&str>) -> WorkspaceState {
    WorkspaceState {
        open_paths: open_paths.iter().map(|path| (*path).to_owned()).collect(),
        active_path: active_path.map(str::to_owned),
    }
}

#[test]
fn missing_workspace_state_loads_an_empty_non_recovery_state() {
    let vault = tempfile::tempdir().unwrap();

    let loaded = load_workspace_state(vault.path()).unwrap();

    assert_eq!(loaded.state, WorkspaceState::default());
    assert!(!loaded.recovered_from_corrupt);
    assert!(loaded.recovery_message.is_none());
}

#[test]
fn workspace_state_round_trips_atomically_without_temp_files() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join("Projects")).unwrap();
    fs::write(vault.path().join("Ideas.md"), "ideas").unwrap();
    fs::write(vault.path().join("Projects/APD action plan.md"), "plan").unwrap();
    let expected = state(
        &["Ideas.md", "Projects/APD action plan.md"],
        Some("Projects/APD action plan.md"),
    );

    save_workspace_state(vault.path(), &expected).unwrap();

    let loaded = load_workspace_state(vault.path()).unwrap();
    assert_eq!(loaded.state, expected);
    assert!(!loaded.recovered_from_corrupt);
    assert!(fs::read_dir(vault.path().join(".neuralnote"))
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".nn-tmp")));
}

#[test]
fn missing_recorded_notes_are_retained_for_the_frontend_to_report_and_skip() {
    let vault = tempfile::tempdir().unwrap();
    let expected = state(
        &["Moved/No longer here.md"],
        Some("Moved/No longer here.md"),
    );

    save_workspace_state(vault.path(), &expected).unwrap();

    assert_eq!(load_workspace_state(vault.path()).unwrap().state, expected);
}

#[test]
fn malformed_state_recovers_without_overwriting_and_blocks_save_until_reset() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join(".neuralnote")).unwrap();
    let path = vault.path().join(".neuralnote/workspace-state.json");
    fs::write(&path, "{not-json").unwrap();

    let loaded = load_workspace_state(vault.path()).unwrap();

    assert_eq!(loaded.state, WorkspaceState::default());
    assert!(loaded.recovered_from_corrupt);
    assert!(loaded
        .recovery_message
        .as_deref()
        .is_some_and(
            |message| message.contains("workspace-state.json") && message.contains("parse")
        ));
    assert_eq!(fs::read_to_string(&path).unwrap(), "{not-json");
    assert!(
        save_workspace_state(vault.path(), &WorkspaceState::default())
            .unwrap_err()
            .to_string()
            .contains("reset")
    );

    let reset = reset_workspace_state(vault.path()).unwrap();
    assert_eq!(reset.state, WorkspaceState::default());
    assert!(!reset.recovered_from_corrupt);
    save_workspace_state(vault.path(), &state(&["Fresh.md"], Some("Fresh.md"))).unwrap();
}

#[test]
fn unsafe_duplicate_and_inconsistent_states_enter_recovery_mode() {
    let cases = [
        r#"{"openPaths":["../escape.md"],"activePath":"../escape.md"}"#,
        r#"{"openPaths":["/etc/passwd"],"activePath":"/etc/passwd"}"#,
        r#"{"openPaths":["Safe.md","Safe.md"],"activePath":"Safe.md"}"#,
        r#"{"openPaths":["Safe.md"],"activePath":"Other.md"}"#,
        r#"{"openPaths":["Safe\nNote.md"],"activePath":"Safe\nNote.md"}"#,
        r#"{"openPaths":["Safe.md"],"activePath":null,"unexpected":true}"#,
        r#"{"openPaths":["./Safe.md"],"activePath":"./Safe.md"}"#,
        r#"{"openPaths":["Folder//Safe.md"],"activePath":"Folder//Safe.md"}"#,
        r#"{"openPaths":["C:\\secret.md"],"activePath":"C:\\secret.md"}"#,
    ];

    for raw in cases {
        let vault = tempfile::tempdir().unwrap();
        fs::create_dir(vault.path().join(".neuralnote")).unwrap();
        fs::write(vault.path().join(".neuralnote/workspace-state.json"), raw).unwrap();

        let loaded = load_workspace_state(vault.path()).unwrap();

        assert!(loaded.recovered_from_corrupt, "expected recovery for {raw}");
        assert_eq!(loaded.state, WorkspaceState::default());
    }
}

#[test]
fn oversized_and_non_utf8_states_enter_recovery_mode_without_being_rewritten() {
    for bytes in [vec![b' '; 65 * 1024], vec![0xff, 0xfe, 0xfd]] {
        let vault = tempfile::tempdir().unwrap();
        fs::create_dir(vault.path().join(".neuralnote")).unwrap();
        let path = vault.path().join(".neuralnote/workspace-state.json");
        fs::write(&path, &bytes).unwrap();

        let loaded = load_workspace_state(vault.path()).unwrap();

        assert!(loaded.recovered_from_corrupt);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[cfg(unix)]
#[test]
fn special_file_state_enters_recovery_without_being_read() {
    use std::os::unix::fs::symlink;

    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join(".neuralnote")).unwrap();
    fs::create_dir(vault.path().join("state-target")).unwrap();
    let path = vault.path().join(".neuralnote/workspace-state.json");
    symlink(vault.path().join("state-target"), &path).unwrap();

    let loaded = load_workspace_state(vault.path()).unwrap();

    assert!(loaded.recovered_from_corrupt);
    assert_eq!(loaded.state, WorkspaceState::default());
    assert!(loaded
        .recovery_message
        .as_deref()
        .is_some_and(|message| message.contains("not a regular file")));
}

#[test]
fn invalid_state_is_rejected_before_the_first_persistence_write() {
    let vault = tempfile::tempdir().unwrap();

    for invalid in [
        state(&["../escape.md"], Some("../escape.md")),
        state(&["Duplicate.md", "Duplicate.md"], Some("Duplicate.md")),
        state(&["Safe.md"], Some("Not open.md")),
        state(&["Bad\0Name.md"], Some("Bad\0Name.md")),
    ] {
        assert!(save_workspace_state(vault.path(), &invalid).is_err());
    }
    assert!(!vault.path().join(".neuralnote").exists());
}

#[cfg(unix)]
#[test]
fn recorded_note_symlinks_cannot_escape_the_vault() {
    use std::os::unix::fs::symlink;

    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    symlink(outside.path(), vault.path().join("Escaped.md")).unwrap();

    let error = save_workspace_state(vault.path(), &state(&["Escaped.md"], Some("Escaped.md")))
        .unwrap_err();

    assert!(error.to_string().contains("outside vault"));
    assert!(!vault.path().join(".neuralnote").exists());
}

#[cfg(unix)]
#[test]
fn symlinked_neuralnote_directory_cannot_redirect_state_io_outside_the_vault() {
    use std::os::unix::fs::symlink;

    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), vault.path().join(".neuralnote")).unwrap();

    let save_error = save_workspace_state(vault.path(), &WorkspaceState::default()).unwrap_err();
    let reset_error = reset_workspace_state(vault.path()).unwrap_err();

    assert!(save_error.to_string().contains("outside vault"));
    assert!(reset_error.to_string().contains("outside vault"));
    assert!(!outside.path().join("workspace-state.json").exists());
}

#[cfg(unix)]
#[test]
fn an_outside_state_symlink_is_never_read_or_written_through() {
    use std::os::unix::fs::symlink;

    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), "outside stays intact").unwrap();
    fs::create_dir(vault.path().join(".neuralnote")).unwrap();
    symlink(
        outside.path(),
        vault.path().join(".neuralnote/workspace-state.json"),
    )
    .unwrap();

    let loaded = load_workspace_state(vault.path()).unwrap();
    assert!(loaded.recovered_from_corrupt);
    reset_workspace_state(vault.path()).unwrap();

    assert_eq!(
        fs::read_to_string(outside.path()).unwrap(),
        "outside stays intact"
    );
    assert_eq!(
        load_workspace_state(vault.path()).unwrap().state,
        WorkspaceState::default()
    );
}

#[test]
fn workspace_state_io_failures_are_explicit() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir_all(vault.path().join(".neuralnote/workspace-state.json")).unwrap();

    let load_error = load_workspace_state(vault.path()).unwrap_err();
    let reset_error = reset_workspace_state(vault.path()).unwrap_err();

    assert!(load_error
        .to_string()
        .contains("could not read workspace state"));
    assert!(reset_error
        .to_string()
        .contains("could not replace workspace state"));
}
