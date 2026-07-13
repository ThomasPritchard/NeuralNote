use super::detect_requirement_files;

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

#[cfg(unix)]
#[test]
fn pending_whisper_files_are_detected_when_manually_installed() {
    let app_data = tempfile::tempdir().unwrap();
    let bin = app_data.path().join("bin");
    let assets = app_data.path().join("assets");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&assets).unwrap();
    write_file(&bin.join("whisper-cli"), true);
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

#[test]
fn missing_requirement_directories_are_a_normal_empty_inventory() {
    let app_data = tempfile::tempdir().unwrap();

    assert!(detect_requirement_files(app_data.path()).is_empty());
}
