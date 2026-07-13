//! Bounded, model-safe projection of YouTube capture failures.

use crate::ai::tools::{ToolControl, ToolOutcome, ToolResult};
use crate::ai::youtube::YoutubeToolSession;
use crate::capture::{CaptureAction, CaptureError};
use serde_json::json;

const MAX_MODEL_ERROR_DETAIL_BYTES: usize = 512;

pub(super) fn capture_reject(error: CaptureError) -> ToolResult {
    let action = error.fallback_action();
    capture_reject_with_action(error, action, &[])
}

pub(super) fn session_capture_reject(
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
    capture_reject_with_action(error, action, session.annotations())
}

fn capture_reject_with_action(
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
        outcome: ToolOutcome::Rejected,
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
