use super::workspace::CaptureWorkspace;
use neuralnote_core::ai::VideoId;
use neuralnote_core::capture::CaptureError;

#[tokio::test]
async fn successful_operation_removes_its_temporary_material() {
    let app_data = tempfile::tempdir().unwrap();
    let root = CaptureWorkspace::new(app_data.path()).unwrap();
    let video_id = VideoId::new("jNQXAC9IVRw").unwrap();
    let operation = root.begin(Some(&video_id), "captions").unwrap();
    let operation_path = operation.path().to_path_buf();

    operation
        .write_raw("captions.en.vtt", b"WEBVTT\n")
        .await
        .unwrap();
    operation.complete().await.unwrap();

    assert!(!operation_path.exists());
    assert!(!app_data.path().join("capture-failures").exists());
}

#[tokio::test]
async fn failed_operation_moves_raw_material_to_the_documented_failure_directory() {
    let app_data = tempfile::tempdir().unwrap();
    let root = CaptureWorkspace::new(app_data.path()).unwrap();
    let video_id = VideoId::new("jNQXAC9IVRw").unwrap();
    let operation = root.begin(Some(&video_id), "captions").unwrap();
    let operation_path = operation.path().to_path_buf();
    operation
        .write_raw("captions.en.vtt", b"raw caption bytes")
        .await
        .unwrap();

    let original = CaptureError::InvalidVtt("malformed cue".into());
    let retained = operation.preserve_failure(original.clone()).await;

    assert!(matches!(retained, CaptureError::InvalidVtt(_)));
    assert!(!operation_path.exists());
    let failures = app_data.path().join("capture-failures");
    let entries = std::fs::read_dir(&failures)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 1);
    assert!(entries[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("jNQXAC9IVRw-"));
    assert_eq!(
        std::fs::read(entries[0].join("captions.en.vtt")).unwrap(),
        b"raw caption bytes"
    );
}

#[tokio::test]
async fn leading_hyphen_video_ids_remain_plain_directory_data() {
    let app_data = tempfile::tempdir().unwrap();
    let root = CaptureWorkspace::new(app_data.path()).unwrap();
    let video_id = VideoId::new("-abcdefghij").unwrap();
    let operation = root.begin(Some(&video_id), "metadata").unwrap();

    assert!(operation
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("-abcdefghij-"));
    operation.complete().await.unwrap();
}

#[tokio::test]
async fn raw_artifact_names_are_single_safe_leaf_components() {
    let app_data = tempfile::tempdir().unwrap();
    let root = CaptureWorkspace::new(app_data.path()).unwrap();
    let operation = root.begin(None, "metadata").unwrap();

    let error = operation
        .write_raw("../outside.json", b"nope")
        .await
        .unwrap_err();

    assert!(matches!(error, CaptureError::MetadataUnavailable(_)));
    assert!(!app_data.path().join("outside.json").exists());
    operation.complete().await.unwrap();
}

#[test]
fn unexpected_drop_keeps_raw_material_in_capture_tmp() {
    let app_data = tempfile::tempdir().unwrap();
    let root = CaptureWorkspace::new(app_data.path()).unwrap();
    let operation = root.begin(None, "audio").unwrap();
    let operation_path = operation.path().to_path_buf();
    std::fs::write(operation_path.join("audio.m4a"), b"partial").unwrap();

    drop(operation);
    drop(root);

    assert_eq!(
        std::fs::read(operation_path.join("audio.m4a")).unwrap(),
        b"partial"
    );
}
