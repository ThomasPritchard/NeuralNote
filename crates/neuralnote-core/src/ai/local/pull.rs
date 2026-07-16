//! Ollama `/api/pull` NDJSON parsing.
//!
//! The HTTP status has already succeeded by the time these frames arrive, so
//! in-band `error` fields must surface distinctly while malformed noise is skipped.

use std::collections::BTreeMap;

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

/// Parse one Ollama `/api/pull` NDJSON frame into a [`PullEvent`], with a *per-frame*
/// (per-digest) `percent`. For an aggregate, cross-digest percentage that survives the
/// stream moving between layers, drive frames through [`PullProgress`] instead — the
/// streaming layer should ingest via that reducer rather than calling this directly.
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

/// Per-digest byte tally. A digest contributes to the overall ratio only once its
/// `total` is known (`> 0`); until then its bytes are held but excluded from the
/// denominator, so a not-yet-sized layer can't distort the percentage.
#[derive(Debug, Default)]
struct DigestBytes {
    completed: u64,
    total: u64,
}

/// Reduces a stream of Ollama pull frames into one bounded, monotonic overall
/// download percentage.
///
/// Ollama reports progress *per digest* (per layer), so any single frame's `percent`
/// resets to ~0 when the stream advances to the next layer — which is why the
/// per-frame [`parse_pull_line`] alone can't drive an aggregate bar. This reducer sums
/// `completed`/`total` bytes across every digest seen so far, so the reported percent
/// reflects the whole download and never resets between layers.
///
/// Guarantees, and the frame hazards they defend against:
/// - **Bounded** to `0..=100`: a digest that over-reports `completed` beyond its own
///   `total` is capped at its total before summing.
/// - **Monotonic** (never decreases): Ollama announces layers as it reaches them, so
///   the denominator grows mid-stream; a high-water floor holds the bar steady rather
///   than letting it jump backward when a new layer's bytes enter. (Trade-off: the
///   first layer can briefly plateau the bar until later layers catch up — monotonicity
///   is prioritised over instantaneous accuracy, per the download-UX requirement.)
/// - **Repeated / out-of-order frames**: `completed` and `total` are the maximum ever
///   seen for a digest, so a stale or duplicated frame can't regress or double-count it.
/// - **Late / changing totals**: a frame with no `total` is held out of the denominator
///   until a `total` arrives; a later, larger `total` is adopted (max wins) without
///   letting the percent jump backward.
///
/// Terminal (`Success`/`Error`) and malformed frames pass through untouched, so the
/// streaming layer's success, error, and cancellation handling is unaffected.
#[derive(Debug, Default)]
pub struct PullProgress {
    digests: BTreeMap<String, DigestBytes>,
    high_water: u8,
}

impl PullProgress {
    /// Parse one NDJSON frame and, for a progress frame, fold it into the running
    /// tally — returning the frame with its `percent` set to the overall download
    /// percentage. A drop-in replacement for [`parse_pull_line`] in the streaming loop.
    pub fn ingest(&mut self, line: &str) -> Option<PullEvent> {
        let event = parse_pull_line(line)?;
        let PullEvent::Progress {
            status,
            digest,
            completed,
            total,
            ..
        } = event
        else {
            // Success / Error are terminal — pass them through so the caller's terminal
            // and cancellation handling is preserved exactly.
            return Some(event);
        };

        if let Some(digest) = digest.as_deref() {
            self.record(digest, completed, total);
        }

        Some(PullEvent::Progress {
            status,
            digest,
            completed,
            total,
            percent: self.overall_percent(),
        })
    }

    /// Fold one digest's latest byte counts into the tally. Both fields are kept as the
    /// maximum ever seen so a stale, repeated, or out-of-order frame can't regress a
    /// layer; a zero/absent total leaves the digest sized-unknown (excluded below).
    fn record(&mut self, digest: &str, completed: Option<u64>, total: Option<u64>) {
        let entry = self.digests.entry(digest.to_owned()).or_default();
        if let Some(completed) = completed {
            entry.completed = entry.completed.max(completed);
        }
        if let Some(total) = total.filter(|&t| t > 0) {
            entry.total = entry.total.max(total);
        }
    }

    /// The overall percentage across every sized digest, clamped to `0..=100` and
    /// floored at the running high-water mark so it never regresses. `None` until at
    /// least one digest has a known total.
    fn overall_percent(&mut self) -> Option<u8> {
        let (done, total) = self.digests.values().filter(|bytes| bytes.total > 0).fold(
            (0u64, 0u64),
            |(done, total), bytes| {
                (
                    done.saturating_add(bytes.completed.min(bytes.total)),
                    total.saturating_add(bytes.total),
                )
            },
        );
        if total == 0 {
            return None;
        }
        let raw = (done.saturating_mul(100) / total).min(100) as u8;
        self.high_water = self.high_water.max(raw);
        Some(self.high_water)
    }
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

    fn percent(event: Option<PullEvent>) -> Option<u8> {
        match event {
            Some(PullEvent::Progress { percent, .. }) => percent,
            other => panic!("expected a progress event, got {other:?}"),
        }
    }

    #[test]
    fn aggregates_completed_bytes_across_all_known_digests() {
        // Both layer totals are known up front, so a single layer completing is only
        // *half* the overall download — the per-frame parser would misreport it as 100.
        let mut progress = PullProgress::default();

        assert_eq!(
            percent(
                progress
                    .ingest(r#"{"status":"downloading","digest":"a","total":100,"completed":0}"#)
            ),
            Some(0)
        );
        assert_eq!(
            percent(
                progress
                    .ingest(r#"{"status":"downloading","digest":"b","total":100,"completed":0}"#)
            ),
            Some(0)
        );
        assert_eq!(
            percent(
                progress
                    .ingest(r#"{"status":"downloading","digest":"a","total":100,"completed":100}"#)
            ),
            Some(50)
        );
        assert_eq!(
            percent(
                progress
                    .ingest(r#"{"status":"downloading","digest":"b","total":100,"completed":100}"#)
            ),
            Some(100)
        );
    }

    #[test]
    fn overall_percent_never_decreases_when_a_new_digest_appears_mid_stream() {
        // Ollama announces layers as it reaches them: the first layer can reach 100%
        // before the next layer's bytes enter the denominator. The bar must hold, not
        // jump backward.
        let mut progress = PullProgress::default();
        let seen = [
            r#"{"status":"downloading","digest":"a","total":100,"completed":100}"#,
            r#"{"status":"downloading","digest":"b","total":100,"completed":0}"#,
            r#"{"status":"downloading","digest":"b","total":100,"completed":50}"#,
        ]
        .into_iter()
        .map(|line| percent(progress.ingest(line)).unwrap())
        .collect::<Vec<_>>();

        assert!(
            seen.windows(2).all(|w| w[1] >= w[0]),
            "percent regressed across a new digest: {seen:?}"
        );
    }

    #[test]
    fn a_late_total_pulls_its_digest_into_the_denominator() {
        // A layer whose `total` has not yet arrived is held out of the ratio; once the
        // total appears, its bytes count toward the whole download.
        let mut progress = PullProgress::default();

        assert_eq!(
            percent(
                progress.ingest(
                    r#"{"status":"downloading","digest":"a","total":1000,"completed":500}"#
                )
            ),
            Some(50)
        );
        // `b` has bytes but no total yet — excluded, so the ratio is still `a` alone.
        assert_eq!(
            percent(progress.ingest(r#"{"status":"downloading","digest":"b","completed":0}"#)),
            Some(50)
        );
        // `b`'s total arrives late: the denominator doubles to 2000.
        assert_eq!(
            percent(
                progress
                    .ingest(r#"{"status":"downloading","digest":"b","total":1000,"completed":0}"#)
            ),
            Some(50)
        );
        // `a` finishing is now only 1000/2000 = 50% overall — proof `b`'s late total is
        // in the denominator (it would read 100 if `b` were still excluded).
        assert_eq!(
            percent(
                progress.ingest(
                    r#"{"status":"downloading","digest":"a","total":1000,"completed":1000}"#
                )
            ),
            Some(50)
        );
    }

    #[test]
    fn stale_and_repeated_frames_do_not_regress_or_double_count_a_digest() {
        let mut progress = PullProgress::default();

        assert_eq!(
            percent(
                progress.ingest(
                    r#"{"status":"downloading","digest":"a","total":1000,"completed":800}"#
                )
            ),
            Some(80)
        );
        // An out-of-order frame reporting fewer bytes must not drag the layer backward.
        assert_eq!(
            percent(
                progress.ingest(
                    r#"{"status":"downloading","digest":"a","total":1000,"completed":200}"#
                )
            ),
            Some(80)
        );
        // A duplicated frame must not double-count.
        assert_eq!(
            percent(
                progress.ingest(
                    r#"{"status":"downloading","digest":"a","total":1000,"completed":800}"#
                )
            ),
            Some(80)
        );
    }

    #[test]
    fn a_changing_total_adopts_the_larger_without_jumping_backward() {
        let mut progress = PullProgress::default();

        assert_eq!(
            percent(
                progress.ingest(
                    r#"{"status":"downloading","digest":"a","total":1000,"completed":300}"#
                )
            ),
            Some(30)
        );
        // A smaller total is ignored (max wins): denominator stays 1000, so 400/1000.
        assert_eq!(
            percent(
                progress
                    .ingest(r#"{"status":"downloading","digest":"a","total":800,"completed":400}"#)
            ),
            Some(40)
        );
        // A larger total is adopted (denominator grows to 2000), but the displayed
        // percent holds at its high-water rather than dropping to 400/2000 = 20.
        assert_eq!(
            percent(
                progress.ingest(
                    r#"{"status":"downloading","digest":"a","total":2000,"completed":400}"#
                )
            ),
            Some(40)
        );
    }

    #[test]
    fn overall_percent_is_bounded_when_a_digest_overshoots_its_total() {
        // A layer reporting more bytes than its own total must not push the aggregate
        // beyond 100.
        let mut progress = PullProgress::default();
        progress.ingest(r#"{"status":"downloading","digest":"a","total":100,"completed":150}"#);
        assert_eq!(
            percent(
                progress
                    .ingest(r#"{"status":"downloading","digest":"b","total":100,"completed":150}"#)
            ),
            Some(100)
        );
    }

    #[test]
    fn status_only_frames_report_the_running_high_water_not_a_reset() {
        let mut progress = PullProgress::default();

        // Before any sized layer, there is no denominator — the manifest phase is None,
        // matching the per-frame parser.
        assert_eq!(
            percent(progress.ingest(r#"{"status":"pulling manifest"}"#)),
            None
        );
        assert_eq!(
            percent(
                progress.ingest(
                    r#"{"status":"downloading","digest":"a","total":1000,"completed":600}"#
                )
            ),
            Some(60)
        );
        // The trailing verify/write phases carry no bytes; they must surface the
        // running percent, not blank the bar back to nothing.
        assert_eq!(
            percent(progress.ingest(r#"{"status":"verifying sha256 digest"}"#)),
            Some(60)
        );
    }

    #[test]
    fn terminal_and_malformed_frames_pass_through_the_reducer_unchanged() {
        let mut progress = PullProgress::default();

        assert_eq!(
            progress.ingest(r#"{"status":"success"}"#),
            Some(PullEvent::Success)
        );
        assert_eq!(
            progress.ingest(r#"{"error":"boom"}"#),
            Some(PullEvent::Error {
                message: "boom".into()
            })
        );
        assert_eq!(progress.ingest(""), None);
        assert_eq!(progress.ingest("{not json"), None);
        assert_eq!(progress.ingest(r#"{"foo":1}"#), None);
    }

}
