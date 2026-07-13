//! Timestamped transcript rendering from cleaned source cues.

use super::{CaptureError, Cue, VideoId};

const PARAGRAPH_SPAN_MS: u64 = 30_000;
const MAX_PROVENANCE_COMPONENT_BYTES: usize = 128;

/// Where the timed transcript came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptProvenance {
    Captions { language: String, automatic: bool },
    Whisper { model: String },
}

/// Markdown-ready source text plus cost-estimation metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedTranscript {
    pub text: String,
    pub word_count: u64,
    pub provenance: String,
}

/// Render one source line per roughly thirty-second cue group.
///
/// Each paragraph carries the first cue's start timestamp, so line-based citation
/// evidence includes the exact anchor without adding a second citation contract.
pub fn render_transcript(
    cues: &[Cue],
    provenance: &TranscriptProvenance,
) -> Result<RenderedTranscript, CaptureError> {
    render_transcript_inner(cues, provenance, None)
}

/// Render a YouTube transcript whose timestamp anchors carry their validated
/// source jump target inside the byte-exact text later used for citations.
pub fn render_youtube_transcript(
    cues: &[Cue],
    provenance: &TranscriptProvenance,
    video_id: &VideoId,
) -> Result<RenderedTranscript, CaptureError> {
    render_transcript_inner(cues, provenance, Some(video_id))
}

fn render_transcript_inner(
    cues: &[Cue],
    provenance: &TranscriptProvenance,
    video_id: Option<&VideoId>,
) -> Result<RenderedTranscript, CaptureError> {
    if cues.is_empty() {
        return invalid_vtt("transcript contains no usable cues");
    }
    let provenance = provenance_label(provenance)?;
    let mut paragraphs = Vec::new();
    let mut group_start = 0u64;
    let mut group_text = String::new();
    let mut word_count = 0u64;
    let mut previous_start = None;

    for (index, cue) in cues.iter().enumerate() {
        if cue.end_ms < cue.start_ms {
            return invalid_vtt(format!(
                "transcript cue {index} ends before it starts: {}..{}",
                cue.start_ms, cue.end_ms
            ));
        }
        if cue.text.trim().is_empty() {
            return invalid_vtt(format!("transcript cue {index} has empty text"));
        }
        if previous_start.is_some_and(|previous| cue.start_ms < previous) {
            return invalid_vtt(format!(
                "transcript cue {index} starts before the previous cue in source order"
            ));
        }
        previous_start = Some(cue.start_ms);
        let cue_words = u64::try_from(cue.text.split_whitespace().count())
            .map_err(|_| CaptureError::InvalidVtt("transcript word count overflowed".into()))?;
        word_count = word_count
            .checked_add(cue_words)
            .ok_or_else(|| CaptureError::InvalidVtt("transcript word count overflowed".into()))?;

        if group_text.is_empty() {
            group_start = cue.start_ms;
        } else if cue.start_ms.saturating_sub(group_start) >= PARAGRAPH_SPAN_MS {
            paragraphs.push(render_paragraph(group_start, &group_text, video_id));
            group_start = cue.start_ms;
            group_text.clear();
        }
        if !group_text.is_empty() {
            group_text.push(' ');
        }
        group_text.push_str(&cue.text);
    }
    paragraphs.push(render_paragraph(group_start, &group_text, video_id));

    let mut text = format!("source: {provenance}\n\n");
    text.push_str(&paragraphs.join("\n\n"));
    text.push('\n');
    Ok(RenderedTranscript {
        text,
        word_count,
        provenance,
    })
}

fn invalid_vtt<T>(detail: impl Into<String>) -> Result<T, CaptureError> {
    Err(CaptureError::InvalidVtt(detail.into()))
}

fn provenance_label(provenance: &TranscriptProvenance) -> Result<String, CaptureError> {
    match provenance {
        TranscriptProvenance::Captions {
            language,
            automatic,
        } => {
            let language = validate_component(language, "caption language", |character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })?;
            let suffix = if *automatic { "-auto" } else { "" };
            Ok(format!("captions:{language}{suffix}"))
        }
        TranscriptProvenance::Whisper { model } => {
            let model = validate_component(model, "Whisper model", |character| {
                character.is_ascii_alphanumeric()
                    || matches!(character, '-' | '_' | '.' | '/' | ':')
            })?;
            Ok(format!("whisper:{model}"))
        }
    }
}

fn validate_component<'a>(
    value: &'a str,
    name: &str,
    allowed: impl Fn(char) -> bool,
) -> Result<&'a str, CaptureError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(CaptureError::InvalidMetadata(format!(
            "transcript provenance {name} cannot be empty"
        )));
    }
    if value.len() > MAX_PROVENANCE_COMPONENT_BYTES {
        return Err(CaptureError::InvalidMetadata(format!(
            "transcript provenance {name} exceeds {MAX_PROVENANCE_COMPONENT_BYTES} bytes"
        )));
    }
    if !value.chars().all(allowed) {
        return Err(CaptureError::InvalidMetadata(format!(
            "transcript provenance {name} contains invalid characters"
        )));
    }
    Ok(value)
}

fn render_paragraph(start_ms: u64, text: &str, video_id: Option<&VideoId>) -> String {
    let anchor = format_anchor(start_ms);
    match video_id {
        Some(video_id) => format!(
            "[{anchor}](https://youtu.be/{}?t={}) {text}",
            video_id.as_ref(),
            start_ms / 1_000
        ),
        None => format!("[{anchor}] {text}"),
    }
}

fn format_anchor(start_ms: u64) -> String {
    let total_seconds = start_ms / 1_000;
    let hours = total_seconds / 3_600;
    let minutes = (total_seconds % 3_600) / 60;
    let seconds = total_seconds % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}
