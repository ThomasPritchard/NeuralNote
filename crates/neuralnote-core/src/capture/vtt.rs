//! Bounded WebVTT parsing and caption-cleaning policy.

use super::{CaptionSource, CaptureError};

/// Maximum accepted VTT payload. A 24-hour caption file remains comfortably below
/// this while an untrusted extractor result cannot grow memory without bound.
pub const MAX_VTT_BYTES: usize = 16 * 1024 * 1024;
/// Maximum bytes in one physical VTT line.
pub const MAX_VTT_LINE_BYTES: usize = 64 * 1024;
/// Maximum physical lines indexed before cue parsing.
pub const MAX_VTT_LINES: usize = 500_000;
/// Maximum cleaned text retained for one cue.
pub const MAX_VTT_CUE_TEXT_BYTES: usize = 256 * 1024;
/// Maximum raw cues accepted before cleaning or deduplication.
pub const MAX_VTT_CUES: usize = 100_000;
/// Longest gap tolerated between two cues before either may be folded into the
/// other. The rolling auto-caption encoder re-sends the previous cue's words
/// about a second later; anything further apart is separate speech, and merging
/// it would delete words and re-anchor a citation to a moment they were not
/// spoken.
pub const ROLLING_GAP_MS: u64 = 2_000;

/// Whether a VTT payload came from the rolling auto-caption encoder, and so
/// needs the cue-cleaning passes at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CueCleanup {
    /// YouTube automatic captions: each cue re-sends the previous cue's words
    /// plus a few more, so adjacent duplicates and rolling prefixes collapse.
    RollingCaptions,
    /// Human caption tracks and Whisper transcripts: every cue already holds
    /// only the words spoken in its own span, so none is ever folded away.
    Verbatim,
}

/// A caption track's own source decides which cleaning policy it gets, and it
/// decides here — once, for every caller. Only YouTube's automatic captions come
/// from the rolling encoder the cleaning passes exist for; running them over a
/// human track deletes words and re-anchors what survives. Matching exhaustively
/// means a new [`CaptionSource`] has to be classified rather than inheriting
/// whichever branch an `if` happened to leave open.
impl From<CaptionSource> for CueCleanup {
    fn from(source: CaptionSource) -> Self {
        match source {
            CaptionSource::Automatic => Self::RollingCaptions,
            CaptionSource::Human => Self::Verbatim,
        }
    }
}

/// Cleaned cues plus what the cleaning cost, so a merge is never silent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedVtt {
    pub cues: Vec<Cue>,
    /// Source cues folded into a neighbour. Always zero under
    /// [`CueCleanup::Verbatim`], which merges nothing.
    pub merged_cue_count: usize,
}

/// One timed source cue. Times are milliseconds from the start of the video.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Parse caption or Whisper WebVTT bytes into timed cues.
///
/// `cleanup` decides whether the auto-caption cleaning passes run at all. They
/// exist for the rolling encoder behind YouTube's automatic captions and would
/// delete words from any track whose cues are already distinct, so a human
/// caption track and a Whisper transcript are parsed verbatim.
pub fn parse_vtt(input: &[u8], cleanup: CueCleanup) -> Result<ParsedVtt, CaptureError> {
    if input.len() > MAX_VTT_BYTES {
        return invalid(format!("VTT exceeds the {MAX_VTT_BYTES}-byte limit"));
    }
    let text = std::str::from_utf8(input)
        .map_err(|error| CaptureError::InvalidVtt(format!("VTT is not valid UTF-8: {error}")))?;
    let lines = bounded_lines(text)?;
    let index = cue_data_start(&lines)?;
    let raw_cues = parse_raw_cues(&lines, index)?;
    let raw_cue_count = raw_cues.len();
    let cues = match cleanup {
        CueCleanup::RollingCaptions => clean_rolling_captions(raw_cues),
        CueCleanup::Verbatim => raw_cues,
    };
    if cues.is_empty() {
        return invalid("VTT contains no usable cues");
    }
    Ok(ParsedVtt {
        merged_cue_count: raw_cue_count.saturating_sub(cues.len()),
        cues,
    })
}

/// The three cleaning passes are deliberate and ordered: adjacent duplicate
/// removal, rolling-prefix collapse, then a final duplicate sweep for equal
/// cues the collapse exposed. Every pass folds a cue only into a neighbour it
/// is within [`ROLLING_GAP_MS`] of, so no cue can absorb distant speech.
fn clean_rolling_captions(cues: Vec<Cue>) -> Vec<Cue> {
    let cues = merge_adjacent_duplicates(cues);
    let cues = collapse_rolling_prefixes(cues);
    merge_adjacent_duplicates(cues)
}

fn cue_data_start(lines: &[&str]) -> Result<usize, CaptureError> {
    let first_line = lines.first().copied().unwrap_or_default();
    let header = first_line.strip_prefix('\u{feff}').unwrap_or(first_line);
    if !valid_header(header) {
        return invalid("VTT is missing a valid WEBVTT header");
    }
    let mut index = 1;
    // Header metadata ends at the first empty line. Tolerate a cue immediately
    // after the header so a recoverable missing separator does not lose content.
    while index < lines.len() && !lines[index].is_empty() && !lines[index].contains("-->") {
        index += 1;
    }
    Ok(index)
}

fn parse_raw_cues(lines: &[&str], mut index: usize) -> Result<Vec<Cue>, CaptureError> {
    let mut cues = Vec::new();
    let mut raw_cue_count = 0usize;
    while index < lines.len() {
        skip_empty_lines(lines, &mut index);
        if index >= lines.len() {
            break;
        }
        if block_directive(lines[index]) {
            skip_block(lines, &mut index);
            continue;
        }
        let timing_line = cue_timing_line(lines, &mut index)?;
        let (start_ms, end_ms) = parse_timing_line(timing_line)?;
        index += 1;
        let cue_text = collect_cue_text(lines, &mut index)?;
        raw_cue_count += 1;
        if raw_cue_count > MAX_VTT_CUES {
            return invalid(format!("VTT exceeds the {MAX_VTT_CUES}-cue limit"));
        }
        push_nonempty_cue(&mut cues, start_ms, end_ms, cue_text)?;
    }
    Ok(cues)
}

fn cue_timing_line<'a>(lines: &'a [&str], index: &mut usize) -> Result<&'a str, CaptureError> {
    if lines[*index].contains("-->") {
        return Ok(lines[*index]);
    }
    *index += 1;
    let Some(line) = lines.get(*index).copied() else {
        return invalid("VTT cue identifier is missing its timing line");
    };
    if !line.contains("-->") {
        return invalid(format!("VTT cue has an invalid timing line: {line}"));
    }
    Ok(line)
}

fn collect_cue_text(lines: &[&str], index: &mut usize) -> Result<String, CaptureError> {
    let mut cue_text = String::new();
    while *index < lines.len() && !lines[*index].is_empty() {
        let cleaned = clean_text_line(lines[*index])?;
        append_cleaned_cue_line(&mut cue_text, &cleaned)?;
        *index += 1;
    }
    Ok(cue_text)
}

fn append_cleaned_cue_line(cue_text: &mut String, cleaned: &str) -> Result<(), CaptureError> {
    if cleaned.is_empty() {
        return Ok(());
    }
    let separator_bytes = usize::from(!cue_text.is_empty());
    let next_len = cue_text
        .len()
        .checked_add(separator_bytes)
        .and_then(|length| length.checked_add(cleaned.len()))
        .ok_or_else(|| CaptureError::InvalidVtt("VTT cue text length overflowed".into()))?;
    if next_len > MAX_VTT_CUE_TEXT_BYTES {
        return invalid(format!(
            "VTT cue text exceeds the {MAX_VTT_CUE_TEXT_BYTES}-byte limit"
        ));
    }
    if !cue_text.is_empty() {
        cue_text.push(' ');
    }
    cue_text.push_str(cleaned);
    Ok(())
}

fn push_nonempty_cue(
    cues: &mut Vec<Cue>,
    start_ms: u64,
    end_ms: u64,
    text: String,
) -> Result<(), CaptureError> {
    if text.is_empty() {
        return Ok(());
    }
    if cues
        .last()
        .is_some_and(|previous| start_ms < previous.start_ms)
    {
        return invalid("VTT cue starts are not in source order");
    }
    cues.push(Cue {
        start_ms,
        end_ms,
        text,
    });
    Ok(())
}

fn invalid<T>(detail: impl Into<String>) -> Result<T, CaptureError> {
    Err(CaptureError::InvalidVtt(detail.into()))
}

fn bounded_lines(text: &str) -> Result<Vec<&str>, CaptureError> {
    let mut lines = Vec::new();
    for (index, raw_line) in text.split('\n').enumerate() {
        if index >= MAX_VTT_LINES {
            return invalid(format!(
                "VTT line count exceeds the {MAX_VTT_LINES}-line limit"
            ));
        }
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.len() > MAX_VTT_LINE_BYTES {
            return invalid(format!(
                "VTT line {} exceeds the {MAX_VTT_LINE_BYTES}-byte limit",
                index + 1
            ));
        }
        lines.push(line);
    }
    Ok(lines)
}

fn valid_header(header: &str) -> bool {
    header == "WEBVTT"
        || header
            .strip_prefix("WEBVTT")
            .is_some_and(|suffix| suffix.starts_with([' ', '\t']))
}

fn skip_empty_lines(lines: &[&str], index: &mut usize) {
    while *index < lines.len() && lines[*index].is_empty() {
        *index += 1;
    }
}

fn block_directive(line: &str) -> bool {
    ["NOTE", "STYLE", "REGION"].iter().any(|directive| {
        line == *directive
            || line
                .strip_prefix(directive)
                .is_some_and(|suffix| suffix.starts_with([' ', '\t']))
    })
}

fn skip_block(lines: &[&str], index: &mut usize) {
    while *index < lines.len() && !lines[*index].is_empty() {
        *index += 1;
    }
}

fn parse_timing_line(line: &str) -> Result<(u64, u64), CaptureError> {
    let Some((raw_start, raw_end_and_settings)) = line.split_once("-->") else {
        return invalid(format!("VTT cue has an invalid timing line: {line}"));
    };
    let raw_end = raw_end_and_settings
        .split_ascii_whitespace()
        .next()
        .ok_or_else(|| {
            CaptureError::InvalidVtt("VTT timing line is missing its end time".into())
        })?;
    let start_ms = parse_timestamp(raw_start.trim())?;
    let end_ms = parse_timestamp(raw_end)?;
    if end_ms < start_ms {
        return invalid(format!(
            "VTT cue ends before it starts: {start_ms}..{end_ms}"
        ));
    }
    Ok((start_ms, end_ms))
}

fn parse_timestamp(timestamp: &str) -> Result<u64, CaptureError> {
    let parts = timestamp.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds_and_millis) = match parts.as_slice() {
        [minutes, seconds] => (0, parse_component(minutes, timestamp)?, *seconds),
        [hours, minutes, seconds] => (
            parse_component(hours, timestamp)?,
            parse_component(minutes, timestamp)?,
            *seconds,
        ),
        _ => return invalid(format!("invalid VTT timestamp '{timestamp}'")),
    };
    let Some((seconds, millis)) = seconds_and_millis.split_once('.') else {
        return invalid(format!("invalid VTT timestamp '{timestamp}'"));
    };
    if millis.len() != 3 || !millis.bytes().all(|byte| byte.is_ascii_digit()) {
        return invalid(format!("invalid VTT timestamp '{timestamp}'"));
    }
    let seconds = parse_component(seconds, timestamp)?;
    let millis = parse_component(millis, timestamp)?;
    if minutes > 59 || seconds > 59 {
        return invalid(format!("invalid VTT timestamp '{timestamp}'"));
    }

    hours
        .checked_mul(60)
        .and_then(|value| value.checked_add(minutes))
        .and_then(|value| value.checked_mul(60))
        .and_then(|value| value.checked_add(seconds))
        .and_then(|value| value.checked_mul(1_000))
        .and_then(|value| value.checked_add(millis))
        .ok_or_else(|| CaptureError::InvalidVtt(format!("VTT timestamp overflows: '{timestamp}'")))
}

fn parse_component(component: &str, timestamp: &str) -> Result<u64, CaptureError> {
    if component.is_empty() || !component.bytes().all(|byte| byte.is_ascii_digit()) {
        return invalid(format!("invalid VTT timestamp '{timestamp}'"));
    }
    component
        .parse::<u64>()
        .map_err(|_| CaptureError::InvalidVtt(format!("invalid VTT timestamp '{timestamp}'")))
}

fn clean_text_line(line: &str) -> Result<String, CaptureError> {
    let without_tags = strip_inline_tags(line)?;
    let decoded = html_escape::decode_html_entities(&without_tags);
    if decoded.chars().any(char::is_control) {
        return invalid("VTT cue contains a decoded control character");
    }
    Ok(decoded.trim().to_string())
}

fn strip_inline_tags(line: &str) -> Result<String, CaptureError> {
    let mut output = String::with_capacity(line.len());
    let mut remaining = line;
    while let Some(open) = remaining.find('<') {
        output.push_str(&remaining[..open]);
        let after_open = &remaining[open + 1..];
        let Some(close) = after_open.find('>') else {
            return invalid("VTT cue contains an unterminated inline tag");
        };
        remaining = &after_open[close + 1..];
    }
    output.push_str(remaining);
    Ok(output)
}

/// Two cues may only be folded together when the later one starts while the
/// earlier is still on screen, or just after it. A wider gap is separate speech.
fn within_rolling_gap(previous_end_ms: u64, next_start_ms: u64) -> bool {
    next_start_ms <= previous_end_ms.saturating_add(ROLLING_GAP_MS)
}

fn merge_adjacent_duplicates(cues: Vec<Cue>) -> Vec<Cue> {
    let mut merged: Vec<Cue> = Vec::with_capacity(cues.len());
    for cue in cues {
        if let Some(previous) = merged.last_mut().filter(|previous| {
            previous.text == cue.text && within_rolling_gap(previous.end_ms, cue.start_ms)
        }) {
            previous.start_ms = previous.start_ms.min(cue.start_ms);
            previous.end_ms = previous.end_ms.max(cue.end_ms);
        } else {
            merged.push(cue);
        }
    }
    merged
}

fn collapse_rolling_prefixes(cues: Vec<Cue>) -> Vec<Cue> {
    let mut collapsed = Vec::with_capacity(cues.len());
    let mut cues = cues.into_iter().peekable();
    while let Some(first) = cues.next() {
        let mut group_start = first.start_ms;
        let mut group_end = first.end_ms;
        let mut last = first;
        while cues.peek().is_some_and(|next| {
            next.text.len() > last.text.len()
                && next.text.starts_with(&last.text)
                && within_rolling_gap(last.end_ms, next.start_ms)
        }) {
            let next = cues.next().expect("peeked rolling cue exists");
            group_start = group_start.min(next.start_ms);
            group_end = group_end.max(next.end_ms);
            last = next;
        }
        last.start_ms = group_start;
        last.end_ms = group_end.max(last.end_ms);
        collapsed.push(last);
    }
    collapsed
}
