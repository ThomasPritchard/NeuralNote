//! Host I/O seam and per-run state for the YouTube distil skill.
//!
//! The host owns processes, network, and temporary files. Core receives bounded
//! raw payloads, parses them, and exposes only validated projections to the model.

use crate::ai::events::EventSink;
use crate::ai::write_policy::NoteKind;
use crate::capture::error::{CaptureAction, CaptureError, ExtractorUpdatePolicy};
use crate::capture::youtube::CaptionSource;
pub use crate::capture::youtube::{VideoId, YoutubeUrl};
use async_trait::async_trait;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const WHISPER_MODEL_NAME: &str = "small.en";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PotMode {
    /// Use a healthy optional POT sidecar when the host has one.
    Prefer,
    /// Bypass POT after a sidecar/provider failure and try the plain extractor.
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataPayload {
    pub json: Vec<u8>,
    /// Typed, path-free host facts safe to project into model context.
    pub annotations: Vec<YoutubeAnnotation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptionRequest {
    pub url: YoutubeUrl,
    pub language: String,
    pub source: CaptionSource,
    pub pot: PotMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptionPayload {
    pub vtt: Vec<u8>,
    /// Typed, path-free host facts safe to project into model context.
    pub annotations: Vec<YoutubeAnnotation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YoutubeAnnotation {
    PotUnavailable,
    SubtitleListingWithheld,
}

impl YoutubeAnnotation {
    pub fn message(self) -> &'static str {
        match self {
            Self::PotUnavailable => {
                "optional POT sidecar unavailable; captions continued without POT"
            }
            Self::SubtitleListingWithheld => {
                "a PO-token warning withheld subtitle languages from an otherwise successful metadata response"
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistPayload {
    pub json: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThumbnailPayload {
    pub media_type: String,
    pub bytes: Vec<u8>,
}

/// Runtime-neutral cancellation shared between the host and one capture run.
#[derive(Debug, Clone, Default)]
pub struct CaptureCancellation(Arc<AtomicBool>);

impl CaptureCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Shareable allowance for one host-owned `yt-dlp -U` call. Hosts retain this at
/// app-session scope and clone it into each run that shares the allowance.
#[derive(Debug, Clone, Default)]
pub struct ExtractorUpdateSession(Arc<Mutex<ExtractorUpdatePolicy>>);

impl ExtractorUpdateSession {
    fn decide(&self, error: &CaptureError) -> CaptureAction {
        self.policy().decide(error)
    }

    fn update_attempted(&self) -> bool {
        self.policy().update_attempted()
    }

    fn policy(&self) -> std::sync::MutexGuard<'_, ExtractorUpdatePolicy> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Host-owned YouTube I/O.
///
/// Implementations must construct every yt-dlp process failure through
/// [`crate::capture::classify_ytdlp_failure`] so block and retry policy remains
/// identical across hosts. A [`VideoId`] may begin with `-`; argv callers must
/// honor its documented non-flag placement contract.
#[async_trait]
pub trait YoutubeIo: Send + Sync {
    async fn inspect_metadata(&self, url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError>;

    async fn fetch_caption_vtt(
        &self,
        request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError>;

    async fn enumerate_playlist(&self, url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError>;

    /// Fetch the spec-pinned `mqdefault.jpg` image. A missing thumbnail must be
    /// returned as [`CaptureError::ThumbnailRejected`] so selection can continue
    /// without an image; implementations must not substitute `maxresdefault`.
    async fn fetch_thumbnail(&self, video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError>;

    async fn transcribe_audio(
        &self,
        url: &YoutubeUrl,
        model: &str,
        cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError>;

    /// Run the host-owned `yt-dlp -U` operation. Core calls this at most once for
    /// the supplied update session and retries the failed operation exactly once.
    async fn update_extractor(&self) -> Result<(), CaptureError>;
}

#[async_trait]
pub trait YoutubeRequirementInstaller: Send + Sync {
    async fn install_whisper_bundle(
        &self,
        sink: &mut dyn EventSink,
        cancellation: &CaptureCancellation,
    ) -> Result<(), CaptureError>;
}

#[derive(Debug, Default)]
pub struct UnavailableYoutubeRequirementInstaller;

pub static UNAVAILABLE_YOUTUBE_REQUIREMENT_INSTALLER: UnavailableYoutubeRequirementInstaller =
    UnavailableYoutubeRequirementInstaller;

#[async_trait]
impl YoutubeRequirementInstaller for UnavailableYoutubeRequirementInstaller {
    async fn install_whisper_bundle(
        &self,
        _sink: &mut dyn EventSink,
        _cancellation: &CaptureCancellation,
    ) -> Result<(), CaptureError> {
        Err(CaptureError::RequirementMissing(
            "Whisper installer is not wired".into(),
        ))
    }
}

#[derive(Debug, Default)]
pub struct UnavailableYoutubeIo;

pub static UNAVAILABLE_YOUTUBE_IO: UnavailableYoutubeIo = UnavailableYoutubeIo;

fn unavailable(operation: &str) -> CaptureError {
    CaptureError::RequirementMissing(format!("YouTube host I/O is not wired; cannot {operation}"))
}

#[async_trait]
impl YoutubeIo for UnavailableYoutubeIo {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        Err(unavailable("inspect metadata"))
    }

    async fn fetch_caption_vtt(
        &self,
        _request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(unavailable("fetch captions"))
    }

    async fn enumerate_playlist(&self, _url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        Err(unavailable("enumerate a playlist"))
    }

    async fn fetch_thumbnail(&self, _video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        Err(unavailable("fetch a thumbnail"))
    }

    async fn transcribe_audio(
        &self,
        _url: &YoutubeUrl,
        _model: &str,
        _cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(unavailable("transcribe audio"))
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        Err(unavailable("update the extractor"))
    }
}

/// State whose lifetime is one chat run, not one tool call.
#[derive(Debug, Clone, Default)]
pub struct YoutubeToolSession {
    extractor: ExtractorUpdateSession,
    captions_absent_sources: BTreeMap<String, VideoId>,
    cancellation: CaptureCancellation,
    annotations: Vec<String>,
    terminal_error: Option<CaptureError>,
    playlist: Option<PlaylistRun>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlaylistItemOutcome {
    Succeeded { video_id: String },
    Failed { video_id: String, reason: String },
    Cancelled { video_id: String },
}

#[derive(Debug, Clone, Default)]
struct PlaylistItemWrites {
    literature: bool,
    transcript: bool,
}

#[derive(Debug, Clone)]
struct PlaylistRun {
    selected: Vec<String>,
    current: usize,
    current_turns: usize,
    writes: PlaylistItemWrites,
    outcomes: Vec<PlaylistItemOutcome>,
    reported_outcomes: usize,
}

impl YoutubeToolSession {
    pub fn new(cancellation: CaptureCancellation) -> Self {
        Self::new_with_update_session(cancellation, ExtractorUpdateSession::default())
    }

    pub fn new_with_update_session(
        cancellation: CaptureCancellation,
        extractor: ExtractorUpdateSession,
    ) -> Self {
        Self {
            cancellation,
            extractor,
            ..Self::default()
        }
    }

    pub(super) fn mark_captions_absent(&mut self, source: &YoutubeUrl, video_id: VideoId) {
        self.captions_absent_sources
            .insert(source.as_ref().to_string(), video_id);
    }

    pub fn can_transcribe(&self, source: &YoutubeUrl) -> bool {
        self.captions_absent_sources.contains_key(source.as_ref())
    }

    pub(super) fn transcription_video_id(&self, source: &YoutubeUrl) -> Option<&VideoId> {
        self.captions_absent_sources.get(source.as_ref())
    }

    pub fn whisper_model(&self) -> &'static str {
        WHISPER_MODEL_NAME
    }

    pub fn cancellation(&self) -> &CaptureCancellation {
        &self.cancellation
    }

    pub fn decide(&mut self, error: &CaptureError) -> CaptureAction {
        self.extractor.decide(error)
    }

    pub fn update_attempted(&self) -> bool {
        self.extractor.update_attempted()
    }

    pub(crate) fn annotate(&mut self, annotation: impl Into<String>) {
        self.annotations.push(annotation.into());
    }

    pub fn annotations(&self) -> &[String] {
        &self.annotations
    }

    /// A block-shaped failure stops further YouTube I/O for this run.
    pub fn terminal_error(&self) -> Option<&CaptureError> {
        self.terminal_error.as_ref()
    }

    pub fn observe_error(&mut self, error: &CaptureError) {
        if matches!(error, CaptureError::YoutubeBlocked(_)) && self.terminal_error.is_none() {
            self.terminal_error = Some(error.clone());
        }
    }

    pub(crate) fn begin_playlist(&mut self, selected: Vec<String>) -> Result<(), CaptureError> {
        self.ensure_playlist_uninitialized()?;
        if selected.is_empty() {
            return Err(CaptureError::PlaylistInvalid(
                "playlist selection cannot be empty".into(),
            ));
        }
        self.playlist = Some(PlaylistRun {
            selected,
            current: 0,
            current_turns: 0,
            writes: PlaylistItemWrites::default(),
            outcomes: Vec::new(),
            reported_outcomes: 0,
        });
        Ok(())
    }

    pub(crate) fn ensure_playlist_uninitialized(&self) -> Result<(), CaptureError> {
        if self.playlist.is_some() {
            return Err(CaptureError::PlaylistInvalid(
                "a playlist selection is already fixed for this chat run".into(),
            ));
        }
        Ok(())
    }

    pub fn validate_playlist_capture_url(&self, url: &YoutubeUrl) -> Result<(), CaptureError> {
        let Some(video_id) = url.video_id() else {
            if self.playlist.is_none() {
                return Ok(());
            }
            return Err(CaptureError::PlaylistInvalid(
                "playlist capture URL does not contain a supported video id".into(),
            ));
        };
        self.validate_playlist_video_id(&video_id)
    }

    pub fn validate_playlist_video_id(&self, supplied: &VideoId) -> Result<(), CaptureError> {
        let Some(run) = self.playlist.as_ref() else {
            return Ok(());
        };
        let Some(expected) = run.selected.get(run.current) else {
            return Err(CaptureError::PlaylistInvalid(
                "playlist capture is complete; no further capture URL is authorized".into(),
            ));
        };
        if supplied.as_ref() != expected {
            return Err(CaptureError::PlaylistInvalid(format!(
                "playlist capture URL targets '{}', but the active selected video is '{}'",
                supplied.as_ref(),
                expected
            )));
        }
        Ok(())
    }

    pub(crate) fn playlist_is_active(&self) -> bool {
        self.playlist
            .as_ref()
            .is_some_and(|run| run.current < run.selected.len())
    }

    pub(crate) fn playlist_is_finished(&self) -> bool {
        self.playlist
            .as_ref()
            .is_some_and(|run| run.current == run.selected.len())
    }

    pub(crate) fn playlist_current(&self) -> Option<(usize, usize, &str)> {
        let run = self.playlist.as_ref()?;
        let video_id = run.selected.get(run.current)?;
        Some((run.current, run.selected.len(), video_id))
    }

    pub(crate) fn record_playlist_turn(&mut self) -> Option<usize> {
        let run = self.playlist.as_mut()?;
        if run.current >= run.selected.len() {
            return None;
        }
        run.current_turns = run.current_turns.saturating_add(1);
        Some(run.current_turns)
    }

    pub(crate) fn validate_playlist_work_item(&self, work_item: usize) -> Result<(), CaptureError> {
        let Some(run) = self.playlist.as_ref() else {
            return Ok(());
        };
        if run.current >= run.selected.len() || work_item != run.current {
            return Err(CaptureError::PlaylistInvalid(format!(
                "write_note work_item {work_item} does not match the active playlist work item {}",
                run.current
            )));
        }
        Ok(())
    }

    pub(crate) fn record_playlist_write(&mut self, work_item: usize, kind: NoteKind) {
        let Some(run) = self.playlist.as_mut() else {
            return;
        };
        if work_item != run.current || run.current >= run.selected.len() {
            return;
        }
        match kind {
            NoteKind::Literature => run.writes.literature = true,
            NoteKind::Transcript => run.writes.transcript = true,
            NoteKind::Atomic => {}
        }
        if run.writes.literature && run.writes.transcript {
            let video_id = run.selected[run.current].clone();
            run.outcomes
                .push(PlaylistItemOutcome::Succeeded { video_id });
            advance_playlist(run);
        }
    }

    pub(crate) fn fail_playlist_item(&mut self, reason: impl Into<String>) {
        let Some(run) = self.playlist.as_mut() else {
            return;
        };
        let Some(video_id) = run.selected.get(run.current).cloned() else {
            return;
        };
        run.outcomes.push(PlaylistItemOutcome::Failed {
            video_id,
            reason: reason.into(),
        });
        advance_playlist(run);
    }

    pub(crate) fn cancel_playlist_remaining(&mut self) {
        let Some(run) = self.playlist.as_mut() else {
            return;
        };
        while let Some(video_id) = run.selected.get(run.current).cloned() {
            run.outcomes
                .push(PlaylistItemOutcome::Cancelled { video_id });
            advance_playlist(run);
        }
    }

    pub(crate) fn take_unreported_playlist_outcomes(&mut self) -> Vec<PlaylistItemOutcome> {
        let Some(run) = self.playlist.as_mut() else {
            return Vec::new();
        };
        let outcomes = run.outcomes[run.reported_outcomes..].to_vec();
        run.reported_outcomes = run.outcomes.len();
        outcomes
    }

    pub(crate) fn playlist_summary(&self) -> Option<String> {
        let run = self.playlist.as_ref()?;
        Some(
            run.outcomes
                .iter()
                .map(|outcome| match outcome {
                    PlaylistItemOutcome::Succeeded { video_id } => {
                        format!("{video_id}: succeeded")
                    }
                    PlaylistItemOutcome::Failed { video_id, reason } => {
                        format!("{video_id}: failed ({reason})")
                    }
                    PlaylistItemOutcome::Cancelled { video_id } => {
                        format!("{video_id}: cancelled")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )
    }
}

fn advance_playlist(run: &mut PlaylistRun) {
    run.current += 1;
    run.current_turns = 0;
    run.writes = PlaylistItemWrites::default();
}

#[cfg(test)]
mod tests {
    use super::{YoutubeToolSession, YoutubeUrl, WHISPER_MODEL_NAME};

    #[test]
    fn session_only_unlocks_the_exact_inventory_proven_absence() {
        let one = YoutubeUrl::new("https://youtu.be/abcdefghijk").unwrap();
        let two = YoutubeUrl::new("https://youtu.be/lmnopqrstuv").unwrap();
        let mut session = YoutubeToolSession::default();

        assert!(!session.can_transcribe(&one));
        session.mark_captions_absent(&one, super::VideoId::new("abcdefghijk").unwrap());

        assert!(session.can_transcribe(&one));
        assert!(!session.can_transcribe(&two));
        assert_eq!(session.whisper_model(), WHISPER_MODEL_NAME);
    }

    #[test]
    fn playlist_capture_authority_is_exact_and_selection_is_single_assignment() {
        let mut session = YoutubeToolSession::default();
        session
            .begin_playlist(vec!["iG9CE55wbtY".into(), "UF8uR6Z6KLc".into()])
            .unwrap();

        assert!(session
            .validate_playlist_capture_url(
                &YoutubeUrl::new("https://www.youtube.com/watch?v=iG9CE55wbtY").unwrap()
            )
            .is_ok());
        assert!(session
            .validate_playlist_capture_url(
                &YoutubeUrl::new("https://youtu.be/UF8uR6Z6KLc").unwrap()
            )
            .is_err());
        assert!(session
            .validate_playlist_capture_url(
                &YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap()
            )
            .is_err());
        assert!(session
            .validate_playlist_video_id(&super::VideoId::new("jNQXAC9IVRw").unwrap())
            .is_err());
        assert_eq!(session.playlist_current().unwrap().2, "iG9CE55wbtY");

        assert!(session.begin_playlist(vec!["jNQXAC9IVRw".into()]).is_err());
        assert_eq!(session.playlist_current().unwrap().2, "iG9CE55wbtY");
        assert!(session.playlist_summary().unwrap().is_empty());
    }
}
