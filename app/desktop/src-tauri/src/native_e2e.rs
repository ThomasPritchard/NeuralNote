use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use neuralnote_core::CoreError;

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
#[cfg(target_os = "macos")]
use objc2_foundation::{MainThreadMarker, NSPoint, NSString};

const ROOT_PREFIX: &str = "neuralnote-native-e2e-";
const MARKER_FILE: &str = ".neuralnote-native-e2e-root-v1.json";
const NATIVE_READ_AUDIT_FILE: &str = "native-read-audit.jsonl";
const MAX_MARKER_BYTES: u64 = 1_024;

/// Dispatch one fixed Command-S key-down event through this E2E application's
/// AppKit key window. AppKit must resolve it through the installed Tauri menu
/// key equivalent; this command never emits a menu action or calls save.
#[cfg(target_os = "macos")]
#[tauri::command]
pub(super) async fn native_e2e_post_save_accelerator(app: tauri::AppHandle) -> Result<(), String> {
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = result_tx.send(post_fixed_save_accelerator());
    })
    .map_err(|error| format!("could not schedule native E2E save accelerator: {error}"))?;
    result_rx
        .await
        .map_err(|_| "native E2E save accelerator result channel closed".to_string())?
}

#[cfg(target_os = "macos")]
fn post_fixed_save_accelerator() -> Result<(), String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "native E2E save accelerator must run on the main thread".to_string())?;
    let app = NSApplication::sharedApplication(mtm);
    let window_number = app
        .keyWindow()
        .or_else(|| app.mainWindow())
        .ok_or_else(|| "native E2E save accelerator requires an AppKit window".to_string())?
        .windowNumber();
    let characters = NSString::from_str("s");
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown,
        NSPoint::new(0.0, 0.0),
        NSEventModifierFlags::Command,
        0.0,
        window_number,
        None,
        &characters,
        &characters,
        false,
        1,
    )
    .ok_or_else(|| "AppKit could not create the fixed Command-S event".to_string())?;
    app.sendEvent(&event);
    Ok(())
}

pub(super) fn native_e2e_config_dir() -> Result<Option<PathBuf>, CoreError> {
    native_e2e_config_dir_from(
        std::env::var_os("NEURALNOTE_E2E_ROOT"),
        &std::env::temp_dir(),
    )
}

fn native_e2e_config_dir_from(
    configured_root: Option<OsString>,
    temp_root: &Path,
) -> Result<Option<PathBuf>, CoreError> {
    let Some(configured_root) = configured_root else {
        return Ok(None);
    };
    let root = PathBuf::from(configured_root);
    if !root.is_absolute() {
        return Err(invalid_root("the override is not absolute"));
    }
    let root_metadata = fs::symlink_metadata(&root)
        .map_err(|error| invalid_root(&format!("the root cannot be inspected: {error}")))?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(invalid_root("the root is not a real directory"));
    }
    if !root
        .file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with(ROOT_PREFIX))
    {
        return Err(invalid_root(
            "the root name is not owned by the native harness",
        ));
    }

    let canonical_temp = temp_root
        .canonicalize()
        .map_err(|error| invalid_root(&format!("the temp root cannot be resolved: {error}")))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| invalid_root(&format!("the root cannot be resolved: {error}")))?;
    if canonical_root.parent() != Some(canonical_temp.as_path()) {
        return Err(invalid_root(
            "the root is not a direct child of the process temp directory",
        ));
    }

    validate_marker(&canonical_root.join(MARKER_FILE))?;
    let config = canonical_root.join("config");
    let config_metadata = fs::symlink_metadata(&config).map_err(|error| {
        invalid_root(&format!(
            "the config directory cannot be inspected: {error}"
        ))
    })?;
    if !config_metadata.is_dir() || config_metadata.file_type().is_symlink() {
        return Err(invalid_root("the config path is not a real directory"));
    }
    let canonical_config = config.canonicalize().map_err(|error| {
        invalid_root(&format!("the config directory cannot be resolved: {error}"))
    })?;
    if canonical_config.parent() != Some(canonical_root.as_path()) {
        return Err(invalid_root("the config directory escaped the marked root"));
    }

    Ok(Some(canonical_config))
}

fn validate_marker(marker: &Path) -> Result<(), CoreError> {
    let metadata = fs::symlink_metadata(marker).map_err(|error| {
        invalid_root(&format!(
            "the ownership marker cannot be inspected: {error}"
        ))
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid_root("the ownership marker is not a real file"));
    }
    if metadata.len() > MAX_MARKER_BYTES {
        return Err(invalid_root("the ownership marker is oversized"));
    }
    let marker: serde_json::Value =
        serde_json::from_slice(&fs::read(marker).map_err(|error| {
            invalid_root(&format!("the ownership marker cannot be read: {error}"))
        })?)
        .map_err(|error| invalid_root(&format!("the ownership marker is invalid: {error}")))?;
    let valid_schema = marker
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        == Some(1);
    let valid_session = marker
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|session| !session.is_empty() && session.len() <= 128);
    if !valid_schema || !valid_session {
        return Err(invalid_root(
            "the ownership marker does not match the v1 contract",
        ));
    }
    Ok(())
}

fn invalid_root(reason: &str) -> CoreError {
    CoreError::Io(format!("invalid NEURALNOTE_E2E_ROOT: {reason}"))
}

/// Append only the requested file name to the marked-root audit. This exists
/// solely to prove that inert editor decorations never cross the native
/// `read_note` boundary. It is feature-gated with the automation plugins and
/// cannot be compiled into a release bundle.
pub(super) fn record_note_read(path: &Path) -> Result<(), CoreError> {
    let root = std::env::var_os("NEURALNOTE_E2E_ROOT")
        .ok_or_else(|| invalid_root("the override is absent while recording a native read"))?;
    record_note_read_from(root, &std::env::temp_dir(), path)
}

fn record_note_read_from(
    configured_root: OsString,
    temp_root: &Path,
    path: &Path,
) -> Result<(), CoreError> {
    let root = PathBuf::from(configured_root.clone());
    // Reuse the full ownership validation before writing any diagnostic file.
    native_e2e_config_dir_from(Some(configured_root), temp_root)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid_root("a native read path has no UTF-8 file name"))?;
    let mut audit = open_native_read_audit(&root)?;
    serde_json::to_writer(&mut audit, file_name).map_err(|error| {
        CoreError::Io(format!(
            "could not serialize native E2E read audit: {error}"
        ))
    })?;
    audit
        .write_all(b"\n")
        .map_err(|error| CoreError::Io(format!("could not finish native E2E read audit: {error}")))
}

fn validate_artifacts_directory(root: &Path) -> Result<PathBuf, CoreError> {
    let artifacts = root.join("artifacts");
    let metadata = fs::symlink_metadata(&artifacts).map_err(|error| {
        invalid_root(&format!(
            "the artifacts directory cannot be inspected: {error}"
        ))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid_root("the artifacts path is not a real directory"));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| invalid_root(&format!("the root cannot be resolved: {error}")))?;
    let canonical_artifacts = artifacts.canonicalize().map_err(|error| {
        invalid_root(&format!(
            "the artifacts directory cannot be resolved: {error}"
        ))
    })?;
    if canonical_artifacts.parent() != Some(canonical_root.as_path()) {
        return Err(invalid_root(
            "the artifacts directory escaped the marked root",
        ));
    }
    Ok(artifacts)
}

#[cfg(unix)]
fn open_native_read_audit(root: &Path) -> Result<File, CoreError> {
    use rustix::fs::{fstat, open, openat, FileType, Mode, OFlags};

    validate_artifacts_directory(root)?;
    let directory_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW;
    let root_fd = open(root, directory_flags, Mode::empty()).map_err(|error| {
        invalid_root(&format!(
            "the root directory cannot be opened safely: {error}"
        ))
    })?;
    let artifacts_fd =
        openat(&root_fd, "artifacts", directory_flags, Mode::empty()).map_err(|error| {
            invalid_root(&format!(
                "the artifacts directory cannot be opened safely: {error}"
            ))
        })?;
    let audit_fd = openat(
        &artifacts_fd,
        NATIVE_READ_AUDIT_FILE,
        OFlags::WRONLY | OFlags::APPEND | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(|error| {
        CoreError::Io(format!(
            "could not safely open native E2E read audit: {error}"
        ))
    })?;
    let stat = fstat(&audit_fd).map_err(|error| {
        CoreError::Io(format!("could not inspect native E2E read audit: {error}"))
    })?;
    if !FileType::from_raw_mode(stat.st_mode).is_file() {
        return Err(CoreError::Io(
            "native E2E read audit is not a regular file".into(),
        ));
    }
    Ok(File::from(audit_fd))
}

#[cfg(windows)]
fn open_native_read_audit(root: &Path) -> Result<File, CoreError> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;

    let root_guard = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(root)
        .map_err(|error| {
            invalid_root(&format!(
                "the root directory cannot be opened safely: {error}"
            ))
        })?;
    let root_metadata = root_guard.metadata().map_err(|error| {
        invalid_root(&format!(
            "the root directory handle cannot be inspected: {error}"
        ))
    })?;
    if !root_metadata.is_dir()
        || root_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(invalid_root("the root path is not a real directory"));
    }

    let artifacts = validate_artifacts_directory(root)?;
    let artifacts_guard = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&artifacts)
        .map_err(|error| {
            invalid_root(&format!(
                "the artifacts directory cannot be opened safely: {error}"
            ))
        })?;
    let artifacts_metadata = artifacts_guard.metadata().map_err(|error| {
        invalid_root(&format!(
            "the artifacts directory handle cannot be inspected: {error}"
        ))
    })?;
    if !artifacts_metadata.is_dir()
        || artifacts_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(invalid_root("the artifacts path is not a real directory"));
    }

    let audit = OpenOptions::new()
        .append(true)
        .create(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(artifacts.join(NATIVE_READ_AUDIT_FILE))
        .map_err(|error| {
            CoreError::Io(format!(
                "could not safely open native E2E read audit: {error}"
            ))
        })?;
    let audit_metadata = audit.metadata().map_err(|error| {
        CoreError::Io(format!("could not inspect native E2E read audit: {error}"))
    })?;
    if !audit_metadata.is_file()
        || audit_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(CoreError::Io(
            "native E2E read audit is not a regular file".into(),
        ));
    }
    Ok(audit)
}

#[cfg(not(any(unix, windows)))]
fn open_native_read_audit(_root: &Path) -> Result<File, CoreError> {
    Err(CoreError::Io(
        "native E2E read audit is unsupported on this platform".into(),
    ))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::path::Path;

    use super::{native_e2e_config_dir_from, record_note_read_from};

    #[test]
    fn absent_override_keeps_the_platform_config_directory() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(native_e2e_config_dir_from(None, temp.path()).unwrap(), None);
    }

    #[test]
    fn marked_direct_child_of_the_temp_root_is_accepted() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("neuralnote-native-e2e-test");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join(".neuralnote-native-e2e-root-v1.json"),
            r#"{"schemaVersion":1,"sessionId":"test-session"}"#,
        )
        .unwrap();
        fs::create_dir(root.join("config")).unwrap();

        assert_eq!(
            native_e2e_config_dir_from(Some(root.clone().into_os_string()), temp.path()).unwrap(),
            Some(root.join("config").canonicalize().unwrap())
        );
    }

    #[test]
    fn native_read_audit_records_only_the_file_name_inside_the_marked_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("neuralnote-native-e2e-read-audit");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join(".neuralnote-native-e2e-root-v1.json"),
            r#"{"schemaVersion":1,"sessionId":"test-session"}"#,
        )
        .unwrap();
        fs::create_dir(root.join("config")).unwrap();
        fs::create_dir(root.join("artifacts")).unwrap();

        record_note_read_from(
            root.clone().into_os_string(),
            temp.path(),
            Path::new("/private/vault/Secret note.md"),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(root.join("artifacts/native-read-audit.jsonl")).unwrap(),
            "\"Secret note.md\"\n"
        );
    }

    #[test]
    fn native_read_audit_rejects_a_non_directory_artifacts_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("neuralnote-native-e2e-artifacts-file");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join(".neuralnote-native-e2e-root-v1.json"),
            r#"{"schemaVersion":1,"sessionId":"test-session"}"#,
        )
        .unwrap();
        fs::create_dir(root.join("config")).unwrap();
        fs::write(root.join("artifacts"), b"sentinel\n").unwrap();

        assert!(record_note_read_from(
            root.clone().into_os_string(),
            temp.path(),
            Path::new("/private/vault/Secret note.md"),
        )
        .is_err());
        assert_eq!(fs::read(root.join("artifacts")).unwrap(), b"sentinel\n");
    }

    #[cfg(unix)]
    #[test]
    fn native_read_audit_rejects_a_symlinked_artifacts_directory_before_writing() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("neuralnote-native-e2e-artifacts-link");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join(".neuralnote-native-e2e-root-v1.json"),
            r#"{"schemaVersion":1,"sessionId":"test-session"}"#,
        )
        .unwrap();
        fs::create_dir(root.join("config")).unwrap();
        let outside = temp.path().join("outside-artifacts");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("artifacts")).unwrap();

        assert!(record_note_read_from(
            root.into_os_string(),
            temp.path(),
            Path::new("/private/vault/Secret note.md"),
        )
        .is_err());
        assert!(!outside.join("native-read-audit.jsonl").exists());
    }

    #[cfg(unix)]
    #[test]
    fn native_read_audit_rejects_a_symlinked_audit_file_before_appending() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("neuralnote-native-e2e-audit-link");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join(".neuralnote-native-e2e-root-v1.json"),
            r#"{"schemaVersion":1,"sessionId":"test-session"}"#,
        )
        .unwrap();
        fs::create_dir(root.join("config")).unwrap();
        fs::create_dir(root.join("artifacts")).unwrap();
        let outside = temp.path().join("outside-audit.jsonl");
        fs::write(&outside, b"sentinel\n").unwrap();
        symlink(&outside, root.join("artifacts/native-read-audit.jsonl")).unwrap();

        assert!(record_note_read_from(
            root.into_os_string(),
            temp.path(),
            Path::new("/private/vault/Secret note.md"),
        )
        .is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"sentinel\n");
    }

    #[test]
    fn unmarked_or_outside_roots_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let unmarked = temp.path().join("neuralnote-native-e2e-unmarked");
        fs::create_dir(&unmarked).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_root = outside.path().join("neuralnote-native-e2e-outside");
        fs::create_dir(&outside_root).unwrap();
        fs::write(
            outside_root.join(".neuralnote-native-e2e-root-v1.json"),
            r#"{"schemaVersion":1,"sessionId":"test-session"}"#,
        )
        .unwrap();

        assert!(native_e2e_config_dir_from(
            Some(OsString::from(unmarked.as_os_str())),
            temp.path()
        )
        .is_err());
        assert!(native_e2e_config_dir_from(
            Some(OsString::from(outside_root.as_os_str())),
            temp.path()
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_markers_fail_closed() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("neuralnote-native-e2e-symlink-marker");
        fs::create_dir(&root).unwrap();
        let marker_target = temp.path().join("marker-target");
        fs::write(
            &marker_target,
            r#"{"schemaVersion":1,"sessionId":"test-session"}"#,
        )
        .unwrap();
        symlink(
            marker_target,
            root.join(".neuralnote-native-e2e-root-v1.json"),
        )
        .unwrap();

        assert!(native_e2e_config_dir_from(Some(root.into_os_string()), temp.path()).is_err());
    }
}
