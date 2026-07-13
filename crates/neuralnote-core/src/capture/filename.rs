//! Portable, bounded filenames for distilled notes and source transcripts.

use crate::capture::CaptureError;
use chrono::NaiveDate;

/// Leaves room below the common 255-byte component limit for dates, suffixes,
/// collision numbers, and the `.md` extension.
pub const MAX_FILENAME_STEM_BYTES: usize = 180;
const MAX_FILENAME_INPUT_BYTES: usize = 4_096;

pub fn literature_filename(date: NaiveDate, source_title: &str) -> Result<String, CaptureError> {
    let title = sanitise_stem(&sentence_case(source_title)?)?;
    Ok(format!("{} {title}.md", date.format("%Y-%m-%d")))
}

pub fn atomic_filename(concept: &str) -> Result<String, CaptureError> {
    Ok(format!("{}.md", sanitise_stem(concept)?))
}

pub fn transcript_filename(date: NaiveDate, source_title: &str) -> Result<String, CaptureError> {
    let title = sanitise_stem(&sentence_case(source_title)?)?;
    Ok(format!("{} {title} transcript.md", date.format("%Y-%m-%d")))
}

fn sentence_case(value: &str) -> Result<String, CaptureError> {
    validate_input_bound(value)?;
    let value = if is_uppercase_text(value) || is_uniform_title_case(value) {
        value.to_lowercase()
    } else {
        value.to_string()
    };
    let first_word = value
        .chars()
        .skip_while(|character| !character.is_alphabetic())
        .take_while(|character| character.is_alphabetic())
        .collect::<String>();
    let first_word_is_uppercase = first_word.chars().count() > 1 && is_uppercase_text(&first_word);
    Ok(capitalise_first_word(&value, first_word_is_uppercase))
}

fn is_uppercase_text(value: &str) -> bool {
    let mut letters = value.chars().filter(|character| character.is_alphabetic());
    let Some(first) = letters.next() else {
        return false;
    };
    (first.is_uppercase() || letters.clone().any(char::is_uppercase))
        && !value.chars().any(char::is_lowercase)
}

fn capitalise_first_word(value: &str, first_word_is_uppercase: bool) -> String {
    let mut output = String::with_capacity(value.len());
    let mut capitalised = false;
    let mut inside_first_word = false;
    for character in value.chars() {
        if !capitalised && character.is_alphabetic() {
            output.extend(character.to_uppercase());
            capitalised = true;
            inside_first_word = true;
        } else if inside_first_word && character.is_alphabetic() && first_word_is_uppercase {
            output.extend(character.to_lowercase());
        } else {
            if inside_first_word && !character.is_alphabetic() {
                inside_first_word = false;
            }
            output.push(character);
        }
    }
    output
}

fn is_uniform_title_case(value: &str) -> bool {
    let mut words = value
        .split(|character: char| !character.is_alphabetic())
        .filter(|word| !word.is_empty())
        .peekable();
    if words.peek().is_none() {
        return false;
    }
    words.all(|word| {
        let mut characters = word.chars();
        characters.next().is_some_and(char::is_uppercase) && characters.all(char::is_lowercase)
    })
}

fn sanitise_stem(value: &str) -> Result<String, CaptureError> {
    validate_input_bound(value)?;
    let mut output = String::with_capacity(value.len().min(MAX_FILENAME_STEM_BYTES));
    let mut pending_separator = false;
    for character in value.trim().chars() {
        if character.is_whitespace() || character.is_control() || is_forbidden(character) {
            pending_separator = !output.is_empty();
            continue;
        }
        if pending_separator && !output.ends_with([' ', '.']) {
            output.push(' ');
        }
        pending_separator = false;
        output.push(character);
        truncate_to_boundary(&mut output, MAX_FILENAME_STEM_BYTES);
        if output.len() == MAX_FILENAME_STEM_BYTES {
            break;
        }
    }
    trim_portability_edges(&mut output);
    if output.is_empty() {
        return Err(CaptureError::InvalidMetadata(
            "title cannot produce a portable filename".into(),
        ));
    }
    if is_windows_reserved(&output) {
        truncate_to_boundary(&mut output, MAX_FILENAME_STEM_BYTES - 1);
        output.insert(0, '_');
    }
    Ok(output)
}

fn validate_input_bound(value: &str) -> Result<(), CaptureError> {
    if value.len() > MAX_FILENAME_INPUT_BYTES {
        Err(CaptureError::InvalidMetadata(
            "title exceeds the filename input limit".into(),
        ))
    } else {
        Ok(())
    }
}

fn is_forbidden(character: char) -> bool {
    matches!(
        character,
        '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
    )
}

fn trim_portability_edges(value: &mut String) {
    let trimmed = value.trim_matches([' ', '.']);
    if trimmed.len() != value.len() {
        *value = trimmed.to_string();
    }
}

fn truncate_to_boundary(value: &mut String, max_bytes: usize) {
    if value.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
}

fn is_windows_reserved(value: &str) -> bool {
    let base = value
        .split('.')
        .next()
        .unwrap_or(value)
        .trim()
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || is_reserved_number(base.strip_prefix("COM"))
        || is_reserved_number(base.strip_prefix("LPT"))
}

fn is_reserved_number(value: Option<&str>) -> bool {
    matches!(
        value,
        Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
    )
}
