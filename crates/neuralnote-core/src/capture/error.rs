//! Stable capture failures and the pure transcript fallback policy.

/// A surfaced failure from capture, parsing, routing, audio, or transcription.
///
/// Every variant carries bounded context from its caller. The stable snake-case
/// code is suitable for tool results and logs without exposing host internals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    InvalidSource(String),
    MetadataUnavailable(String),
    InvalidMetadata(String),
    CaptionsAbsent(String),
    YoutubeBlocked(String),
    ExtractorStale(String),
    PotUnavailable(String),
    InvalidVtt(String),
    PlaylistInvalid(String),
    ThumbnailRejected(String),
    AudioUnavailable(String),
    UnsupportedAudioCodec(String),
    AudioDecodeFailed(String),
    TranscriptionFailed(String),
    RequirementMissing(String),
    ProfileInvalid(String),
    Cancelled(String),
}

/// What core permits after a capture failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureAction {
    /// Stop and expose the failure through the normal tool-result path.
    Surface,
    /// Stop immediately because continuing risks escalating a YouTube block.
    Terminal,
    /// Offer local transcription. Only genuine caption absence earns this action.
    OfferWhisper,
    /// Update yt-dlp and retry the failed extractor operation once.
    UpdateExtractorAndRetry,
    /// Keep using yt-dlp without the optional POT sidecar and retain a warning.
    ContinueWithoutPot,
}

impl CaptureError {
    /// Stable machine-readable error code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidSource(_) => "invalid_source",
            Self::MetadataUnavailable(_) => "metadata_unavailable",
            Self::InvalidMetadata(_) => "invalid_metadata",
            Self::CaptionsAbsent(_) => "captions_absent",
            Self::YoutubeBlocked(_) => "youtube_blocked",
            Self::ExtractorStale(_) => "extractor_stale",
            Self::PotUnavailable(_) => "pot_unavailable",
            Self::InvalidVtt(_) => "invalid_vtt",
            Self::PlaylistInvalid(_) => "playlist_invalid",
            Self::ThumbnailRejected(_) => "thumbnail_rejected",
            Self::AudioUnavailable(_) => "audio_unavailable",
            Self::UnsupportedAudioCodec(_) => "unsupported_audio_codec",
            Self::AudioDecodeFailed(_) => "audio_decode_failed",
            Self::TranscriptionFailed(_) => "transcription_failed",
            Self::RequirementMissing(_) => "requirement_missing",
            Self::ProfileInvalid(_) => "profile_invalid",
            Self::Cancelled(_) => "cancelled",
        }
    }

    /// Human-readable context retained by this failure.
    pub fn detail(&self) -> &str {
        match self {
            Self::InvalidSource(detail)
            | Self::MetadataUnavailable(detail)
            | Self::InvalidMetadata(detail)
            | Self::CaptionsAbsent(detail)
            | Self::YoutubeBlocked(detail)
            | Self::ExtractorStale(detail)
            | Self::PotUnavailable(detail)
            | Self::InvalidVtt(detail)
            | Self::PlaylistInvalid(detail)
            | Self::ThumbnailRejected(detail)
            | Self::AudioUnavailable(detail)
            | Self::UnsupportedAudioCodec(detail)
            | Self::AudioDecodeFailed(detail)
            | Self::TranscriptionFailed(detail)
            | Self::RequirementMissing(detail)
            | Self::ProfileInvalid(detail)
            | Self::Cancelled(detail) => detail,
        }
    }

    /// Pure fallback classification. Retry cardinality is enforced separately by
    /// [`ExtractorUpdatePolicy`].
    pub fn fallback_action(&self) -> CaptureAction {
        match self {
            Self::CaptionsAbsent(_) => CaptureAction::OfferWhisper,
            Self::YoutubeBlocked(_) => CaptureAction::Terminal,
            Self::ExtractorStale(_) => CaptureAction::UpdateExtractorAndRetry,
            Self::PotUnavailable(_) => CaptureAction::ContinueWithoutPot,
            Self::InvalidSource(_)
            | Self::MetadataUnavailable(_)
            | Self::InvalidMetadata(_)
            | Self::InvalidVtt(_)
            | Self::PlaylistInvalid(_)
            | Self::ThumbnailRejected(_)
            | Self::AudioUnavailable(_)
            | Self::UnsupportedAudioCodec(_)
            | Self::AudioDecodeFailed(_)
            | Self::TranscriptionFailed(_)
            | Self::RequirementMissing(_)
            | Self::ProfileInvalid(_)
            | Self::Cancelled(_) => CaptureAction::Surface,
        }
    }
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code(), self.detail())
    }
}

impl std::error::Error for CaptureError {}

/// Session-scoped guard for yt-dlp's one update-and-retry allowance.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExtractorUpdatePolicy {
    update_attempted: bool,
}

impl ExtractorUpdatePolicy {
    /// Construct policy state, including the app-session case where an update was
    /// already attempted proactively before this operation failed.
    pub fn new(update_attempted: bool) -> Self {
        Self { update_attempted }
    }

    pub fn update_attempted(&self) -> bool {
        self.update_attempted
    }

    /// Decide the next action and atomically consume the one extractor update.
    pub fn decide(&mut self, error: &CaptureError) -> CaptureAction {
        let action = error.fallback_action();
        if action != CaptureAction::UpdateExtractorAndRetry {
            return action;
        }
        if self.update_attempted {
            CaptureAction::Surface
        } else {
            self.update_attempted = true;
            CaptureAction::UpdateExtractorAndRetry
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CaptureAction, CaptureError, ExtractorUpdatePolicy};

    fn error_cases() -> Vec<(CaptureError, &'static str)> {
        vec![
            (
                CaptureError::InvalidSource("bad URL".into()),
                "invalid_source",
            ),
            (
                CaptureError::MetadataUnavailable("yt-dlp failed".into()),
                "metadata_unavailable",
            ),
            (
                CaptureError::InvalidMetadata("missing title".into()),
                "invalid_metadata",
            ),
            (
                CaptureError::CaptionsAbsent("no caption tracks".into()),
                "captions_absent",
            ),
            (
                CaptureError::YoutubeBlocked("HTTP 403".into()),
                "youtube_blocked",
            ),
            (
                CaptureError::ExtractorStale("signature extraction failed".into()),
                "extractor_stale",
            ),
            (
                CaptureError::PotUnavailable("provider timed out".into()),
                "pot_unavailable",
            ),
            (CaptureError::InvalidVtt("bad cue".into()), "invalid_vtt"),
            (
                CaptureError::PlaylistInvalid("missing entries".into()),
                "playlist_invalid",
            ),
            (
                CaptureError::ThumbnailRejected("too large".into()),
                "thumbnail_rejected",
            ),
            (
                CaptureError::AudioUnavailable("no AAC-LC format".into()),
                "audio_unavailable",
            ),
            (
                CaptureError::UnsupportedAudioCodec("mp4a.40.5".into()),
                "unsupported_audio_codec",
            ),
            (
                CaptureError::AudioDecodeFailed("invalid sample".into()),
                "audio_decode_failed",
            ),
            (
                CaptureError::TranscriptionFailed("whisper exit 1".into()),
                "transcription_failed",
            ),
            (
                CaptureError::RequirementMissing("whisper model".into()),
                "requirement_missing",
            ),
            (
                CaptureError::ProfileInvalid("absolute route".into()),
                "profile_invalid",
            ),
            (
                CaptureError::Cancelled("user cancelled".into()),
                "cancelled",
            ),
        ]
    }

    #[test]
    fn taxonomy_has_stable_snake_case_codes_and_visible_details() {
        for (error, expected_code) in error_cases() {
            assert_eq!(error.code(), expected_code);
            assert!(error.to_string().contains(expected_code));
            assert!(error.to_string().contains(error.detail()));
        }
    }

    #[test]
    fn fallback_policy_only_offers_whisper_for_genuine_caption_absence() {
        for (error, _) in error_cases() {
            let action = error.fallback_action();
            if matches!(error, CaptureError::CaptionsAbsent(_)) {
                assert_eq!(action, CaptureAction::OfferWhisper);
            } else {
                assert_ne!(action, CaptureAction::OfferWhisper, "{error}");
            }
        }
    }

    #[test]
    fn blocked_failures_are_terminal_and_pot_failure_is_non_fatal() {
        assert_eq!(
            CaptureError::YoutubeBlocked("bot check".into()).fallback_action(),
            CaptureAction::Terminal
        );
        assert_eq!(
            CaptureError::PotUnavailable("sidecar down".into()).fallback_action(),
            CaptureAction::ContinueWithoutPot
        );
    }

    #[test]
    fn extractor_staleness_requests_one_update_and_retry_only() {
        let error = CaptureError::ExtractorStale("signature extraction failed".into());
        let mut policy = ExtractorUpdatePolicy::default();

        assert_eq!(
            policy.decide(&error),
            CaptureAction::UpdateExtractorAndRetry
        );
        assert!(policy.update_attempted());
        assert_eq!(policy.decide(&error), CaptureAction::Surface);
    }

    #[test]
    fn session_that_already_updated_never_requests_a_second_update() {
        let error = CaptureError::ExtractorStale("nsig extraction failed".into());
        let mut policy = ExtractorUpdatePolicy::new(true);

        assert_eq!(policy.decide(&error), CaptureAction::Surface);
        assert!(policy.update_attempted());
    }

    #[test]
    fn update_policy_delegates_non_extractor_errors_without_consuming_retry() {
        let mut policy = ExtractorUpdatePolicy::default();

        assert_eq!(
            policy.decide(&CaptureError::CaptionsAbsent("empty inventories".into())),
            CaptureAction::OfferWhisper
        );
        assert!(!policy.update_attempted());
    }
}
