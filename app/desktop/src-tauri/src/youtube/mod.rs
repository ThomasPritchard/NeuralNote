mod pot;
pub(crate) mod process;
mod service;
mod service_files;
mod service_process;
mod thumbnail;
mod transcription;
mod whisper;
mod workspace;
mod ytdlp;

use neuralnote_core::ai::{CaptureCancellation, ExtractorUpdateSession};
use neuralnote_core::capture::CaptureError;
use std::path::PathBuf;

pub(crate) use service::ShellYoutubeIo;

/// Minimal system-tool search path shared by every YouTube-owned child process.
pub(super) const SANITIZED_PATH: &str = "/usr/bin:/bin";

/// App-session YouTube state. POT and the one extractor-update allowance must
/// outlive individual chat turns, while each turn receives its own cancellation.
#[derive(Clone)]
pub(crate) struct YoutubeHostState {
    pot: pot::PotSidecar,
    extractor_updates: ExtractorUpdateSession,
}

impl Default for YoutubeHostState {
    fn default() -> Self {
        Self {
            pot: pot::PotSidecar::new_real(),
            extractor_updates: ExtractorUpdateSession::default(),
        }
    }
}

impl YoutubeHostState {
    pub(crate) fn create_io(
        &self,
        app_data_dir: PathBuf,
        cancellation: CaptureCancellation,
    ) -> Result<ShellYoutubeIo, CaptureError> {
        ShellYoutubeIo::new(app_data_dir, cancellation, self.pot.clone())
    }

    pub(crate) fn extractor_updates(&self) -> ExtractorUpdateSession {
        self.extractor_updates.clone()
    }

    pub(crate) fn shutdown(&self) {
        self.pot.shutdown();
    }
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod workspace_tests;

#[cfg(test)]
#[path = "thumbnail_tests.rs"]
mod thumbnail_tests;

#[cfg(test)]
#[path = "ytdlp_tests.rs"]
mod ytdlp_tests;

#[cfg(test)]
#[path = "pot_tests.rs"]
mod pot_tests;

#[cfg(test)]
#[path = "live_tests.rs"]
mod live_tests;

#[cfg(test)]
#[path = "service_tests.rs"]
mod service_tests;

#[cfg(test)]
#[path = "service_url_tests.rs"]
mod service_url_tests;

#[cfg(test)]
#[path = "service_files_tests.rs"]
mod service_files_tests;
