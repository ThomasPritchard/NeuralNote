//! Ollama `/api/pull` NDJSON parsing.
//!
//! The HTTP status has already succeeded by the time these frames arrive, so
//! in-band `error` fields must surface distinctly while malformed noise is skipped.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum PullEvent {
    Progress {
        status: String,
        digest: Option<String>,
        completed: Option<u64>,
        total: Option<u64>,
        percent: Option<u8>,
    },
    Success,
    Error {
        message: String,
    },
}

/// A sink for streamed download progress. `Send` (like [`EventSink`]) so the host
/// can drive a pull from its async worker pool and the future stays `Send`.
///
/// [`EventSink`]: crate::ai::events::EventSink
pub trait PullSink: Send {
    fn send(&mut self, e: PullEvent);
}

#[derive(Deserialize)]
struct RawPullLine {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    completed: Option<u64>,
    #[serde(default)]
    total: Option<u64>,
}

// TODO(pull-progress): Cross-digest overall percent needs per-digest byte accounting; defer the reducer to the streaming phase.
pub fn parse_pull_line(line: &str) -> Option<PullEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let raw: RawPullLine = serde_json::from_str(line).ok()?;
    if let Some(message) = raw.error.filter(|e| !e.is_empty()) {
        return Some(PullEvent::Error { message });
    }

    let status = raw.status?;
    if status == "success" {
        return Some(PullEvent::Success);
    }

    let percent = match (raw.completed, raw.total) {
        (Some(c), Some(t)) if t > 0 => Some(((c.saturating_mul(100)) / t).min(100) as u8),
        _ => None,
    };
    Some(PullEvent::Progress {
        status,
        digest: raw.digest,
        completed: raw.completed,
        total: raw.total,
        percent,
    })
}

#[cfg(test)]
#[derive(Debug, Default)]
pub struct VecSink {
    pub events: Vec<PullEvent>,
}

#[cfg(test)]
impl PullSink for VecSink {
    fn send(&mut self, e: PullEvent) {
        self.events.push(e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(line: &str) -> PullEvent {
        parse_pull_line(line).unwrap()
    }

    fn json(event: &PullEvent) -> serde_json::Value {
        serde_json::to_value(event).unwrap()
    }

    #[test]
    fn parses_status_only_progress() {
        assert_eq!(
            event(r#"{"status":"pulling manifest"}"#),
            PullEvent::Progress {
                status: "pulling manifest".into(),
                digest: None,
                completed: None,
                total: None,
                percent: None,
            }
        );
    }

    #[test]
    fn parses_digest_progress_with_zero_percent() {
        assert_eq!(
            event(
                r#"{"status":"pulling sha256:x","digest":"sha256:x","total":2142590208,"completed":241970}"#
            ),
            PullEvent::Progress {
                status: "pulling sha256:x".into(),
                digest: Some("sha256:x".into()),
                completed: Some(241970),
                total: Some(2_142_590_208),
                percent: Some(0),
            }
        );
    }

    #[test]
    fn computes_round_progress_percent() {
        assert!(matches!(
            event(r#"{"status":"downloading","total":1000,"completed":500}"#),
            PullEvent::Progress {
                percent: Some(50),
                ..
            }
        ));
    }

    #[test]
    fn omits_percent_when_total_is_zero_or_absent() {
        assert!(matches!(
            event(r#"{"status":"x","total":0,"completed":10}"#),
            PullEvent::Progress { percent: None, .. }
        ));
        assert!(matches!(
            event(r#"{"status":"x","completed":10}"#),
            PullEvent::Progress { percent: None, .. }
        ));
    }

    #[test]
    fn clamps_percent_at_one_hundred() {
        assert!(matches!(
            event(r#"{"status":"x","total":100,"completed":150}"#),
            PullEvent::Progress {
                percent: Some(100),
                ..
            }
        ));
    }

    #[test]
    fn parses_success_and_error_frames() {
        assert_eq!(event(r#"{"status":"success"}"#), PullEvent::Success);
        assert_eq!(
            event(r#"{"error":"pull model manifest: file does not exist"}"#),
            PullEvent::Error {
                message: "pull model manifest: file does not exist".into()
            }
        );
        assert_eq!(
            event(r#"{"status":"pulling","error":"boom"}"#),
            PullEvent::Error {
                message: "boom".into()
            }
        );
    }

    #[test]
    fn skips_empty_malformed_and_statusless_lines() {
        assert_eq!(parse_pull_line(""), None);
        assert_eq!(parse_pull_line("{not json"), None);
        assert_eq!(parse_pull_line(r#"{"foo":1}"#), None);
    }

    #[test]
    fn serde_tags_pull_events() {
        let progress = json(&PullEvent::Progress {
            status: "downloading".into(),
            digest: Some("sha256:x".into()),
            completed: Some(5),
            total: Some(10),
            percent: Some(50),
        });
        assert_eq!(progress["type"], "progress");
        assert_eq!(progress["completed"], 5);

        assert_eq!(json(&PullEvent::Success)["type"], "success");

        let error = json(&PullEvent::Error {
            message: "boom".into(),
        });
        assert_eq!(error["type"], "error");
        assert_eq!(error["message"], "boom");
    }

    #[test]
    fn vec_sink_collects_events_in_order() {
        let mut sink = VecSink::default();

        sink.send(PullEvent::Progress {
            status: "pulling manifest".into(),
            digest: None,
            completed: None,
            total: None,
            percent: None,
        });
        sink.send(PullEvent::Success);

        assert_eq!(
            sink.events,
            vec![
                PullEvent::Progress {
                    status: "pulling manifest".into(),
                    digest: None,
                    completed: None,
                    total: None,
                    percent: None,
                },
                PullEvent::Success
            ]
        );
    }
}
