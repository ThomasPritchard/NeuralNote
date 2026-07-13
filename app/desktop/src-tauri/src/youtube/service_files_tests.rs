use super::service_files::{
    read_single_artifact, read_valid_vtt, ArtifactKind, MAX_M4A_DOWNLOAD_BYTES,
};
use neuralnote_core::capture::{CaptureError, MAX_VTT_BYTES};

#[cfg(unix)]
#[tokio::test]
async fn symlink_artifacts_are_rejected_without_following_them() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(outside.path(), b"not audio").unwrap();
    symlink(outside.path(), directory.path().join("audio.m4a")).unwrap();

    let error = read_single_artifact(
        directory.path(),
        "m4a",
        MAX_M4A_DOWNLOAD_BYTES,
        ArtifactKind::Audio,
    )
    .await
    .unwrap_err();

    assert!(matches!(error, CaptureError::AudioUnavailable(_)));
}

#[tokio::test]
async fn multiple_vtt_files_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let vtt = b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n";
    std::fs::write(directory.path().join("one.vtt"), vtt).unwrap();
    std::fs::write(directory.path().join("two.vtt"), vtt).unwrap();

    let error = read_valid_vtt(
        directory.path(),
        "vtt",
        MAX_VTT_BYTES,
        ArtifactKind::Caption,
    )
    .await
    .unwrap_err();

    assert!(matches!(error, CaptureError::InvalidVtt(_)));
}

#[tokio::test]
async fn sparse_oversize_audio_is_rejected_before_buffering() {
    let directory = tempfile::tempdir().unwrap();
    let file = std::fs::File::create(directory.path().join("audio.m4a")).unwrap();
    file.set_len((MAX_M4A_DOWNLOAD_BYTES + 1) as u64).unwrap();

    let error = read_single_artifact(
        directory.path(),
        "m4a",
        MAX_M4A_DOWNLOAD_BYTES,
        ArtifactKind::Audio,
    )
    .await
    .unwrap_err();

    assert!(matches!(error, CaptureError::AudioUnavailable(_)));
}
