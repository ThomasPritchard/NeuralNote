//! Bounded parsing and pure strategy for untrusted yt-dlp output.

use crate::capture::youtube_ids::valid_video_id;
pub use crate::capture::youtube_ids::{VideoId, YoutubeUrl};
use crate::capture::CaptureError;
use chrono::NaiveDate;
use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

pub const MAX_METADATA_JSON_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PLAYLIST_JSON_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PLAYLIST_ENTRIES: usize = 2_000;
/// Upper bound for the spec-pinned `mqdefault.jpg` thumbnail.
pub const MAX_THUMBNAIL_BYTES: usize = 256 * 1_024;
const MAX_THUMBNAIL_DIMENSION: u32 = 1_024;
const MAX_THUMBNAIL_PIXELS: u64 = 1_024 * 1_024;

const MAX_CLASSIFIER_BYTES: usize = 64 * 1024;
const MAX_TITLE_BYTES: usize = 500;
const MAX_CHANNEL_BYTES: usize = 300;
const MAX_LANGUAGE_COUNT: usize = 512;
const MAX_TRACKS_PER_LANGUAGE: usize = 32;
const MAX_DURATION_SECONDS: f64 = 31.0 * 24.0 * 60.0 * 60.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptionSource {
    Human,
    Automatic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CaptionSelection {
    pub language: String,
    pub source: CaptionSource,
}

/// Validate untrusted thumbnail bytes before either a client boundary or the
/// playlist data-URI renderer accepts them.
pub fn validate_thumbnail(media_type: &str, bytes: &[u8]) -> Result<(), CaptureError> {
    let expected_format = match media_type {
        "image/jpeg" => ImageFormat::Jpeg,
        "image/png" => ImageFormat::Png,
        "image/webp" => ImageFormat::WebP,
        _ => return Err(thumbnail_rejected()),
    };
    if bytes.is_empty() || bytes.len() > MAX_THUMBNAIL_BYTES {
        return Err(thumbnail_rejected());
    }
    if expected_format == ImageFormat::WebP && !webp_container_length_matches(bytes) {
        return Err(thumbnail_rejected());
    }

    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| thumbnail_rejected())?;
    if reader.format() != Some(expected_format) {
        return Err(thumbnail_rejected());
    }
    let (width, height) = reader.into_dimensions().map_err(|_| thumbnail_rejected())?;
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(thumbnail_rejected)?;
    if width == 0
        || height == 0
        || width > MAX_THUMBNAIL_DIMENSION
        || height > MAX_THUMBNAIL_DIMENSION
        || pixels > MAX_THUMBNAIL_PIXELS
    {
        return Err(thumbnail_rejected());
    }

    ImageReader::with_format(Cursor::new(bytes), expected_format)
        .decode()
        .map_err(|_| thumbnail_rejected())?;
    Ok(())
}

fn webp_container_length_matches(bytes: &[u8]) -> bool {
    bytes
        .get(4..8)
        .and_then(|value| value.try_into().ok())
        .map(u32::from_le_bytes)
        .and_then(|payload_len| usize::try_from(payload_len).ok())
        .and_then(|payload_len| payload_len.checked_add(8))
        == Some(bytes.len())
}

fn thumbnail_rejected() -> CaptureError {
    CaptureError::ThumbnailRejected(
        "thumbnail is empty, oversized, undecodable, or does not match an allowed image type"
            .into(),
    )
}

/// Validate the exact external-navigation shape emitted by transcript rendering.
/// Returning the original canonical string lets the shell open only this narrow
/// URL grammar, never a model- or webview-authored arbitrary target.
pub fn validate_youtube_timestamp_url(value: &str) -> Result<String, CaptureError> {
    const PREFIX: &str = "https://youtu.be/";
    let rest = value.strip_prefix(PREFIX).ok_or_else(|| {
        CaptureError::InvalidSource("YouTube timestamp URL must use https://youtu.be".into())
    })?;
    let (video_id, seconds) = rest.split_once("?t=").ok_or_else(|| {
        CaptureError::InvalidSource("YouTube timestamp URL is missing its time query".into())
    })?;
    VideoId::new(video_id)?;
    if seconds.is_empty()
        || seconds.len() > 10
        || !seconds.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(CaptureError::InvalidSource(
            "YouTube timestamp must be a bounded decimal number".into(),
        ));
    }
    let parsed = seconds.parse::<u32>().map_err(|_| {
        CaptureError::InvalidSource("YouTube timestamp exceeds the supported range".into())
    })?;
    if parsed.to_string() != seconds {
        return Err(CaptureError::InvalidSource(
            "YouTube timestamp URL is not canonical".into(),
        ));
    }
    Ok(value.to_string())
}

impl CaptionSelection {
    pub fn provenance(&self) -> String {
        match self.source {
            CaptionSource::Human => format!("captions:{}", self.language),
            CaptionSource::Automatic => format!("captions:{}-auto", self.language),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CaptionInventory {
    human: Vec<String>,
    automatic: Vec<String>,
}

impl CaptionInventory {
    pub fn human_languages(&self) -> &[String] {
        &self.human
    }

    pub fn automatic_languages(&self) -> &[String] {
        &self.automatic
    }

    pub fn is_genuinely_absent(&self) -> bool {
        self.human.is_empty() && self.automatic.is_empty()
    }

    /// Prefer the human inventory globally, then exact language and base variant.
    pub fn select(&self, requested: &str) -> Option<CaptionSelection> {
        select_language(&self.human, requested)
            .map(|language| CaptionSelection {
                language,
                source: CaptionSource::Human,
            })
            .or_else(|| {
                select_language(&self.automatic, requested).map(|language| CaptionSelection {
                    language,
                    source: CaptionSource::Automatic,
                })
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VideoMetadata {
    pub video_id: String,
    pub title: String,
    pub channel: Option<String>,
    pub duration_seconds: Option<u64>,
    pub upload_date: Option<String>,
    pub canonical_url: String,
    pub captions: CaptionInventory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlaylistEntry {
    pub video_id: String,
    pub title: String,
    pub duration_seconds: Option<u64>,
    pub canonical_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Playlist {
    pub playlist_id: String,
    pub title: String,
    pub entries: Vec<PlaylistEntry>,
    pub unavailable_entries_skipped: usize,
}

#[derive(Deserialize)]
struct RawVideoMetadata {
    id: String,
    title: String,
    #[serde(default)]
    uploader: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    upload_date: Option<String>,
    subtitles: Option<BTreeMap<String, Vec<RawCaptionTrack>>>,
    automatic_captions: Option<BTreeMap<String, Vec<RawCaptionTrack>>>,
}

#[derive(Deserialize)]
struct RawCaptionTrack {
    ext: String,
}

#[derive(Deserialize)]
struct RawPlaylist {
    #[serde(rename = "_type")]
    kind: String,
    id: String,
    title: String,
    entries: Vec<Option<RawPlaylistEntry>>,
}

#[derive(Deserialize)]
struct RawPlaylistEntry {
    id: String,
    title: String,
    #[serde(default)]
    duration: Option<f64>,
}

pub fn parse_video_metadata(bytes: &[u8]) -> Result<VideoMetadata, CaptureError> {
    if bytes.len() > MAX_METADATA_JSON_BYTES {
        return Err(invalid_metadata("metadata exceeds the byte limit"));
    }
    let raw: RawVideoMetadata = serde_json::from_slice(bytes)
        .map_err(|error| invalid_metadata(format!("metadata JSON is invalid: {error}")))?;
    if !valid_video_id(&raw.id) {
        return Err(invalid_metadata("video id must be 11 URL-safe characters"));
    }
    let subtitles = raw
        .subtitles
        .ok_or_else(|| invalid_metadata("caption inventories missing; absence not proven"))?;
    let automatic_captions = raw
        .automatic_captions
        .ok_or_else(|| invalid_metadata("caption inventories missing; absence not proven"))?;
    let title = bounded_text(raw.title, "title", MAX_TITLE_BYTES).map_err(invalid_metadata)?;
    let channel = raw
        .uploader
        .or(raw.channel)
        .map(|value| bounded_text(value, "channel", MAX_CHANNEL_BYTES))
        .transpose()
        .map_err(invalid_metadata)?;
    let duration_seconds = checked_duration(raw.duration).map_err(invalid_metadata)?;
    let upload_date = raw
        .upload_date
        .map(validate_upload_date)
        .transpose()
        .map_err(invalid_metadata)?;
    let captions = CaptionInventory {
        human: inventory_languages(subtitles).map_err(invalid_metadata)?,
        automatic: inventory_languages(automatic_captions).map_err(invalid_metadata)?,
    };
    Ok(VideoMetadata {
        canonical_url: canonical_video_url(&raw.id),
        video_id: raw.id,
        title,
        channel,
        duration_seconds,
        upload_date,
        captions,
    })
}

pub fn parse_playlist(bytes: &[u8]) -> Result<Playlist, CaptureError> {
    if bytes.len() > MAX_PLAYLIST_JSON_BYTES {
        return Err(playlist_invalid("playlist exceeds the byte limit"));
    }
    let raw: RawPlaylist = serde_json::from_slice(bytes)
        .map_err(|error| playlist_invalid(format!("playlist JSON is invalid: {error}")))?;
    if raw.kind != "playlist" {
        return Err(playlist_invalid("yt-dlp result is not a playlist"));
    }
    if raw.entries.is_empty() {
        return Err(playlist_invalid("playlist contains no entries"));
    }
    if raw.entries.len() > MAX_PLAYLIST_ENTRIES {
        return Err(playlist_invalid("playlist exceeds the entry limit"));
    }
    let playlist_id = bounded_identifier(raw.id, "playlist id", 128).map_err(playlist_invalid)?;
    let title =
        bounded_text(raw.title, "playlist title", MAX_TITLE_BYTES).map_err(playlist_invalid)?;
    let mut seen = BTreeSet::new();
    let mut entries = Vec::with_capacity(raw.entries.len());
    let mut unavailable_entries_skipped = 0;
    for raw_entry in raw.entries {
        let Some(raw_entry) = raw_entry else {
            unavailable_entries_skipped += 1;
            continue;
        };
        if !valid_video_id(&raw_entry.id) {
            return Err(playlist_invalid("playlist entry has an invalid video id"));
        }
        let entry_title = bounded_text(raw_entry.title, "playlist entry title", MAX_TITLE_BYTES)
            .map_err(playlist_invalid)?;
        let duration_seconds = checked_duration(raw_entry.duration).map_err(playlist_invalid)?;
        if seen.insert(raw_entry.id.clone()) {
            entries.push(PlaylistEntry {
                canonical_url: canonical_video_url(&raw_entry.id),
                video_id: raw_entry.id,
                title: entry_title,
                duration_seconds,
            });
        }
    }
    if entries.is_empty() {
        return Err(playlist_invalid(format!(
            "playlist contains no available entries; skipped {unavailable_entries_skipped} unavailable playlist entries"
        )));
    }
    Ok(Playlist {
        playlist_id,
        title,
        entries,
        unavailable_entries_skipped,
    })
}

/// Classify bounded yt-dlp diagnostics. Genuine caption absence is deliberately
/// absent here because only the two parsed metadata inventories can prove it.
/// Block markers deliberately scan the full output so a terminal signal cannot
/// be hidden in the middle of diagnostics truncated for non-terminal classes.
pub fn classify_ytdlp_failure(output: &str) -> CaptureError {
    let blocked = [
        "http error 403",
        "http 403",
        "403 forbidden",
        "http error 429",
        "http 429",
        "429 too many requests",
        "rate-limited",
        "rate limit exceeded",
        "sign in to confirm you're not a bot",
        "subtitles require a po token which was not provided",
        "subtitles languages because a po token was not provided",
    ];
    if blocked
        .iter()
        .any(|needle| contains_ascii_case_insensitive(output, needle))
    {
        return CaptureError::YoutubeBlocked(
            "YouTube blocked or rate-limited the extractor request with a 403, 429, PO-token requirement, or bot check".into(),
        );
    }
    let inspected = bounded_classifier_view(output).to_ascii_lowercase();
    let pot_failed = inspected.lines().any(|line| {
        if line.contains("rustypipe_botguard") {
            return true;
        }
        let names_provider = line.contains("[pot:bgutil")
            || line.contains("po token provider")
            || line.contains("bgutil-pot");
        let names_failure = ["error", "failed", "timeout", "unavailable", "no such file"]
            .iter()
            .any(|needle| line.contains(needle));
        names_provider && names_failure
    });
    if pot_failed {
        return CaptureError::PotUnavailable(
            "the optional POT sidecar or provider was unavailable".into(),
        );
    }
    let stale = [
        "nsig extraction failed",
        "signature extraction failed",
        "unable to extract",
        "extractor error",
    ];
    if stale.iter().any(|needle| inspected.contains(needle)) {
        CaptureError::ExtractorStale(
            "yt-dlp's YouTube extractor appears stale; core permits one internal update retry"
                .into(),
        )
    } else {
        CaptureError::MetadataUnavailable("yt-dlp could not inspect YouTube metadata".into())
    }
}

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
    haystack
        .as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn inventory_languages(
    inventory: BTreeMap<String, Vec<RawCaptionTrack>>,
) -> Result<Vec<String>, String> {
    if inventory.len() > MAX_LANGUAGE_COUNT {
        return Err("caption inventory exceeds the language limit".into());
    }
    let mut languages = Vec::new();
    for (language, tracks) in inventory {
        if language.is_empty()
            || language.len() > 64
            || !language
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err("caption inventory contains an invalid language key".into());
        }
        if tracks.len() > MAX_TRACKS_PER_LANGUAGE {
            return Err("caption language exceeds the track limit".into());
        }
        if tracks.iter().any(|track| {
            track.ext.is_empty()
                || track.ext.len() > 16
                || !track.ext.bytes().all(|byte| byte.is_ascii_alphanumeric())
        }) {
            return Err("caption inventory contains an invalid track format".into());
        }
        if !tracks.is_empty() {
            languages.push(language);
        }
    }
    Ok(languages)
}

fn select_language(languages: &[String], requested: &str) -> Option<String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return None;
    }
    if let Some(exact) = languages
        .iter()
        .find(|language| language.eq_ignore_ascii_case(requested))
    {
        return Some(exact.clone());
    }
    let base = language_base(requested);
    languages
        .iter()
        .find(|language| language.eq_ignore_ascii_case(base))
        .or_else(|| {
            languages
                .iter()
                .find(|language| language_base(language).eq_ignore_ascii_case(base))
        })
        .cloned()
}

fn language_base(language: &str) -> &str {
    language.split(['-', '_']).next().unwrap_or(language)
}

fn checked_duration(duration: Option<f64>) -> Result<Option<u64>, String> {
    match duration {
        Some(value) if !value.is_finite() || !(0.0..=MAX_DURATION_SECONDS).contains(&value) => {
            Err("duration is outside the supported range".into())
        }
        Some(value) => Ok(Some(value.round() as u64)),
        None => Ok(None),
    }
}

fn bounded_text(value: String, field: &str, max_bytes: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_bytes || trimmed.chars().any(char::is_control) {
        Err(format!("{field} is empty, oversized, or contains controls"))
    } else {
        Ok(trimmed.to_string())
    }
}

fn bounded_identifier(value: String, field: &str, max_bytes: usize) -> Result<String, String> {
    if value.is_empty()
        || value.len() > max_bytes
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Err(format!("{field} is invalid"))
    } else {
        Ok(value)
    }
}

fn validate_upload_date(value: String) -> Result<String, String> {
    if value.len() == 8 && NaiveDate::parse_from_str(&value, "%Y%m%d").is_ok() {
        Ok(value)
    } else {
        Err("upload date must use YYYYMMDD".into())
    }
}

fn canonical_video_url(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}")
}

/// Keep a 64 KiB head-and-tail view for non-terminal classifier work. A marker
/// present only in the discarded middle intentionally degrades to the generic
/// metadata failure; terminal block markers are scanned separately in full.
fn bounded_classifier_view(output: &str) -> String {
    if output.len() <= MAX_CLASSIFIER_BYTES {
        return output.to_string();
    }
    let edge_bytes = MAX_CLASSIFIER_BYTES / 2;
    let head = truncate_utf8(output, edge_bytes);
    let tail = truncate_utf8_start(output, output.len().saturating_sub(edge_bytes));
    format!("{head}\n{tail}")
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn truncate_utf8_start(value: &str, min_start: usize) -> &str {
    let mut start = min_start.min(value.len());
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn invalid_metadata(detail: impl Into<String>) -> CaptureError {
    CaptureError::InvalidMetadata(detail.into())
}

fn playlist_invalid(detail: impl Into<String>) -> CaptureError {
    CaptureError::PlaylistInvalid(detail.into())
}
