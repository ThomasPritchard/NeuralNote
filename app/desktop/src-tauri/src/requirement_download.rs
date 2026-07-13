//! Download transport for compiled-in skill requirements.
//!
//! Core owns the allowlist. This shell module owns the cancellable HTTP stream
//! and terminal Tauri events; `requirement_installer` owns filesystem policy.

use neuralnote_core::ai::{
    lookup_requirement_binary, lookup_requirement_source_build, PullEvent, PullSink,
    RequirementBinary,
};
use neuralnote_core::{CoreError, CoreResult};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Cancellation state independent from Ollama's model pull. Each accepted
/// requirement download installs a fresh token, so a stale Cancel cannot abort a
/// later retry and cancelling a requirement never touches a model pull.
#[derive(Clone, Default)]
pub(crate) struct RequirementDownloadState {
    active_cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl RequirementDownloadState {
    /// Acquire the sole in-process requirement-download slot. The installer also
    /// takes a per-file OS lock because another app process does not share this state.
    pub(crate) fn try_start(&self) -> CoreResult<RequirementDownloadLease> {
        let mut active = lock_active_cancel(&self.active_cancel);
        if active.is_some() {
            return Err(CoreError::Conflict(
                "a skill requirement download is already in progress".into(),
            ));
        }
        let token = Arc::new(AtomicBool::new(false));
        *active = Some(Arc::clone(&token));
        Ok(RequirementDownloadLease {
            active_cancel: Arc::clone(&self.active_cancel),
            cancel: token,
        })
    }

    pub(crate) fn cancel_active(&self) {
        if let Some(cancel) = lock_active_cancel(&self.active_cancel).as_ref() {
            cancel.store(true, Ordering::SeqCst);
        }
    }
}

/// RAII ownership of the one in-progress requirement download. Dropping the
/// command future releases the slot as well as the installer's `.part` cleanup
/// guard, so cancellation cannot permanently wedge later retries.
pub(crate) struct RequirementDownloadLease {
    active_cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    cancel: Arc<AtomicBool>,
}

impl RequirementDownloadLease {
    pub(crate) fn cancel_token(&self) -> &AtomicBool {
        &self.cancel
    }

    fn shared_cancel_token(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }
}

impl Drop for RequirementDownloadLease {
    fn drop(&mut self) {
        let mut active = lock_active_cancel(&self.active_cancel);
        if active
            .as_ref()
            .is_some_and(|cancel| Arc::ptr_eq(cancel, &self.cancel))
        {
            *active = None;
        }
    }
}

fn lock_active_cancel(
    active_cancel: &Mutex<Option<Arc<AtomicBool>>>,
) -> MutexGuard<'_, Option<Arc<AtomicBool>>> {
    active_cancel
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Download one compiled-in requirement and stream only progress from this I/O
/// helper. The Tauri command below owns the sole terminal Success/Error event.
pub(crate) async fn download_requirement_file(
    app_data_dir: &Path,
    requirement: &RequirementBinary,
    sink: &mut dyn PullSink,
    cancel: &AtomicBool,
) -> CoreResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(CoreError::Io("Download cancelled.".into()));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        // An idle read ceiling, not a total deadline: requirement files may be
        // large, but a half-open stream must resolve to an explicit terminal error.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| {
            CoreError::Io(format!(
                "could not create requirement download client: {error}"
            ))
        })?;
    let request = client.get(requirement.url).send();
    let response = tokio::select! {
        biased;
        () = crate::requirement_installer::wait_for_requirement_cancellation(cancel) => {
            return Err(CoreError::Io("Download cancelled.".into()));
        }
        response = request => response.map_err(|error| {
            CoreError::Io(format!(
                "could not start requirement download '{}': {error}",
                requirement.name
            ))
        })?,
    };
    if !response.status().is_success() {
        return Err(CoreError::Io(format!(
            "requirement download '{}' returned HTTP {}",
            requirement.name,
            response.status()
        )));
    }
    let total = response.content_length();
    crate::requirement_installer::install_requirement_stream(
        app_data_dir,
        requirement,
        total,
        response.bytes_stream(),
        sink,
        cancel,
    )
    .await
}

pub(crate) struct ShellYoutubeRequirementInstaller {
    app_data_dir: std::path::PathBuf,
    state: RequirementDownloadState,
}

impl ShellYoutubeRequirementInstaller {
    pub(crate) fn new(app_data_dir: std::path::PathBuf, state: RequirementDownloadState) -> Self {
        Self {
            app_data_dir,
            state,
        }
    }
}

struct ChatProgressSink<'a>(&'a mut dyn neuralnote_core::ai::EventSink);

impl PullSink for ChatProgressSink<'_> {
    fn send(&mut self, event: PullEvent) {
        if let PullEvent::Progress { status, .. } = event {
            self.0
                .send(neuralnote_core::ai::ChatEvent::SkillStep { message: status });
        }
    }
}

#[async_trait::async_trait]
impl neuralnote_core::ai::YoutubeRequirementInstaller for ShellYoutubeRequirementInstaller {
    async fn install_whisper_bundle(
        &self,
        sink: &mut dyn neuralnote_core::ai::EventSink,
        cancellation: &neuralnote_core::ai::CaptureCancellation,
    ) -> Result<(), neuralnote_core::capture::CaptureError> {
        let lease = self.state.try_start().map_err(|error| {
            neuralnote_core::capture::CaptureError::RequirementMissing(crate::ai::error_detail(
                error,
            ))
        })?;
        let mut progress = ChatProgressSink(sink);
        let installed = crate::requirement_detection::detect_requirement_files(&self.app_data_dir);
        let whisper = self.app_data_dir.join("bin/whisper-cli");
        if !installed.contains(&whisper) {
            let recipe = lookup_requirement_source_build("whisper-cli").map_err(|error| {
                neuralnote_core::capture::CaptureError::RequirementMissing(crate::ai::error_detail(
                    error,
                ))
            })?;
            crate::requirement_source_build::install_whisper_from_source(
                &self.app_data_dir,
                recipe,
                &mut progress,
                cancellation,
            )
            .await
            .map_err(|error| {
                neuralnote_core::capture::CaptureError::RequirementMissing(crate::ai::error_detail(
                    error,
                ))
            })?;
        }
        let model = self.app_data_dir.join("assets/ggml-small.en.bin");
        if !crate::requirement_detection::detect_requirement_files(&self.app_data_dir)
            .contains(&model)
        {
            let requirement = lookup_requirement_binary("ggml-small.en.bin").map_err(|error| {
                neuralnote_core::capture::CaptureError::RequirementMissing(crate::ai::error_detail(
                    error,
                ))
            })?;
            let atomic = lease.shared_cancel_token();
            let cancellation = cancellation.clone();
            let watcher = tokio::spawn(async move {
                while !cancellation.is_cancelled() {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                atomic.store(true, Ordering::SeqCst);
            });
            let result = download_requirement_file(
                &self.app_data_dir,
                &requirement,
                &mut progress,
                lease.cancel_token(),
            )
            .await;
            watcher.abort();
            result.map_err(|error| {
                neuralnote_core::capture::CaptureError::RequirementMissing(crate::ai::error_detail(
                    error,
                ))
            })?;
        }
        Ok(())
    }
}

/// Download an allowlisted skill requirement into its app-data directory. Name
/// lookup happens in core, so the caller controls neither URL, kind, nor target.
/// Exactly one terminal event leaves this function on every path.
#[tauri::command]
pub(crate) async fn download_requirement(
    app: AppHandle,
    state: crate::SharedState<'_>,
    name: String,
    on_event: tauri::ipc::Channel<PullEvent>,
) -> Result<(), ()> {
    let mut sink = crate::local::TauriPullSink::new(on_event);
    let direct = lookup_requirement_binary(&name).ok();
    let source_build = lookup_requirement_source_build(&name).ok();
    if direct.is_none() && source_build.is_none() {
        let error = lookup_requirement_binary(&name).unwrap_err();
        sink.send(PullEvent::Error {
            message: crate::ai::error_detail(error),
        });
        return Ok(());
    }
    let app_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            sink.send(PullEvent::Error {
                message: format!("no app data directory for skill requirements: {error}"),
            });
            return Ok(());
        }
    };
    // Acquire the single-flight lease before the first await. The AppState mutex
    // remains short-lived; the lease owns independent state and releases on Drop.
    let lease = match crate::lock_state(&state).requirement_download.try_start() {
        Ok(lease) => lease,
        Err(error) => {
            sink.send(PullEvent::Error {
                message: crate::ai::error_detail(error),
            });
            return Ok(());
        }
    };
    let result = if let Some(recipe) = source_build {
        let cancellation = neuralnote_core::ai::CaptureCancellation::default();
        let watcher_cancel = cancellation.clone();
        let token = lease.shared_cancel_token();
        let watcher = tokio::spawn(async move {
            crate::requirement_installer::wait_for_requirement_cancellation(&token).await;
            watcher_cancel.cancel();
        });
        let result = crate::requirement_source_build::install_whisper_from_source(
            &app_data_dir,
            recipe,
            &mut sink,
            &cancellation,
        )
        .await;
        watcher.abort();
        result
    } else {
        download_requirement_file(
            &app_data_dir,
            &direct.expect("one requirement route was checked above"),
            &mut sink,
            lease.cancel_token(),
        )
        .await
    };
    match result {
        Ok(()) => sink.send(PullEvent::Success),
        Err(error) => sink.send(PullEvent::Error {
            message: crate::ai::error_detail(error),
        }),
    }
    Ok(())
}

/// Cancel only the most-recent skill-requirement download.
#[tauri::command]
pub(crate) fn cancel_requirement_download(state: crate::SharedState<'_>) {
    crate::lock_state(&state)
        .requirement_download
        .cancel_active();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requirement_downloads_are_single_flight_and_release_on_drop() {
        let state = RequirementDownloadState::default();
        let first = state.try_start().unwrap();

        assert!(matches!(state.try_start(), Err(CoreError::Conflict(_))));
        state.cancel_active();
        assert!(first.cancel_token().load(Ordering::SeqCst));

        drop(first);
        let retry = state.try_start().unwrap();
        assert!(!retry.cancel_token().load(Ordering::SeqCst));
    }
}
