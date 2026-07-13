use super::*;
use neuralnote_core::capture::{CaptureError, MAX_VTT_BYTES};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

const VALID_VTT: &[u8] = b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA small transcription.\n";

#[cfg(unix)]
fn write_requirement_files(app_data: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let bin = app_data.join("bin");
    let assets = app_data.join("assets");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&assets).unwrap();
    let binary = bin.join("whisper-cli");
    std::fs::write(&binary, b"binary").unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(assets.join("ggml-small.en.bin"), b"model").unwrap();
}

fn string_args(spec: &ProcessSpec) -> Vec<String> {
    spec.args
        .iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect()
}

#[cfg(unix)]
#[test]
fn command_uses_only_the_pinned_app_data_requirements_and_exact_flags() {
    let app_data = tempfile::tempdir().unwrap();
    write_requirement_files(app_data.path());
    let cli = WhisperCli::from_app_data(app_data.path()).unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let wav = workspace.path().join("decoded.wav");
    let output_prefix = workspace.path().join("transcript");

    let spec = cli.transcribe(&wav, &output_prefix);

    assert_eq!(spec.program, app_data.path().join("bin/whisper-cli"));
    assert!(spec.program.is_absolute());
    assert_eq!(
        string_args(&spec),
        [
            "-m".to_string(),
            app_data
                .path()
                .join("assets/ggml-small.en.bin")
                .display()
                .to_string(),
            "-f".to_string(),
            wav.display().to_string(),
            "-ovtt".to_string(),
            "-of".to_string(),
            output_prefix.display().to_string(),
            "-np".to_string(),
        ]
    );
    assert_eq!(spec.cwd.as_deref(), Some(workspace.path()));
    let EnvironmentPolicy::ClearAndSet(environment) = &spec.environment;
    assert_eq!(
        environment.get(&OsString::from("PATH")),
        Some(&OsString::from("/usr/bin:/bin"))
    );
    assert_eq!(environment.len(), 1);
    assert_eq!(spec.timeout, Duration::from_secs(30 * 60));
    assert!(spec.stdout_limit <= 1024 * 1024);
    assert!(spec.stderr_limit <= 1024 * 1024);
}

#[cfg(unix)]
#[test]
fn unsafe_or_missing_requirement_files_are_rejected_before_a_command_is_built() {
    use std::os::unix::fs::{symlink, PermissionsExt};

    let app_data = tempfile::tempdir().unwrap();
    write_requirement_files(app_data.path());
    let binary = app_data.path().join("bin/whisper-cli");
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        WhisperCli::from_app_data(app_data.path()),
        Err(CaptureError::RequirementMissing(_))
    ));

    std::fs::remove_file(&binary).unwrap();
    let external_binary = app_data.path().join("outside-whisper");
    std::fs::write(&external_binary, b"binary").unwrap();
    std::fs::set_permissions(&external_binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    symlink(&external_binary, &binary).unwrap();
    assert!(matches!(
        WhisperCli::from_app_data(app_data.path()),
        Err(CaptureError::RequirementMissing(_))
    ));

    std::fs::remove_file(&binary).unwrap();
    std::fs::write(&binary, b"binary").unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    let model = app_data.path().join("assets/ggml-small.en.bin");
    std::fs::remove_file(&model).unwrap();
    let external_model = app_data.path().join("outside-model");
    std::fs::write(&external_model, b"model").unwrap();
    symlink(&external_model, &model).unwrap();
    assert!(matches!(
        WhisperCli::from_app_data(app_data.path()),
        Err(CaptureError::RequirementMissing(_))
    ));
}

#[test]
fn relative_app_data_cannot_produce_a_relative_process_path() {
    assert!(matches!(
        WhisperCli::from_app_data(Path::new("relative-app-data")),
        Err(CaptureError::RequirementMissing(_))
    ));
}

#[tokio::test]
async fn the_expected_single_vtt_is_bounded_validated_and_returned() {
    let workspace = tempfile::tempdir().unwrap();
    let prefix = workspace.path().join("whisper.result");
    std::fs::write(workspace.path().join("whisper.result.vtt"), VALID_VTT).unwrap();

    let bytes = read_output_vtt(&prefix).await.unwrap();

    assert_eq!(bytes, VALID_VTT);
}

#[tokio::test]
async fn missing_renamed_or_multiple_vtt_outputs_are_rejected() {
    let workspace = tempfile::tempdir().unwrap();
    let prefix = workspace.path().join("transcript");

    let missing = read_output_vtt(&prefix).await;
    assert!(matches!(missing, Err(CaptureError::TranscriptionFailed(_))));

    std::fs::write(workspace.path().join("renamed.vtt"), VALID_VTT).unwrap();
    let renamed = read_output_vtt(&prefix).await;
    assert!(matches!(renamed, Err(CaptureError::TranscriptionFailed(_))));

    std::fs::write(workspace.path().join("transcript.vtt"), VALID_VTT).unwrap();
    let multiple = read_output_vtt(&prefix).await;
    assert!(matches!(
        multiple,
        Err(CaptureError::TranscriptionFailed(_))
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_vtt_output_is_rejected() {
    use std::os::unix::fs::symlink;

    let workspace = tempfile::tempdir().unwrap();
    let prefix = workspace.path().join("transcript");
    let external = workspace.path().join("external.txt");
    std::fs::write(&external, VALID_VTT).unwrap();
    symlink(&external, workspace.path().join("transcript.vtt")).unwrap();

    let result = read_output_vtt(&prefix).await;

    assert!(matches!(result, Err(CaptureError::TranscriptionFailed(_))));
}

#[tokio::test]
async fn oversized_or_malformed_vtt_is_rejected_by_core_policy() {
    let workspace = tempfile::tempdir().unwrap();
    let prefix = workspace.path().join("transcript");
    let output = workspace.path().join("transcript.vtt");
    let oversized = std::fs::File::create(&output).unwrap();
    oversized.set_len((MAX_VTT_BYTES + 1) as u64).unwrap();

    let oversized_result = read_output_vtt(&prefix).await;
    assert!(matches!(oversized_result, Err(CaptureError::InvalidVtt(_))));

    std::fs::write(&output, b"not webvtt").unwrap();
    let malformed_result = read_output_vtt(&prefix).await;
    assert!(matches!(malformed_result, Err(CaptureError::InvalidVtt(_))));
}

#[test]
fn output_file_name_appends_vtt_instead_of_replacing_a_prefix_extension() {
    assert_eq!(
        output_vtt_path(Path::new("/tmp/whisper.result")),
        PathBuf::from("/tmp/whisper.result.vtt")
    );
}
