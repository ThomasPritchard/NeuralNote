use super::detect_requirement_files;
use crate::macho_fixtures::{executable, SYSTEM_DYLIBS};

#[cfg(unix)]
fn write_file(path: &std::path::Path, executable: bool) {
    use std::os::unix::fs::PermissionsExt;

    std::fs::write(path, b"fixture").unwrap();
    let mode = if executable { 0o755 } else { 0o644 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[cfg(unix)]
#[test]
fn detects_only_registered_regular_executables_and_regular_assets() {
    let app_data = tempfile::tempdir().unwrap();
    let bin = app_data.path().join("bin");
    let assets = app_data.path().join("assets");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&assets).unwrap();
    write_file(&bin.join("yt-dlp"), true);
    write_file(&bin.join("bgutil-pot"), false);
    write_file(&bin.join("unknown-executable"), true);
    write_file(&assets.join("bgutil-plugin.zip"), false);
    write_file(&assets.join("ggml-small.en.bin"), false);
    write_file(&assets.join("unknown-asset"), false);

    let available = detect_requirement_files(app_data.path());

    assert_eq!(
        available,
        [
            bin.join("yt-dlp"),
            assets.join("bgutil-plugin.zip"),
            assets.join("ggml-small.en.bin"),
        ]
        .into_iter()
        .collect()
    );
}

/// `whisper-cli` is the one requirement compiled here rather than downloaded, so
/// it is the one whose libraries are checked. A placeholder byte string is now
/// rejected, correctly, because it could never run — so the hand-installed shape
/// this test speaks for is a real executable, the same one the fixed build
/// produces.
#[cfg(unix)]
#[test]
fn pending_whisper_files_are_detected_when_manually_installed() {
    use std::os::unix::fs::PermissionsExt;

    let app_data = tempfile::tempdir().unwrap();
    let bin = app_data.path().join("bin");
    let assets = app_data.path().join("assets");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(bin.join("whisper-cli"), executable(SYSTEM_DYLIBS, &[], &[])).unwrap();
    std::fs::set_permissions(
        bin.join("whisper-cli"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    write_file(&assets.join("ggml-small.en.bin"), false);

    let available = detect_requirement_files(app_data.path());

    assert!(available.contains(&bin.join("whisper-cli")));
    assert!(available.contains(&assets.join("ggml-small.en.bin")));
}

#[cfg(unix)]
#[test]
fn directories_symlinks_and_non_executable_binaries_are_rejected() {
    use std::os::unix::fs::symlink;

    let app_data = tempfile::tempdir().unwrap();
    let bin = app_data.path().join("bin");
    let assets = app_data.path().join("assets");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::create_dir(bin.join("yt-dlp")).unwrap();
    write_file(&bin.join("real-bgutil"), true);
    symlink(bin.join("real-bgutil"), bin.join("bgutil-pot")).unwrap();
    write_file(&bin.join("whisper-cli"), false);
    write_file(&assets.join("real-plugin.zip"), false);
    symlink(
        assets.join("real-plugin.zip"),
        assets.join("bgutil-plugin.zip"),
    )
    .unwrap();

    assert!(detect_requirement_files(app_data.path()).is_empty());
}

/// The failure this inventory used to hide. A `whisper-cli` published by the
/// shipped installer is a regular file with the execute bit set and cannot start:
/// the libraries it loads went with the staging tree. Reporting it as available
/// activates the transcription skill and moves the failure to dispatch, where it
/// reads as "transcription is broken" rather than "the install is broken".
///
/// macOS only: dyld linkage is what makes this binary unrunnable, and only macOS
/// asks the question. Elsewhere `unlaunchable_reason` is a deliberate no-op, so
/// the same file is correctly reported as installed.
#[cfg(target_os = "macos")]
#[test]
fn a_whisper_binary_that_lost_its_libraries_is_not_reported_as_installed() {
    use crate::macho_fixtures::WHISPER_DYLIBS;
    use std::os::unix::fs::PermissionsExt;

    let app_data = tempfile::tempdir().unwrap();
    let bin = app_data.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let deleted_staging = app_data.path().join("build/whisper.cpp-1.9.1/build/bin");
    let whisper = bin.join("whisper-cli");
    std::fs::write(
        &whisper,
        executable(WHISPER_DYLIBS, &[], &[&deleted_staging.to_string_lossy()]),
    )
    .unwrap();
    std::fs::set_permissions(&whisper, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(!detect_requirement_files(app_data.path()).contains(&whisper));
}

/// The same inventory must still report the binary the fixed installer publishes,
/// which needs nothing but the libraries macOS itself ships.
#[cfg(unix)]
#[test]
fn a_self_contained_whisper_binary_is_reported_as_installed() {
    use std::os::unix::fs::PermissionsExt;

    let app_data = tempfile::tempdir().unwrap();
    let bin = app_data.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let whisper = bin.join("whisper-cli");
    std::fs::write(&whisper, executable(SYSTEM_DYLIBS, &[], &[])).unwrap();
    std::fs::set_permissions(&whisper, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(detect_requirement_files(app_data.path()).contains(&whisper));
}

#[test]
fn missing_requirement_directories_are_a_normal_empty_inventory() {
    let app_data = tempfile::tempdir().unwrap();

    assert!(detect_requirement_files(app_data.path()).is_empty());
}
