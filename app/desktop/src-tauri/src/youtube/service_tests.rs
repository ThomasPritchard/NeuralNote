use super::pot::PotSidecar;
use super::process::{OutputStream, ProcessError, ProcessOutput, ProcessRunner, ProcessSpec};
use super::service::ShellYoutubeIo;
use super::thumbnail::finalize_thumbnail;
use async_trait::async_trait;
use neuralnote_core::ai::{
    CaptionRequest, CaptureCancellation, PotMode, ThumbnailPayload, VideoId, YoutubeAnnotation,
    YoutubeIo, YoutubeUrl,
};
use neuralnote_core::capture::{CaptionSource, CaptureError};
use std::collections::VecDeque;
use std::os::unix::process::ExitStatusExt;
use std::sync::{Arc, Mutex};

struct Step {
    exit_code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    written_file: Option<(String, Vec<u8>)>,
}

#[derive(Default)]
struct FakeRunner {
    steps: Mutex<VecDeque<Step>>,
    specs: Mutex<Vec<ProcessSpec>>,
}

impl FakeRunner {
    fn with_steps(steps: impl IntoIterator<Item = Step>) -> Self {
        Self {
            steps: Mutex::new(steps.into_iter().collect()),
            specs: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl ProcessRunner for FakeRunner {
    async fn run(
        &self,
        spec: &ProcessSpec,
        _cancellation: &CaptureCancellation,
    ) -> Result<ProcessOutput, ProcessError> {
        self.specs.lock().unwrap().push(spec.clone());
        let step = self.steps.lock().unwrap().pop_front().unwrap();
        if let Some((name, bytes)) = step.written_file {
            std::fs::write(spec.cwd.as_ref().unwrap().join(name), bytes).unwrap();
        }
        Ok(ProcessOutput {
            status: std::process::ExitStatus::from_raw(step.exit_code << 8),
            stdout: step.stdout,
            stderr: step.stderr,
        })
    }
}

struct ErrorRunner(Mutex<Option<ProcessError>>);

#[async_trait]
impl ProcessRunner for ErrorRunner {
    async fn run(
        &self,
        _spec: &ProcessSpec,
        _cancellation: &CaptureCancellation,
    ) -> Result<ProcessOutput, ProcessError> {
        Err(self.0.lock().unwrap().take().unwrap())
    }
}

fn valid_metadata() -> Vec<u8> {
    br#"{"id":"jNQXAC9IVRw","title":"Me at the zoo","uploader":"jawed","duration":19,"upload_date":"20050423","subtitles":{"en":[{"ext":"vtt"}]},"automatic_captions":{}}"#.to_vec()
}

fn io_with_steps(
    app_data: &std::path::Path,
    steps: impl IntoIterator<Item = Step>,
) -> ShellYoutubeIo {
    ShellYoutubeIo::with_runner(
        app_data.to_path_buf(),
        Arc::new(FakeRunner::with_steps(steps)),
        CaptureCancellation::default(),
        None,
    )
    .unwrap()
}

#[tokio::test]
async fn metadata_is_core_validated_and_successful_po_warning_is_annotated() {
    let app_data = tempfile::tempdir().unwrap();
    let io = io_with_steps(
        app_data.path(),
        [Step {
            exit_code: 0,
            stdout: valid_metadata(),
            stderr: b"WARNING: subtitles languages because a PO Token was not provided".to_vec(),
            written_file: None,
        }],
    );
    let url = YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap();

    let payload = io.inspect_metadata(&url).await.unwrap();

    assert_eq!(payload.json, valid_metadata());
    assert_eq!(
        payload.annotations,
        vec![YoutubeAnnotation::SubtitleListingWithheld]
    );
    assert!(!app_data.path().join("capture-failures").exists());
}

#[tokio::test]
async fn invalid_success_payload_is_retained_in_capture_failures() {
    let app_data = tempfile::tempdir().unwrap();
    let io = io_with_steps(
        app_data.path(),
        [Step {
            exit_code: 0,
            stdout: b"not metadata json".to_vec(),
            stderr: Vec::new(),
            written_file: None,
        }],
    );
    let url = YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap();

    let error = io.inspect_metadata(&url).await.unwrap_err();

    assert!(matches!(error, CaptureError::InvalidMetadata(_)));
    let retained = std::fs::read_dir(app_data.path().join("capture-failures"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        std::fs::read(retained.join("metadata.json")).unwrap(),
        b"not metadata json"
    );
}

#[tokio::test]
async fn every_nonzero_ytdlp_exit_uses_the_core_classifier_and_retains_diagnostics() {
    let app_data = tempfile::tempdir().unwrap();
    let io = io_with_steps(
        app_data.path(),
        [Step {
            exit_code: 1,
            stdout: b"partial".to_vec(),
            stderr: b"ERROR: HTTP Error 403: Forbidden".to_vec(),
            written_file: None,
        }],
    );
    let url = YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap();

    let error = io.inspect_metadata(&url).await.unwrap_err();

    assert!(matches!(error, CaptureError::YoutubeBlocked(_)));
    let retained = std::fs::read_dir(app_data.path().join("capture-failures"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        std::fs::read(retained.join("stdout.log")).unwrap(),
        b"partial"
    );
    assert!(std::fs::read(retained.join("stderr.log"))
        .unwrap()
        .starts_with(b"ERROR"));
}

#[tokio::test]
async fn generic_nonzero_audio_and_playlist_failures_keep_operation_specific_errors() {
    let audio_data = tempfile::tempdir().unwrap();
    let audio_io = io_with_steps(
        audio_data.path(),
        [Step {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: b"ERROR: Requested format is not available".to_vec(),
            written_file: None,
        }],
    );
    let video_url = YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap();

    let audio_error = audio_io
        .transcribe_audio(&video_url, "small.en", &CaptureCancellation::default())
        .await
        .unwrap_err();

    assert!(
        matches!(&audio_error, CaptureError::AudioUnavailable(detail) if detail.contains("AAC-LC")),
        "{audio_error:?}"
    );

    let playlist_data = tempfile::tempdir().unwrap();
    let playlist_io = io_with_steps(
        playlist_data.path(),
        [Step {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: b"ERROR: playlist does not exist".to_vec(),
            written_file: None,
        }],
    );
    let playlist_url = YoutubeUrl::new("https://www.youtube.com/playlist?list=PL123").unwrap();

    let playlist_error = playlist_io
        .enumerate_playlist(&playlist_url)
        .await
        .unwrap_err();

    assert!(
        matches!(playlist_error, CaptureError::PlaylistInvalid(_)),
        "{playlist_error:?}"
    );
}

#[tokio::test]
async fn bounded_process_failures_still_use_the_core_terminal_classifier() {
    let failures = [
        ProcessError::OutputOverflow {
            stream: OutputStream::Stderr,
            limit: 1024,
            stdout: Vec::new(),
            stderr: b"ERROR: HTTP Error 403: Forbidden".to_vec(),
        },
        ProcessError::TimedOut {
            timeout: std::time::Duration::from_secs(1),
            stdout: Vec::new(),
            stderr: b"ERROR: HTTP Error 429: Too Many Requests".to_vec(),
        },
    ];

    for failure in failures {
        let app_data = tempfile::tempdir().unwrap();
        let io = ShellYoutubeIo::with_runner(
            app_data.path().to_path_buf(),
            Arc::new(ErrorRunner(Mutex::new(Some(failure)))),
            CaptureCancellation::default(),
            None,
        )
        .unwrap();
        let url = YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap();

        let error = io.inspect_metadata(&url).await.unwrap_err();

        assert!(
            matches!(error, CaptureError::YoutubeBlocked(_)),
            "{error:?}"
        );
    }
}

#[tokio::test]
async fn diagnostic_retention_failure_does_not_weaken_a_terminal_block_classification() {
    let app_data = tempfile::tempdir().unwrap();
    let io = io_with_steps(
        app_data.path(),
        [Step {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: b"ERROR: HTTP Error 403: Forbidden".to_vec(),
            written_file: Some(("stdout.log".into(), b"occupied".to_vec())),
        }],
    );
    let request = CaptionRequest {
        url: YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap(),
        language: "en".into(),
        source: CaptionSource::Human,
        pot: PotMode::Disabled,
    };

    let error = io.fetch_caption_vtt(&request).await.unwrap_err();

    assert!(
        matches!(&error, CaptureError::YoutubeBlocked(detail) if detail.contains("raw artifact")),
        "{error:?}"
    );
}

#[tokio::test]
async fn caption_files_are_bounded_core_validated_and_removed_after_success() {
    let app_data = tempfile::tempdir().unwrap();
    let vtt = b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n".to_vec();
    let io = io_with_steps(
        app_data.path(),
        [Step {
            exit_code: 0,
            stdout: Vec::new(),
            stderr: Vec::new(),
            written_file: Some(("captions.en.vtt".into(), vtt.clone())),
        }],
    );
    let request = CaptionRequest {
        url: YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap(),
        language: "en".into(),
        source: CaptionSource::Human,
        pot: PotMode::Disabled,
    };

    let payload = io.fetch_caption_vtt(&request).await.unwrap();

    assert_eq!(payload.vtt, vtt);
    assert!(payload.annotations.is_empty());
    drop(io);
    let capture_tmp = app_data.path().join("capture-tmp");
    assert_eq!(std::fs::read_dir(capture_tmp).unwrap().count(), 0);
}

#[tokio::test]
async fn a_cancelled_run_never_starts_an_extractor_process() {
    let app_data = tempfile::tempdir().unwrap();
    let cancellation = CaptureCancellation::default();
    cancellation.cancel();
    let io = ShellYoutubeIo::with_runner(
        app_data.path().to_path_buf(),
        Arc::new(FakeRunner::default()),
        cancellation,
        None,
    )
    .unwrap();
    let url = YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap();

    let error = io.inspect_metadata(&url).await.unwrap_err();

    assert!(matches!(error, CaptureError::Cancelled(_)));
}

#[tokio::test]
async fn a_pre_cancelled_prefer_caption_stops_before_pot_or_extractor_work() {
    let app_data = tempfile::tempdir().unwrap();
    let cancellation = CaptureCancellation::default();
    cancellation.cancel();
    let runner = Arc::new(FakeRunner::default());
    let io = ShellYoutubeIo::with_runner(
        app_data.path().to_path_buf(),
        runner.clone(),
        cancellation,
        Some(PotSidecar::new_real()),
    )
    .unwrap();
    let request = CaptionRequest {
        url: YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap(),
        language: "en".into(),
        source: CaptionSource::Human,
        pot: PotMode::Prefer,
    };

    let error = io.fetch_caption_vtt(&request).await.unwrap_err();

    assert!(matches!(error, CaptureError::Cancelled(_)), "{error:?}");
    assert!(runner.specs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn invalid_fetched_thumbnail_bytes_are_retained_before_core_rejection() {
    let app_data = tempfile::tempdir().unwrap();
    let io = io_with_steps(app_data.path(), []);
    let video_id = VideoId::new("jNQXAC9IVRw").unwrap();
    let operation = io.workspace.begin(Some(&video_id), "thumbnail").unwrap();

    let error = finalize_thumbnail(
        operation,
        Ok(ThumbnailPayload {
            media_type: "image/jpeg".into(),
            bytes: b"not really a jpeg".to_vec(),
        }),
    )
    .await
    .unwrap_err();

    assert!(matches!(error, CaptureError::ThumbnailRejected(_)));
    let retained = std::fs::read_dir(app_data.path().join("capture-failures"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        std::fs::read(retained.join("thumbnail.raw")).unwrap(),
        b"not really a jpeg"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn transcription_downloads_decodes_and_runs_the_app_data_whisper_bundle() {
    const M4A: &[u8] = include_bytes!(
        "../../../../../crates/neuralnote-core/tests/fixtures/audio/aac-lc-fragmented.m4a"
    );
    const VTT: &[u8] = include_bytes!(
        "../../../../../crates/neuralnote-core/tests/fixtures/vtt/whisper_1_9_1.vtt"
    );
    let app_data = tempfile::tempdir().unwrap();
    install_fake_whisper_bundle(app_data.path());
    let io = io_with_steps(
        app_data.path(),
        [
            Step {
                exit_code: 0,
                stdout: Vec::new(),
                stderr: Vec::new(),
                written_file: Some(("audio.m4a".into(), M4A.to_vec())),
            },
            Step {
                exit_code: 0,
                stdout: Vec::new(),
                stderr: Vec::new(),
                written_file: Some(("transcript.vtt".into(), VTT.to_vec())),
            },
        ],
    );
    let url = YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap();

    let payload = io
        .transcribe_audio(&url, "small.en", &CaptureCancellation::default())
        .await
        .unwrap();

    assert_eq!(payload.vtt, VTT);
    assert!(payload.annotations.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_nonzero_whisper_exit_surfaces_and_retains_its_captured_stderr() {
    const M4A: &[u8] = include_bytes!(
        "../../../../../crates/neuralnote-core/tests/fixtures/audio/aac-lc-fragmented.m4a"
    );
    let app_data = tempfile::tempdir().unwrap();
    install_fake_whisper_bundle(app_data.path());
    let io = io_with_steps(
        app_data.path(),
        [
            Step {
                exit_code: 0,
                stdout: Vec::new(),
                stderr: Vec::new(),
                written_file: Some(("audio.m4a".into(), M4A.to_vec())),
            },
            Step {
                exit_code: 9,
                stdout: Vec::new(),
                stderr: b"model load failed: fixture diagnostic".to_vec(),
                written_file: None,
            },
        ],
    );
    let url = YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap();

    let error = io
        .transcribe_audio(&url, "small.en", &CaptureCancellation::default())
        .await
        .unwrap_err();

    assert!(
        matches!(&error, CaptureError::TranscriptionFailed(detail) if detail.contains("model load failed: fixture diagnostic")),
        "{error:?}"
    );
    let retained = std::fs::read_dir(app_data.path().join("capture-failures"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        std::fs::read(retained.join("whisper-stderr.log")).unwrap(),
        b"model load failed: fixture diagnostic"
    );
}

#[cfg(unix)]
fn install_fake_whisper_bundle(app_data: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    let bin = app_data.join("bin");
    let assets = app_data.join("assets");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&assets).unwrap();
    let whisper = bin.join("whisper-cli");
    std::fs::write(&whisper, b"fixture").unwrap();
    std::fs::set_permissions(&whisper, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(assets.join("ggml-small.en.bin"), b"fixture model").unwrap();
}

#[test]
fn video_id_type_used_by_tests_remains_the_frozen_core_type() {
    assert!(VideoId::new("jNQXAC9IVRw").is_ok());
}
