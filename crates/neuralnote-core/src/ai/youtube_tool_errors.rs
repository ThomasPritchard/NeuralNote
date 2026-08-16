//! Bounded, model-safe projection of YouTube capture failures.

use crate::ai::tools::{ToolControl, ToolOutcome, ToolResult};
use crate::ai::youtube::YoutubeToolSession;
use crate::capture::{CaptureAction, CaptureError};
use serde_json::json;

const MAX_MODEL_ERROR_DETAIL_BYTES: usize = 512;

pub(super) fn settle_capture_error(error: CaptureError) -> ToolResult {
    let action = error.fallback_action();
    settle_with_action(error, action, &[])
}

pub(super) fn settle_session_capture_error(
    session: &mut YoutubeToolSession,
    error: CaptureError,
) -> ToolResult {
    session.observe_error(&error);
    let action = match error.fallback_action() {
        // The stateful retry helpers have already consumed or ruled out these
        // implementation-owned actions before projecting an error to the model.
        CaptureAction::UpdateExtractorAndRetry | CaptureAction::ContinueWithoutPot => {
            CaptureAction::Surface
        }
        action => action,
    };
    settle_with_action(error, action, session.annotations())
}

/// Which of the two stories a capture failure tells (#116).
///
/// Bucketing on the VARIANT rather than at each of the ~30 call sites is
/// deliberate: "that is not a YouTube URL" is a refusal whichever dispatcher
/// raised it, and "yt-dlp could not reach YouTube" is a failure whichever
/// dispatcher raised it. Classifying per site would duplicate one decision
/// thirty times and let the copies drift.
///
/// Exhaustive on purpose: a new `CaptureError` cannot reach a tool result until
/// it has been classified here.
fn capture_outcome(error: &CaptureError, message: String) -> ToolOutcome {
    match error {
        // NeuralNote declined the call the model made: the source is not a
        // supported URL, the request falls outside the confinement rules of the
        // playlist the user picked, a precondition for running at all is not
        // met, or the user called the whole thing off. Nothing was attempted
        // and nothing is broken.
        CaptureError::InvalidSource(_)
        | CaptureError::PlaylistInvalid(_)
        | CaptureError::RequirementMissing(_)
        | CaptureError::Cancelled(_) => ToolOutcome::Rejected,
        // Capture was attempted and came apart: the network, the extractor, the
        // audio pipeline, the vault profile, or data we fetched and could not
        // use. "Refused by NeuralNote" would be false for every one of these.
        CaptureError::MetadataUnavailable(_)
        | CaptureError::InvalidMetadata(_)
        | CaptureError::CaptionsAbsent(_)
        | CaptureError::YoutubeBlocked(_)
        | CaptureError::ExtractorStale(_)
        | CaptureError::PotUnavailable(_)
        | CaptureError::InvalidVtt(_)
        | CaptureError::ThumbnailRejected(_)
        | CaptureError::AudioUnavailable(_)
        | CaptureError::UnsupportedAudioCodec(_)
        | CaptureError::AudioDecodeFailed(_)
        | CaptureError::TranscriptionFailed(_)
        | CaptureError::ProfileInvalid(_) => ToolOutcome::Failed { message },
    }
}

fn settle_with_action(
    error: CaptureError,
    action: CaptureAction,
    annotations: &[String],
) -> ToolResult {
    let next_action = match action {
        CaptureAction::Surface => "surface",
        CaptureAction::Terminal => "terminal",
        CaptureAction::OfferWhisper => "offer_whisper",
        CaptureAction::UpdateExtractorAndRetry => "update_extractor_and_retry",
        CaptureAction::ContinueWithoutPot => "continue_without_pot",
    };
    let message = model_safe_error_detail(&error);
    let outcome = capture_outcome(&error, message.clone());
    ToolResult {
        content: json!({
            "error": {
                "kind": error.code(),
                "message": message,
                "next_action": next_action,
            },
            "annotations": annotations,
        })
        .to_string(),
        outcome,
        control: ToolControl::Continue,
    }
}

fn model_safe_error_detail(error: &CaptureError) -> String {
    let mut output = String::new();
    for token in error.detail().split_whitespace() {
        let safe = if looks_like_sensitive_location(token) {
            "[redacted location]"
        } else {
            token
        };
        let separator_len = usize::from(!output.is_empty());
        let remaining = MAX_MODEL_ERROR_DETAIL_BYTES
            .saturating_sub(output.len())
            .saturating_sub(separator_len);
        if remaining == 0 {
            break;
        }
        if !output.is_empty() {
            output.push(' ');
        }
        if safe.len() <= remaining {
            output.push_str(safe);
            continue;
        }
        let mut end = remaining;
        while !safe.is_char_boundary(end) {
            end -= 1;
        }
        output.push_str(&safe[..end]);
        break;
    }
    if output.is_empty() {
        error.code().replace('_', " ")
    } else {
        output
    }
}

fn looks_like_sensitive_location(token: &str) -> bool {
    let token = token.trim_start_matches(['\'', '"', '(', '[', '{']);
    let bytes = token.as_bytes();
    token.starts_with('/')
        || token.starts_with('\\')
        || token.starts_with("~/")
        || token.starts_with("http://")
        || token.starts_with("https://")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_confinement_refusal_is_never_reported_as_a_failure() {
        // The playlist spine, in the #116 vocabulary. A capture URL outside the
        // selection the user made, an unsupported source, an unmet precondition
        // and a cancelled run are all NeuralNote holding a line — never
        // breakage. They share this funnel with genuine capture failures, so
        // only the variant keeps them apart.
        for error in [
            CaptureError::InvalidSource("not a YouTube URL".into()),
            CaptureError::PlaylistInvalid("targets a video outside the selection".into()),
            CaptureError::RequirementMissing("call fetch_captions first".into()),
            CaptureError::Cancelled("the user stopped the run".into()),
        ] {
            assert_eq!(
                settle_capture_error(error.clone()).outcome,
                ToolOutcome::Rejected,
                "{error} must read as a refusal"
            );
        }
    }

    #[test]
    fn capture_that_was_attempted_and_came_apart_reads_as_a_failure() {
        // The other half. Every one of these means NeuralNote tried: it reached
        // YouTube, the extractor, the audio pipeline or the stored profile, and
        // could not finish. "Refused by NeuralNote" is false for all of them.
        for error in [
            CaptureError::MetadataUnavailable("yt-dlp exited 1".into()),
            CaptureError::YoutubeBlocked("Sign in to confirm you're not a bot".into()),
            CaptureError::ExtractorStale("unable to extract player response".into()),
            CaptureError::InvalidVtt("not webvtt".into()),
            CaptureError::TranscriptionFailed("whisper-cli crashed".into()),
            CaptureError::ProfileInvalid("stored profile is not valid json".into()),
        ] {
            assert!(
                matches!(
                    settle_capture_error(error.clone()).outcome,
                    ToolOutcome::Failed { .. }
                ),
                "{error} must read as a failure"
            );
        }
    }

    #[test]
    fn a_failure_carries_the_bounded_message_the_model_was_given() {
        // The message on `Failed` is what the orchestrator reports onward, so it
        // must be the REDACTED, bounded projection the model saw — never the raw
        // detail with a host path still in it.
        let result = settle_capture_error(CaptureError::MetadataUnavailable(
            "yt-dlp failed reading /Users/someone/Movies/clip.json".into(),
        ));

        let ToolOutcome::Failed { message } = &result.outcome else {
            panic!(
                "a capture failure must read as one, got {:?}",
                result.outcome
            );
        };
        assert!(message.contains("[redacted location]"), "{message}");
        assert!(!message.contains("/Users/someone"), "{message}");
    }
}
