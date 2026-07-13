use neuralnote_core::ai::{validate_requirement_binary_name, VideoId};
use neuralnote_core::capture::CaptureError;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::AsyncWriteExt;

static WORKSPACE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// One chat-run workspace. Successful operation directories are removed; failed
/// operations move atomically to `<app-data>/capture-failures/<video>-<UTC>`.
/// An unexpected drop deliberately leaves non-empty `capture-tmp` material in
/// place rather than silently deleting a capture whose outcome is unknown.
#[derive(Debug)]
pub(super) struct CaptureWorkspace {
    run_dir: PathBuf,
    failure_dir: PathBuf,
}

impl CaptureWorkspace {
    pub(super) fn new(app_data_dir: &Path) -> Result<Self, CaptureError> {
        if app_data_dir.as_os_str().is_empty() {
            return Err(workspace_error("app-data directory is unavailable"));
        }
        let sequence = WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let run_dir = app_data_dir
            .join("capture-tmp")
            .join(format!("run-{}-{sequence}", std::process::id()));
        std::fs::create_dir_all(&run_dir).map_err(|error| {
            workspace_error(format!("could not create capture workspace: {error}"))
        })?;
        Ok(Self {
            run_dir,
            failure_dir: app_data_dir.join("capture-failures"),
        })
    }

    pub(super) fn begin(
        &self,
        video_id: Option<&VideoId>,
        operation: &str,
    ) -> Result<OperationWorkspace, CaptureError> {
        validate_leaf(operation)?;
        let sequence = WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let video_label = video_id
            .map(ToString::to_string)
            .unwrap_or_else(|| "youtube-unknown".into());
        let path = self
            .run_dir
            .join(format!("{video_label}-{operation}-{sequence}"));
        std::fs::create_dir(&path).map_err(|error| {
            workspace_error(format!(
                "could not create capture operation directory: {error}"
            ))
        })?;
        Ok(OperationWorkspace {
            path,
            failure_dir: self.failure_dir.clone(),
            video_label,
            finished: false,
        })
    }
}

impl Drop for CaptureWorkspace {
    fn drop(&mut self) {
        match std::fs::remove_dir(&self.run_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!(
                "capture workspace '{}' was retained after an unexpected incomplete operation: {error}",
                self.run_dir.display()
            ),
        }
    }
}

#[derive(Debug)]
pub(super) struct OperationWorkspace {
    path: PathBuf,
    failure_dir: PathBuf,
    video_label: String,
    finished: bool,
}

impl OperationWorkspace {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) async fn write_raw(&self, name: &str, bytes: &[u8]) -> Result<(), CaptureError> {
        validate_leaf(name)?;
        let path = self.path.join(name);
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
            .map_err(|error| workspace_error(format!("could not create raw artifact: {error}")))?;
        file.write_all(bytes)
            .await
            .map_err(|error| workspace_error(format!("could not write raw artifact: {error}")))?;
        file.sync_all()
            .await
            .map_err(|error| workspace_error(format!("could not sync raw artifact: {error}")))
    }

    pub(super) async fn complete(mut self) -> Result<(), CaptureError> {
        match tokio::fs::remove_dir_all(&self.path).await {
            Ok(()) => {
                self.finished = true;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.finished = true;
                Ok(())
            }
            Err(error) => Err(workspace_error(format!(
                "capture succeeded, but temporary material could not be cleaned up and remains on disk: {error}"
            ))),
        }
    }

    pub(super) async fn preserve_failure(mut self, error: CaptureError) -> CaptureError {
        if let Err(persist_error) = tokio::fs::create_dir_all(&self.failure_dir).await {
            return append_context(
                error,
                format!(
                    "raw capture remains in the temporary workspace because the failure directory could not be created: {persist_error}"
                ),
            );
        }
        let sequence = WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.9fZ");
        let destination = self
            .failure_dir
            .join(format!("{}-{timestamp}-{sequence}", self.video_label));
        match tokio::fs::rename(&self.path, &destination).await {
            Ok(()) => {
                self.finished = true;
                log::error!(
                    "YouTube capture failed; raw material retained at '{}'",
                    destination.display()
                );
                append_context(
                    error,
                    "raw capture retained under app-data/capture-failures; see the desktop log for the exact path"
                        .into(),
                )
            }
            Err(persist_error) => append_context(
                error,
                format!(
                    "raw capture remains in the temporary workspace because it could not be moved to capture-failures: {persist_error}"
                ),
            ),
        }
    }
}

impl Drop for OperationWorkspace {
    fn drop(&mut self) {
        if !self.finished {
            log::warn!(
                "incomplete YouTube capture material retained at '{}'",
                self.path.display()
            );
        }
    }
}

fn validate_leaf(name: &str) -> Result<(), CaptureError> {
    validate_requirement_binary_name(name)
        .map_err(|_| workspace_error("capture artifact name is not a safe leaf"))
}

fn workspace_error(detail: impl Into<String>) -> CaptureError {
    CaptureError::MetadataUnavailable(detail.into())
}

fn append_context(error: CaptureError, context: String) -> CaptureError {
    let detail = format!("{}; {context}", error.detail());
    match error {
        CaptureError::InvalidSource(_) => CaptureError::InvalidSource(detail),
        CaptureError::MetadataUnavailable(_) => CaptureError::MetadataUnavailable(detail),
        CaptureError::InvalidMetadata(_) => CaptureError::InvalidMetadata(detail),
        CaptureError::CaptionsAbsent(_) => CaptureError::CaptionsAbsent(detail),
        CaptureError::YoutubeBlocked(_) => CaptureError::YoutubeBlocked(detail),
        CaptureError::ExtractorStale(_) => CaptureError::ExtractorStale(detail),
        CaptureError::PotUnavailable(_) => CaptureError::PotUnavailable(detail),
        CaptureError::InvalidVtt(_) => CaptureError::InvalidVtt(detail),
        CaptureError::PlaylistInvalid(_) => CaptureError::PlaylistInvalid(detail),
        CaptureError::ThumbnailRejected(_) => CaptureError::ThumbnailRejected(detail),
        CaptureError::AudioUnavailable(_) => CaptureError::AudioUnavailable(detail),
        CaptureError::UnsupportedAudioCodec(_) => CaptureError::UnsupportedAudioCodec(detail),
        CaptureError::AudioDecodeFailed(_) => CaptureError::AudioDecodeFailed(detail),
        CaptureError::TranscriptionFailed(_) => CaptureError::TranscriptionFailed(detail),
        CaptureError::RequirementMissing(_) => CaptureError::RequirementMissing(detail),
        CaptureError::ProfileInvalid(_) => CaptureError::ProfileInvalid(detail),
        CaptureError::Cancelled(_) => CaptureError::Cancelled(detail),
    }
}

pub(super) fn append_error_context(
    error: CaptureError,
    context: impl Into<String>,
) -> CaptureError {
    append_context(error, context.into())
}
