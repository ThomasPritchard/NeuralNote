//! Reading what is already knowable from a JSON object that is still arriving.
//!
//! A streamed tool call's `arguments` land as many tiny fragments, so for most of
//! a call's life the blob is a syntactically incomplete document. This module
//! answers one question about such a blob: *which members can be read right now,
//! and is the document finished?*
//!
//! **serde_json owns every un-escaping decision.** Nothing here decodes an escape
//! sequence by hand and nothing decodes incrementally: each member is handed to
//! `serde_json` as a syntactically complete document — a finished value verbatim,
//! or, for the one string still arriving, its raw prefix re-quoted after any
//! half-arrived escape has been trimmed off the tail. That is deliberate. The
//! spike's capture contained no `\uXXXX` escapes and split no multi-byte
//! character, but that is one sample and an unproven negative; a design that never
//! decodes across a fragment boundary cannot be bitten by the sample being
//! unrepresentative.

use serde_json::Value;
use std::collections::BTreeMap;

/// One member of an object that may still be arriving.
#[derive(Debug, Clone, PartialEq)]
enum PartialValue {
    /// The value finished arriving and `serde_json` decoded it.
    Complete(Value),
    /// A string value still open at the end of the blob, decoded as far as the
    /// last complete escape sequence.
    PartialString(String),
}

/// The readable prefix of a JSON object that may still be arriving.
///
/// Built by [`PartialObject::parse`]; members past the first unreadable one are
/// simply absent, and reappear on a later parse once more bytes have landed.
#[derive(Debug, Clone, PartialEq)]
pub struct PartialObject {
    members: BTreeMap<String, PartialValue>,
    complete: bool,
}

impl PartialObject {
    /// Read `blob` as far as it currently goes.
    ///
    /// A blob that already parses takes the whole-document path, where
    /// `serde_json` handles the entire text in one pass. Anything else is scanned
    /// member by member, stopping at the first one that has not finished arriving.
    pub fn parse(blob: &str) -> Self {
        match serde_json::from_str::<Value>(blob) {
            Ok(Value::Object(map)) => Self {
                members: map
                    .into_iter()
                    .map(|(key, value)| (key, PartialValue::Complete(value)))
                    .collect(),
                complete: true,
            },
            // Valid JSON, but not an object. Nothing to read member-wise, yet the
            // document IS finished — reporting it as still-arriving would leave a
            // preview waiting forever for a close that already happened.
            Ok(_) => Self {
                members: BTreeMap::new(),
                complete: true,
            },
            Err(_) => Self {
                members: scan_open_object(blob),
                complete: false,
            },
        }
    }

    /// Whether the blob is a complete, valid JSON document.
    pub fn is_complete(&self) -> bool {
        self.complete
    }

    /// A string member that has finished arriving. `None` while it is still open,
    /// so a caller never shows half a path as if it were the whole path.
    pub fn complete_str(&self, key: &str) -> Option<&str> {
        match self.members.get(key)? {
            PartialValue::Complete(Value::String(text)) => Some(text),
            PartialValue::Complete(_) | PartialValue::PartialString(_) => None,
        }
    }

    /// A string member's text so far, whether it has closed or is still arriving.
    pub fn text(&self, key: &str) -> Option<&str> {
        match self.members.get(key)? {
            PartialValue::Complete(Value::String(text)) | PartialValue::PartialString(text) => {
                Some(text)
            }
            PartialValue::Complete(_) => None,
        }
    }
}

/// Scan an object that has not closed yet, collecting every member that has.
///
/// Byte-oriented on purpose: every character this scanner tests for (`{`, `"`,
/// `\`, `:`, `,`) is ASCII, and no byte of a multi-byte UTF-8 sequence can be
/// mistaken for one, so the scan never has to reason about character boundaries.
/// Every slice it takes is bounded by an ASCII byte, so every slice is a valid
/// string slice.
fn scan_open_object(blob: &str) -> BTreeMap<String, PartialValue> {
    let bytes = blob.as_bytes();
    let mut members = BTreeMap::new();
    let mut cursor = skip_whitespace(bytes, 0);
    if bytes.get(cursor) != Some(&b'{') {
        return members;
    }
    cursor += 1;
    loop {
        cursor = skip_whitespace(bytes, cursor);
        if bytes.get(cursor) != Some(&b'"') {
            return members;
        }
        let Some(key_end) = scan_string(bytes, cursor) else {
            return members;
        };
        let Ok(key) = serde_json::from_str::<String>(&blob[cursor..key_end]) else {
            return members;
        };
        cursor = skip_whitespace(bytes, key_end);
        if bytes.get(cursor) != Some(&b':') {
            return members;
        }
        cursor = skip_whitespace(bytes, cursor + 1);
        match scan_value(blob, cursor) {
            ScannedValue::Complete { value, end } => {
                members.insert(key, PartialValue::Complete(value));
                cursor = end;
            }
            ScannedValue::OpenString(text) => {
                // An open string is by definition the last thing in the blob.
                members.insert(key, PartialValue::PartialString(text));
                return members;
            }
            ScannedValue::Unreadable => return members,
        }
        cursor = skip_whitespace(bytes, cursor);
        if bytes.get(cursor) != Some(&b',') {
            // `}` is unreachable here (a closed object takes the whole-document
            // path), and anything else ends the readable prefix.
            return members;
        }
        cursor += 1;
    }
}

/// One member's value, as far as it has arrived.
enum ScannedValue {
    Complete {
        value: Value,
        end: usize,
    },
    OpenString(String),
    /// Still arriving, or malformed — either way, nothing to read yet.
    Unreadable,
}

fn scan_value(blob: &str, start: usize) -> ScannedValue {
    let bytes = blob.as_bytes();
    match bytes.get(start) {
        Some(b'"') => match scan_string(bytes, start) {
            Some(end) => complete_span(blob, start, end),
            None => match decode_open_string(blob, start) {
                Some(text) => ScannedValue::OpenString(text),
                None => ScannedValue::Unreadable,
            },
        },
        Some(b'{' | b'[') => match scan_container(bytes, start) {
            Some(end) => complete_span(blob, start, end),
            None => ScannedValue::Unreadable,
        },
        Some(_) => scan_literal(blob, start),
        None => ScannedValue::Unreadable,
    }
}

fn complete_span(blob: &str, start: usize, end: usize) -> ScannedValue {
    match serde_json::from_str::<Value>(&blob[start..end]) {
        Ok(value) => ScannedValue::Complete { value, end },
        Err(_) => ScannedValue::Unreadable,
    }
}

/// A number, `true`, `false` or `null`, which ends at a delimiter. A literal that
/// runs to the end of the blob is NOT read: `12` may still become `123`, and
/// showing the wrong number is worse than showing none yet.
fn scan_literal(blob: &str, start: usize) -> ScannedValue {
    let bytes = blob.as_bytes();
    let mut end = start;
    while end < bytes.len()
        && !matches!(
            bytes[end],
            b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r'
        )
    {
        end += 1;
    }
    if end == bytes.len() {
        return ScannedValue::Unreadable;
    }
    complete_span(blob, start, end)
}

/// Index just past the closing quote of the string starting at `start`, or `None`
/// if it has not closed yet.
fn scan_string(bytes: &[u8], start: usize) -> Option<usize> {
    let mut cursor = start + 1;
    while cursor < bytes.len() {
        match bytes[cursor] {
            // Skip the escaped byte so an escaped quote never ends the string. A
            // trailing lone backslash runs the cursor past the end, which is
            // exactly right: the string has not closed.
            b'\\' => cursor += 2,
            b'"' => return Some(cursor + 1),
            _ => cursor += 1,
        }
    }
    None
}

/// Index just past the closing bracket of the object/array starting at `start`,
/// or `None` if it has not closed yet. Iterative, so a deeply nested value the
/// model invented cannot overflow the stack.
fn scan_container(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut cursor = start;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'"' => {
                cursor = scan_string(bytes, cursor)?;
                continue;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(cursor + 1);
                }
            }
            _ => {}
        }
        cursor += 1;
    }
    None
}

fn skip_whitespace(bytes: &[u8], mut cursor: usize) -> usize {
    while matches!(bytes.get(cursor), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        cursor += 1;
    }
    cursor
}

/// Decode the still-open string starting at `start` (its opening quote).
///
/// The raw text after the opening quote is trimmed of any escape sequence that
/// has only half arrived, re-quoted, and handed to `serde_json` as one complete
/// string document. So the un-escaping is always a whole-document decode, never
/// an incremental one, and a fragment boundary can never land inside an escape as
/// far as the decoder is concerned.
///
/// `None` when the prefix cannot be decoded at all — a raw control character, say,
/// which the model can emit and which no JSON string may contain. The body then
/// stays empty rather than being guessed at, and the call ends up abandoned when
/// the same text fails to parse on close.
fn decode_open_string(blob: &str, start: usize) -> Option<String> {
    let raw = &blob[start + 1..];
    let trimmed = &raw[..complete_escape_end(raw.as_bytes())];
    serde_json::from_str::<String>(&format!("\"{trimmed}\"")).ok()
}

/// How much of `raw` ends on a complete escape sequence.
///
/// Cuts back past a half-arrived escape (`…\`, `…\u2`) and past a lone high
/// surrogate (`…\uD83D` with its low half still in flight) — `serde_json` rejects
/// both, and rejecting the whole prefix over a two-character tail would blank a
/// preview that is otherwise perfectly readable.
fn complete_escape_end(raw: &[u8]) -> usize {
    const ESCAPE_LEN: usize = 2;
    const UNICODE_ESCAPE_LEN: usize = 6;
    let mut cursor = 0;
    let mut end = raw.len();
    while cursor < raw.len() {
        if raw[cursor] != b'\\' {
            cursor += 1;
            continue;
        }
        let length = match raw.get(cursor + 1) {
            Some(b'u') => UNICODE_ESCAPE_LEN,
            Some(_) => ESCAPE_LEN,
            None => {
                end = cursor;
                break;
            }
        };
        if cursor + length > raw.len() {
            end = cursor;
            break;
        }
        if length == UNICODE_ESCAPE_LEN && is_high_surrogate(&raw[cursor..cursor + length]) {
            // Keep it only once its low half has landed; serde_json refuses a
            // lone leading surrogate.
            end = if cursor + UNICODE_ESCAPE_LEN * 2 <= raw.len() {
                raw.len()
            } else {
                cursor
            };
            if end == cursor {
                break;
            }
        }
        cursor += length;
    }
    end
}

fn is_high_surrogate(escape: &[u8]) -> bool {
    std::str::from_utf8(&escape[2..])
        .ok()
        .and_then(|hex| u32::from_str_radix(hex, 16).ok())
        .is_some_and(|code| (0xD800..=0xDBFF).contains(&code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_member_of_a_closed_object() {
        let object = PartialObject::parse(r#"{"rel_path":"a/b.md","content":"hi","work_item":0}"#);
        assert!(object.is_complete());
        assert_eq!(object.complete_str("rel_path"), Some("a/b.md"));
        assert_eq!(object.text("content"), Some("hi"));
        // A non-string member is readable as a value but never as text.
        assert_eq!(object.text("work_item"), None);
    }

    #[test]
    fn reads_the_closed_members_before_the_one_still_arriving() {
        let object = PartialObject::parse(r#"{"rel_path":"a/b.md","content":"partial te"#);
        assert!(!object.is_complete());
        assert_eq!(object.complete_str("rel_path"), Some("a/b.md"));
        assert_eq!(object.text("content"), Some("partial te"));
        // The open string is not a finished value, so the strict accessor refuses
        // it — that is what stops half a path being shown as the whole path.
        assert_eq!(object.complete_str("content"), None);
    }

    #[test]
    fn an_escape_split_across_the_boundary_is_held_back_not_mangled() {
        // The fragment ended on the backslash of a `\n`. Emitting a lone backslash
        // (or dropping the rest of the string) would both be wrong.
        let object = PartialObject::parse(r#"{"content":"line one\"#);
        assert_eq!(object.text("content"), Some("line one"));
        // One byte later the escape is whole and the newline appears.
        let object = PartialObject::parse(r#"{"content":"line one\n"#);
        assert_eq!(object.text("content"), Some("line one\n"));
    }

    #[test]
    fn a_half_arrived_unicode_escape_is_held_back_until_it_completes() {
        for prefix in [r"\", r"\u", r"\u2", r"\u26", r"\u263"] {
            let object = PartialObject::parse(&format!(r#"{{"content":"ok{prefix}"#));
            assert_eq!(
                object.text("content"),
                Some("ok"),
                "an incomplete {prefix} must not reach the preview"
            );
        }
        let object = PartialObject::parse(r#"{"content":"ok☺"#);
        assert_eq!(object.text("content"), Some("ok\u{263A}"));
    }

    #[test]
    fn a_lone_high_surrogate_is_held_back_until_its_low_half_lands() {
        // serde_json rejects a lone leading surrogate outright, so keeping it
        // would blank the whole preview rather than trim two characters from it.
        let object = PartialObject::parse(r#"{"content":"wave \uD83D"#);
        assert_eq!(object.text("content"), Some("wave "));
        let object = PartialObject::parse(r#"{"content":"wave 👋"#);
        assert_eq!(object.text("content"), Some("wave \u{1F44B}"));
    }

    #[test]
    fn an_escaped_surrogate_pair_appears_once_both_halves_have_landed() {
        // The pair as ESCAPES, which is the shape the trimming rule exists for —
        // the raw-UTF-8 case above never exercises it. serde_json refuses the
        // leading half on its own, so the two are only ever decoded together.
        let object = PartialObject::parse(r#"{"content":"wave 😀 done"#);
        assert_eq!(object.text("content"), Some("wave \u{1F600} done"));
        let object = PartialObject::parse(r#"{"content":"wave \uD83D\uDE0"#);
        assert_eq!(object.text("content"), Some("wave "));
    }

    #[test]
    fn a_member_whose_text_cannot_be_decoded_stops_the_scan_rather_than_guessing() {
        // Raw control characters are illegal in JSON strings but the model can
        // emit them. Whether one lands in a key or inside a nested value, the
        // scan stops at it — the members after it are not invented.
        let object = PartialObject::parse("{\"ke\u{7}y\":\"v\",\"content\":\"after");
        assert_eq!(object.text("content"), None, "an undecodable key");
        let object = PartialObject::parse("{\"opts\":{\"a\":\"\u{7}\"},\"content\":\"after");
        assert_eq!(object.text("content"), None, "an undecodable nested value");
    }

    #[test]
    fn an_unclosed_nested_object_stops_the_scan() {
        let object = PartialObject::parse(r#"{"opts":{"a":1"#);
        assert_eq!(object.text("opts"), None);
        assert!(!object.is_complete());
    }

    #[test]
    fn nothing_is_read_before_the_first_member_arrives() {
        for blob in [
            "",
            "{",
            r#"{ "#,
            r#"{"rel_"#,
            r#"{"rel_path""#,
            r#"{"rel_path":"#,
        ] {
            let object = PartialObject::parse(blob);
            assert!(!object.is_complete(), "{blob:?} is not a complete document");
            assert_eq!(
                object.text("rel_path"),
                None,
                "nothing readable in {blob:?}"
            );
        }
    }

    #[test]
    fn a_literal_that_may_still_be_growing_is_not_read() {
        // `12` could still become `123`; a wrong number is worse than none.
        assert_eq!(
            PartialObject::parse(r#"{"work_item":12"#).text("work_item"),
            None
        );
        let object = PartialObject::parse(r#"{"work_item":12,"content":"x"#);
        assert_eq!(object.text("content"), Some("x"));
    }

    #[test]
    fn steps_over_a_nested_value_to_reach_the_member_after_it() {
        let object = PartialObject::parse(r#"{"opts":{"a":[1,2],"b":"}"},"content":"after"#);
        assert_eq!(object.text("content"), Some("after"));
        // An unclosed nested value stops the scan rather than guessing past it.
        let object = PartialObject::parse(r#"{"opts":{"a":[1,2],"content":"after"#);
        assert_eq!(object.text("content"), None);
    }

    #[test]
    fn whitespace_between_tokens_does_not_hide_a_member() {
        let object = PartialObject::parse("{\n  \"rel_path\" : \"a.md\" ,\n  \"content\" : \"body");
        assert_eq!(object.complete_str("rel_path"), Some("a.md"));
        assert_eq!(object.text("content"), Some("body"));
    }

    #[test]
    fn valid_json_that_is_not_an_object_still_counts_as_finished() {
        // Nothing to preview, but the document HAS closed — reporting otherwise
        // would leave the caller waiting for a close that already happened.
        let object = PartialObject::parse("[1,2,3]");
        assert!(object.is_complete());
        assert_eq!(object.text("content"), None);
    }

    #[test]
    fn an_undecodable_prefix_yields_no_text_rather_than_a_guess() {
        // A raw control character is illegal inside a JSON string; the model can
        // still emit one. The body stays empty instead of being invented.
        let object = PartialObject::parse("{\"content\":\"bad\u{7}");
        assert_eq!(object.text("content"), None);
        assert!(!object.is_complete());
    }

    #[test]
    fn multi_byte_characters_survive_an_open_string() {
        let object = PartialObject::parse("{\"content\":\"caf\u{e9} \u{2014} r\u{e9}sum\u{e9}");
        assert_eq!(
            object.text("content"),
            Some("caf\u{e9} \u{2014} r\u{e9}sum\u{e9}")
        );
    }

    #[test]
    fn an_escaped_quote_does_not_end_the_string_early() {
        let object = PartialObject::parse(r#"{"content":"he said \"hi\" and"#);
        assert_eq!(object.text("content"), Some(r#"he said "hi" and"#));
    }
}
