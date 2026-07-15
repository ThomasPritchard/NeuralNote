//! Pure YouTube audio-coverage classification for the ffmpeg-fallback spike (#38).
//!
//! Given the audio renditions yt-dlp lists for a video, decide whether the
//! pure-Rust decoder in `capture::audio` can handle it today (AAC-LC in an m4a
//! container) or, if not, *why* — so the runnable coverage harness can measure
//! how often each undecodable class occurs against a written threshold before the
//! consented ffmpeg fallback (follow-up #59) is built.

use crate::capture::CaptureError;
use serde::Deserialize;

/// Upper bound on a single `yt-dlp --dump-single-json` payload. The `formats`
/// array dominates the size, so this is larger than the metadata-only limit.
pub const MAX_FORMAT_LISTING_BYTES: usize = 8 * 1024 * 1024;

/// The consented ffmpeg fallback is warranted when the combined undecodable rate
/// (no-m4a + HE-AAC + Opus) strictly exceeds this fraction of a representative sample.
pub const UNDECODABLE_COMBINED_THRESHOLD: f64 = 0.10;

/// ...or when any single undecodable class strictly exceeds this fraction on its own.
pub const SINGLE_CLASS_THRESHOLD: f64 = 0.05;

/// Fewest classified videos before a measurement counts as representative.
pub const MIN_REPRESENTATIVE_SAMPLE: usize = 50;

/// One audio rendition from a yt-dlp format listing, reduced to the fields that
/// decide decodability. `acodec` carries the codec profile (e.g. `mp4a.40.2`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioFormat {
    pub ext: String,
    pub acodec: String,
}

/// How a video's audio maps onto the pure-Rust decoder's capabilities.
///
/// The undecodable arms are the *reason* a video cannot be transcribed locally
/// today, chosen by priority so a video counts once in the class closest to
/// decodable: `HeAac` (right container, wrong profile) before `Opus`, and any
/// other missing-m4a case last. `Other` is a data-quality bucket — no audio
/// renditions were listed, or a runtime decode failed on a payload the listing
/// could not have flagged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioCoverage {
    /// Has an AAC-LC (`mp4a.40.2`) m4a rendition — decodable today.
    AacLcM4a,
    /// Best m4a rendition is HE-AAC (`mp4a.40.5` / `.29`), which the LC decoder rejects.
    HeAac,
    /// No usable m4a; audio is Opus (WebM/Ogg), which has no pure-Rust decoder.
    Opus,
    /// Audio exists but no m4a and no Opus rendition (e.g. Vorbis, or progressive-only).
    NoM4a,
    /// No audio renditions were listed, or a runtime decoder failure occurred.
    Other,
}

impl AudioCoverage {
    /// Stable snake-case label for reports and logs.
    pub const fn label(self) -> &'static str {
        match self {
            Self::AacLcM4a => "aac_lc_m4a",
            Self::HeAac => "he_aac",
            Self::Opus => "opus",
            Self::NoM4a => "no_m4a",
            Self::Other => "other",
        }
    }
}

/// Classify a video's audio coverage from its listed renditions.
pub fn classify_audio_coverage(formats: &[AudioFormat]) -> AudioCoverage {
    let mut has_audio = false;
    let mut has_he_aac = false;
    let mut has_opus = false;

    for format in formats {
        if !names_a_codec(&format.acodec) {
            continue;
        }
        has_audio = true;
        if is_aac_lc_m4a(format) {
            return AudioCoverage::AacLcM4a;
        }
        has_he_aac |= is_he_aac(&format.acodec);
        has_opus |= is_opus(&format.acodec);
    }

    if !has_audio {
        AudioCoverage::Other
    } else if has_he_aac {
        AudioCoverage::HeAac
    } else if has_opus {
        AudioCoverage::Opus
    } else {
        AudioCoverage::NoM4a
    }
}

/// Parse a `yt-dlp --dump-single-json` payload and classify its audio coverage.
pub fn classify_ytdlp_video_audio(bytes: &[u8]) -> Result<AudioCoverage, CaptureError> {
    Ok(classify_audio_coverage(&parse_ytdlp_formats(bytes)?))
}

/// Extract the audio-relevant fields from a `yt-dlp --dump-single-json` payload.
pub fn parse_ytdlp_formats(bytes: &[u8]) -> Result<Vec<AudioFormat>, CaptureError> {
    if bytes.len() > MAX_FORMAT_LISTING_BYTES {
        return Err(CaptureError::InvalidMetadata(
            "format listing exceeds the byte limit".into(),
        ));
    }
    let raw: RawFormatListing = serde_json::from_slice(bytes).map_err(|error| {
        CaptureError::InvalidMetadata(format!("format JSON is invalid: {error}"))
    })?;
    Ok(raw
        .formats
        .into_iter()
        .map(|format| AudioFormat {
            ext: format.ext.unwrap_or_default(),
            acodec: format.acodec.unwrap_or_default(),
        })
        .collect())
}

fn names_a_codec(acodec: &str) -> bool {
    !acodec.is_empty() && !acodec.eq_ignore_ascii_case("none")
}

fn is_aac_lc_m4a(format: &AudioFormat) -> bool {
    // Exact profile token, not a prefix: `mp4a.40.29` (HE-AACv2) shares the
    // `mp4a.40.2` prefix but is a different, undecodable profile.
    format.ext.eq_ignore_ascii_case("m4a") && format.acodec.eq_ignore_ascii_case("mp4a.40.2")
}

fn is_he_aac(acodec: &str) -> bool {
    acodec.eq_ignore_ascii_case("mp4a.40.5") || acodec.eq_ignore_ascii_case("mp4a.40.29")
}

fn is_opus(acodec: &str) -> bool {
    acodec.eq_ignore_ascii_case("opus")
}

#[derive(Deserialize)]
struct RawFormatListing {
    #[serde(default)]
    formats: Vec<RawFormat>,
}

#[derive(Deserialize)]
struct RawFormat {
    #[serde(default)]
    ext: Option<String>,
    #[serde(default)]
    acodec: Option<String>,
}

/// Running per-class counts over a coverage sample, plus the written threshold decision.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CoverageTally {
    aac_lc_m4a: usize,
    he_aac: usize,
    opus: usize,
    no_m4a: usize,
    other: usize,
}

impl CoverageTally {
    /// Add one classified video to the sample.
    pub fn record(&mut self, coverage: AudioCoverage) {
        match coverage {
            AudioCoverage::AacLcM4a => self.aac_lc_m4a += 1,
            AudioCoverage::HeAac => self.he_aac += 1,
            AudioCoverage::Opus => self.opus += 1,
            AudioCoverage::NoM4a => self.no_m4a += 1,
            AudioCoverage::Other => self.other += 1,
        }
    }

    /// Videos classified so far.
    pub fn total(&self) -> usize {
        self.aac_lc_m4a + self.he_aac + self.opus + self.no_m4a + self.other
    }

    /// Count recorded for one class.
    pub fn count(&self, coverage: AudioCoverage) -> usize {
        match coverage {
            AudioCoverage::AacLcM4a => self.aac_lc_m4a,
            AudioCoverage::HeAac => self.he_aac,
            AudioCoverage::Opus => self.opus,
            AudioCoverage::NoM4a => self.no_m4a,
            AudioCoverage::Other => self.other,
        }
    }

    /// Fraction of the sample in one class (0.0 for an empty sample).
    pub fn class_rate(&self, coverage: AudioCoverage) -> f64 {
        self.rate(self.count(coverage))
    }

    /// Fraction of the sample that lacks a decodable AAC-LC m4a for a codec reason.
    pub fn undecodable_rate(&self) -> f64 {
        self.rate(self.he_aac + self.opus + self.no_m4a)
    }

    /// Whether the sample is large enough to be treated as representative.
    pub fn is_representative(&self) -> bool {
        self.total() >= MIN_REPRESENTATIVE_SAMPLE
    }

    /// Apply the written threshold: fallback is warranted if the combined
    /// undecodable rate exceeds 10%, or any single undecodable class exceeds 5%.
    pub fn fallback_triggered(&self) -> bool {
        self.undecodable_rate() > UNDECODABLE_COMBINED_THRESHOLD
            || [
                AudioCoverage::HeAac,
                AudioCoverage::Opus,
                AudioCoverage::NoM4a,
            ]
            .into_iter()
            .any(|class| self.class_rate(class) > SINGLE_CLASS_THRESHOLD)
    }

    fn rate(&self, count: usize) -> f64 {
        let total = self.total();
        if total == 0 {
            0.0
        } else {
            count as f64 / total as f64
        }
    }
}

impl std::fmt::Display for CoverageTally {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(
            formatter,
            "YouTube audio-coverage report ({} videos)",
            self.total()
        )?;
        for class in [
            AudioCoverage::AacLcM4a,
            AudioCoverage::HeAac,
            AudioCoverage::Opus,
            AudioCoverage::NoM4a,
            AudioCoverage::Other,
        ] {
            writeln!(
                formatter,
                "  {:<11} {:>4}  ({:.1}%)",
                class.label(),
                self.count(class),
                self.class_rate(class) * 100.0
            )?;
        }
        writeln!(
            formatter,
            "  undecodable (no_m4a + he_aac + opus): {:.1}%",
            self.undecodable_rate() * 100.0
        )?;
        writeln!(
            formatter,
            "  representative (>= {} videos): {}",
            MIN_REPRESENTATIVE_SAMPLE,
            self.is_representative()
        )?;
        write!(
            formatter,
            "  ffmpeg fallback (#59) triggered by threshold: {}",
            self.fallback_triggered()
        )
    }
}

#[cfg(test)]
#[path = "audio_coverage_tests.rs"]
mod tests;
