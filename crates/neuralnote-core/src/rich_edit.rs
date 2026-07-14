//! Source-preserving rich-edit preflight and validated body-range splicing.
//!
//! Markdown remains the source of truth. This module deliberately recognises a
//! small, conservative subset for the 0.2.0 rich editor; anything ambiguous or
//! unsupported is returned as raw-only. The frontend's real editor adapter must
//! still prove an exact import/export round trip for every block before enabling
//! rich editing.

use crate::note::content_hash;
use serde::de::{DeserializeSeed, Error as DeError, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use ts_rs::TS;

/// Large enough for the release performance fixture while bounding parser work.
pub const MAX_RICH_NOTE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RICH_BLOCKS: usize = 10_000;
const MAX_RICH_LINES: usize = 100_000;
const MAX_RICH_FRONTMATTER_BYTES: usize = 4 * 1024;
const MAX_PATCH_BLOCK_IDS: usize = MAX_RICH_BLOCKS;
const MAX_PATCH_ID_BYTES: usize = 128;
const MAX_PATCH_REVISION_BYTES: usize = 128;

/// A rich-editable top-level Markdown block. IDs are opaque capabilities tied to
/// the note revision and exact source range; byte offsets never cross this DTO.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RichEditBlock {
    pub id: String,
    pub leading_separator: String,
    pub markdown: String,
    pub trailing_separator: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RichEditFallback {
    pub code: RichEditFallbackCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RichEditFallbackCode {
    CrLfBody,
    MalformedFrontmatter,
    MalformedMarkdown,
    UnsupportedSyntax,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum RichEditDisposition {
    Rich,
    Raw { reason: RichEditFallback },
}

/// Pure analysis result for a note already loaded as bytes by a host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RichEditDocument {
    pub revision: String,
    pub frontmatter_prefix: String,
    pub body: String,
    pub disposition: RichEditDisposition,
    pub blocks: Vec<RichEditBlock>,
}

/// A guarded source-range edit. The adapter includes the original block IDs
/// covering the smallest contiguous changed range and its replacement Markdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RichEditPatch {
    pub expected_revision: String,
    pub changed_block_ids: Vec<String>,
    pub replacement_markdown: String,
}

impl<'de> Deserialize<'de> for RichEditPatch {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_struct(
            "RichEditPatch",
            &["expectedRevision", "changedBlockIds", "replacementMarkdown"],
            RichEditPatchVisitor,
        )
    }
}

struct RichEditPatchVisitor;

impl<'de> Visitor<'de> for RichEditPatchVisitor {
    type Value = RichEditPatch;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a bounded rich-edit patch")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut expected_revision = None;
        let mut changed_block_ids = None;
        let mut replacement_markdown = None;
        while let Some(field) = map.next_key::<RichEditPatchField>()? {
            match field {
                RichEditPatchField::ExpectedRevision => {
                    if expected_revision.is_some() {
                        return Err(A::Error::duplicate_field("expectedRevision"));
                    }
                    expected_revision = Some(map.next_value_seed(BoundedStringSeed {
                        field: "expectedRevision",
                        max_bytes: MAX_PATCH_REVISION_BYTES,
                    })?);
                }
                RichEditPatchField::ChangedBlockIds => {
                    if changed_block_ids.is_some() {
                        return Err(A::Error::duplicate_field("changedBlockIds"));
                    }
                    changed_block_ids = Some(map.next_value_seed(BoundedIdsSeed)?);
                }
                RichEditPatchField::ReplacementMarkdown => {
                    if replacement_markdown.is_some() {
                        return Err(A::Error::duplicate_field("replacementMarkdown"));
                    }
                    replacement_markdown = Some(map.next_value_seed(BoundedStringSeed {
                        field: "replacementMarkdown",
                        max_bytes: MAX_RICH_NOTE_BYTES,
                    })?);
                }
            }
        }
        Ok(RichEditPatch {
            expected_revision: expected_revision
                .ok_or_else(|| A::Error::missing_field("expectedRevision"))?,
            changed_block_ids: changed_block_ids
                .ok_or_else(|| A::Error::missing_field("changedBlockIds"))?,
            replacement_markdown: replacement_markdown
                .ok_or_else(|| A::Error::missing_field("replacementMarkdown"))?,
        })
    }
}

enum RichEditPatchField {
    ExpectedRevision,
    ChangedBlockIds,
    ReplacementMarkdown,
}

impl<'de> Deserialize<'de> for RichEditPatchField {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct FieldVisitor;

        impl Visitor<'_> for FieldVisitor {
            type Value = RichEditPatchField;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a rich-edit patch field")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: DeError,
            {
                match value {
                    "expectedRevision" => Ok(RichEditPatchField::ExpectedRevision),
                    "changedBlockIds" => Ok(RichEditPatchField::ChangedBlockIds),
                    "replacementMarkdown" => Ok(RichEditPatchField::ReplacementMarkdown),
                    _ => Err(E::unknown_field(
                        value,
                        &["expectedRevision", "changedBlockIds", "replacementMarkdown"],
                    )),
                }
            }
        }

        deserializer.deserialize_identifier(FieldVisitor)
    }
}

struct BoundedStringSeed {
    field: &'static str,
    max_bytes: usize,
}

impl<'de> DeserializeSeed<'de> for BoundedStringSeed {
    type Value = String;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_string(BoundedStringVisitor {
            field: self.field,
            max_bytes: self.max_bytes,
        })
    }
}

struct BoundedStringVisitor {
    field: &'static str,
    max_bytes: usize,
}

impl Visitor<'_> for BoundedStringVisitor {
    type Value = String;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} containing at most {} UTF-8 bytes",
            self.field, self.max_bytes
        )
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: DeError,
    {
        self.validate(value.len())?;
        Ok(value.to_owned())
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: DeError,
    {
        self.validate(value.len())?;
        Ok(value)
    }
}

impl BoundedStringVisitor {
    fn validate<E: DeError>(&self, actual: usize) -> Result<(), E> {
        if actual > self.max_bytes {
            return Err(E::custom(format!(
                "{} exceeds the {}-byte limit",
                self.field, self.max_bytes
            )));
        }
        Ok(())
    }
}

struct BoundedIdsSeed;

impl<'de> DeserializeSeed<'de> for BoundedIdsSeed {
    type Value = Vec<String>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(BoundedIdsVisitor)
    }
}

struct BoundedIdsVisitor;

impl<'de> Visitor<'de> for BoundedIdsVisitor {
    type Value = Vec<String>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "at most {MAX_PATCH_BLOCK_IDS} bounded rich-edit block IDs"
        )
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let size_hint = sequence.size_hint().unwrap_or(0);
        if size_hint > MAX_PATCH_BLOCK_IDS {
            return Err(A::Error::custom(format!(
                "changedBlockIds exceeds the {MAX_PATCH_BLOCK_IDS}-entry limit"
            )));
        }
        let capacity = size_hint.min(MAX_PATCH_BLOCK_IDS);
        let mut ids = Vec::with_capacity(capacity);
        while let Some(id) = sequence.next_element_seed(BoundedStringSeed {
            field: "changedBlockIds entry",
            max_bytes: MAX_PATCH_ID_BYTES,
        })? {
            if ids.len() == MAX_PATCH_BLOCK_IDS {
                return Err(A::Error::custom(format!(
                    "changedBlockIds exceeds the {MAX_PATCH_BLOCK_IDS}-entry limit"
                )));
            }
            ids.push(id);
        }
        Ok(ids)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RichEditApplyResult {
    pub content: String,
    pub revision: String,
    pub frontmatter_prefix: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RichEditError {
    InvalidUtf8,
    OversizedNote { actual: usize, limit: usize },
    OversizedReplacement { actual: usize, limit: usize },
    StaleRevision,
    InvalidPatch(String),
    RawOnly(RichEditFallback),
}

impl std::fmt::Display for RichEditError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUtf8 => write!(formatter, "note is not valid UTF-8"),
            Self::OversizedNote { actual, limit } => {
                write!(
                    formatter,
                    "note is too large ({actual} bytes; limit {limit})"
                )
            }
            Self::OversizedReplacement { actual, limit } => write!(
                formatter,
                "rich-edit replacement is too large ({actual} bytes; limit {limit})"
            ),
            Self::StaleRevision => write!(formatter, "note revision is stale"),
            Self::InvalidPatch(message) => write!(formatter, "invalid rich-edit patch: {message}"),
            Self::RawOnly(reason) => write!(formatter, "raw Markdown required: {}", reason.message),
        }
    }
}

impl std::error::Error for RichEditError {}

#[derive(Debug, Clone)]
struct SourceBlock {
    start: usize,
    end: usize,
    leading_separator: String,
    markdown: String,
    trailing_separator: String,
}

#[derive(Debug, Clone, Copy)]
struct ValidatedRange {
    start: usize,
    end: usize,
    first_ordinal: usize,
    last_ordinal: usize,
}

#[derive(Debug, Clone, Copy)]
struct Line<'a> {
    start: usize,
    end: usize,
    text: &'a str,
}

#[derive(Debug)]
struct FrontmatterSplit<'a> {
    prefix: &'a str,
    body: &'a str,
    malformed: Option<&'static str>,
}

/// Classify a note without normalising any bytes.
pub fn analyze_note_for_rich_edit(bytes: &[u8]) -> Result<RichEditDocument, RichEditError> {
    if bytes.len() > MAX_RICH_NOTE_BYTES {
        return Err(RichEditError::OversizedNote {
            actual: bytes.len(),
            limit: MAX_RICH_NOTE_BYTES,
        });
    }
    let raw = std::str::from_utf8(bytes).map_err(|_| RichEditError::InvalidUtf8)?;
    let revision = content_hash(raw);
    let split = split_frontmatter(raw);

    if let Some(message) = split.malformed {
        return Ok(raw_document(
            revision,
            split,
            RichEditFallbackCode::MalformedFrontmatter,
            message,
        ));
    }
    if split.body.contains("\r\n") {
        return Ok(raw_document(
            revision,
            split,
            RichEditFallbackCode::CrLfBody,
            "CRLF note bodies use raw Markdown editing in 0.2.0",
        ));
    }

    match parse_supported_body(split.body) {
        Ok(source_blocks) => {
            let blocks = source_blocks
                .iter()
                .enumerate()
                .map(|(ordinal, block)| RichEditBlock {
                    id: block_id(&revision, ordinal, block),
                    leading_separator: block.leading_separator.clone(),
                    markdown: block.markdown.clone(),
                    trailing_separator: block.trailing_separator.clone(),
                })
                .collect();
            Ok(RichEditDocument {
                revision,
                frontmatter_prefix: split.prefix.to_string(),
                body: split.body.to_string(),
                disposition: RichEditDisposition::Rich,
                blocks,
            })
        }
        Err(reason) => Ok(RichEditDocument {
            revision,
            frontmatter_prefix: split.prefix.to_string(),
            body: split.body.to_string(),
            disposition: RichEditDisposition::Raw { reason },
            blocks: Vec::new(),
        }),
    }
}

/// Apply a replacement only after revalidating revision, IDs, ordering, syntax,
/// UTF-8 boundaries, and the complete post-splice document.
pub fn apply_rich_edit_patch(
    current_note: &[u8],
    patch: &RichEditPatch,
) -> Result<RichEditApplyResult, RichEditError> {
    validate_patch_shape(patch)?;
    if patch.replacement_markdown.len() > MAX_RICH_NOTE_BYTES {
        return Err(RichEditError::OversizedReplacement {
            actual: patch.replacement_markdown.len(),
            limit: MAX_RICH_NOTE_BYTES,
        });
    }
    let current = analyze_note_for_rich_edit(current_note)?;
    if current.revision != patch.expected_revision {
        return Err(RichEditError::StaleRevision);
    }
    let RichEditDisposition::Rich = &current.disposition else {
        let RichEditDisposition::Raw { reason } = current.disposition else {
            unreachable!()
        };
        return Err(RichEditError::RawOnly(reason));
    };

    let source_blocks = parse_supported_body(&current.body).map_err(RichEditError::RawOnly)?;
    let indexed: HashMap<String, usize> = source_blocks
        .iter()
        .enumerate()
        .map(|(ordinal, block)| (block_id(&current.revision, ordinal, block), ordinal))
        .collect();
    let range = validate_patch_ids(&source_blocks, &indexed, patch)?;

    let replacement_blocks =
        parse_supported_body(&patch.replacement_markdown).map_err(RichEditError::RawOnly)?;
    if !patch.replacement_markdown.is_empty() && !source_blocks.is_empty() {
        let first_replacement = replacement_blocks
            .first()
            .expect("non-empty replacement produces a source block");
        let last_replacement = replacement_blocks
            .last()
            .expect("non-empty replacement produces a source block");
        let first_source = &source_blocks[range.first_ordinal];
        let last_source = &source_blocks[range.last_ordinal];
        if first_replacement.leading_separator != first_source.leading_separator
            || last_replacement.trailing_separator != last_source.trailing_separator
        {
            return Err(RichEditError::InvalidPatch(
                "replacement changed exact outer source separators".into(),
            ));
        }
    }
    let mut next_body = String::with_capacity(
        current.body.len() - (range.end - range.start) + patch.replacement_markdown.len(),
    );
    next_body.push_str(&current.body[..range.start]);
    next_body.push_str(&patch.replacement_markdown);
    next_body.push_str(&current.body[range.end..]);
    let verified_blocks = parse_supported_body(&next_body).map_err(RichEditError::RawOnly)?;
    if patch.replacement_markdown.is_empty() {
        let has_unchanged_left = range.start > 0;
        let has_unchanged_right = range.end < current.body.len();
        let left_boundary_survived = verified_blocks.iter().any(|block| block.end == range.start);
        let right_boundary_survived = verified_blocks
            .iter()
            .any(|block| block.start == range.start);
        if (has_unchanged_left && has_unchanged_right)
            && (!left_boundary_survived || !right_boundary_survived)
        {
            return Err(RichEditError::InvalidPatch(
                "deletion would merge unchanged neighbouring blocks".into(),
            ));
        }
    } else {
        let replacement_end = range.start + patch.replacement_markdown.len();
        let starts_on_boundary = verified_blocks
            .iter()
            .any(|block| block.start == range.start);
        let ends_on_boundary = verified_blocks
            .iter()
            .any(|block| block.end == replacement_end);
        if !starts_on_boundary || !ends_on_boundary {
            return Err(RichEditError::InvalidPatch(
                "replacement would merge into an unchanged neighbouring block".into(),
            ));
        }
    }

    let mut next_content =
        String::with_capacity(current.frontmatter_prefix.len() + next_body.len());
    next_content.push_str(&current.frontmatter_prefix);
    next_content.push_str(&next_body);
    if next_content.len() > MAX_RICH_NOTE_BYTES {
        return Err(RichEditError::OversizedNote {
            actual: next_content.len(),
            limit: MAX_RICH_NOTE_BYTES,
        });
    }

    let verified = analyze_note_for_rich_edit(next_content.as_bytes())?;
    if verified.frontmatter_prefix != current.frontmatter_prefix {
        return Err(RichEditError::InvalidPatch(
            "replacement changed how the frontmatter boundary is interpreted".into(),
        ));
    }
    if let RichEditDisposition::Raw { reason } = verified.disposition {
        return Err(RichEditError::RawOnly(reason));
    }
    if verified.body != next_body {
        return Err(RichEditError::InvalidPatch(
            "replacement did not survive a stable second parse".into(),
        ));
    }

    Ok(RichEditApplyResult {
        content: next_content,
        revision: verified.revision,
        frontmatter_prefix: verified.frontmatter_prefix,
    })
}

fn validate_patch_shape(patch: &RichEditPatch) -> Result<(), RichEditError> {
    if patch.expected_revision.is_empty()
        || patch.expected_revision.len() > MAX_PATCH_REVISION_BYTES
        || patch.expected_revision.chars().any(char::is_control)
    {
        return Err(RichEditError::InvalidPatch(
            "expected revision is empty, oversized, or contains controls".into(),
        ));
    }
    if patch.changed_block_ids.len() > MAX_PATCH_BLOCK_IDS {
        return Err(RichEditError::InvalidPatch(format!(
            "changed block IDs exceed the {MAX_PATCH_BLOCK_IDS}-entry limit"
        )));
    }
    if patch.changed_block_ids.iter().any(|id| {
        id.is_empty() || id.len() > MAX_PATCH_ID_BYTES || id.chars().any(char::is_control)
    }) {
        return Err(RichEditError::InvalidPatch(
            "changed block ID is empty, oversized, or contains controls".into(),
        ));
    }
    Ok(())
}

fn validate_patch_ids(
    blocks: &[SourceBlock],
    indexed: &HashMap<String, usize>,
    patch: &RichEditPatch,
) -> Result<ValidatedRange, RichEditError> {
    if blocks.is_empty() {
        if patch.changed_block_ids.is_empty() {
            return Ok(ValidatedRange {
                start: 0,
                end: 0,
                first_ordinal: 0,
                last_ordinal: 0,
            });
        }
        return Err(RichEditError::InvalidPatch(
            "an empty note has no source block IDs".into(),
        ));
    }
    if patch.changed_block_ids.is_empty() {
        return Err(RichEditError::InvalidPatch(
            "a non-empty note requires at least one changed block ID".into(),
        ));
    }

    let mut seen = HashSet::with_capacity(patch.changed_block_ids.len());
    let mut ordinals: Vec<usize> = Vec::with_capacity(patch.changed_block_ids.len());
    for id in &patch.changed_block_ids {
        if !seen.insert(id) {
            return Err(RichEditError::InvalidPatch(
                "changed block IDs must be unique".into(),
            ));
        }
        let ordinal = indexed
            .get(id)
            .copied()
            .ok_or_else(|| RichEditError::InvalidPatch("changed block ID is not current".into()))?;
        if ordinals
            .last()
            .is_some_and(|previous| previous.checked_add(1) != Some(ordinal))
        {
            return Err(RichEditError::InvalidPatch(
                "changed block IDs must be contiguous and remain in source order".into(),
            ));
        }
        ordinals.push(ordinal);
    }

    let first = ordinals[0];
    let last = *ordinals.last().expect("non-empty ordinals");
    Ok(ValidatedRange {
        start: blocks[first].start,
        end: blocks[last].end,
        first_ordinal: first,
        last_ordinal: last,
    })
}

fn raw_document(
    revision: String,
    split: FrontmatterSplit<'_>,
    code: RichEditFallbackCode,
    message: &str,
) -> RichEditDocument {
    RichEditDocument {
        revision,
        frontmatter_prefix: split.prefix.to_string(),
        body: split.body.to_string(),
        disposition: RichEditDisposition::Raw {
            reason: RichEditFallback {
                code,
                message: message.into(),
            },
        },
        blocks: Vec::new(),
    }
}

fn split_frontmatter(raw: &str) -> FrontmatterSplit<'_> {
    let bom_len = usize::from(raw.starts_with('\u{feff}')) * '\u{feff}'.len_utf8();
    let content = &raw[bom_len..];
    if !(content.starts_with("---\n") || content.starts_with("---\r\n")) {
        return FrontmatterSplit {
            prefix: &raw[..bom_len],
            body: &raw[bom_len..],
            malformed: None,
        };
    }

    let opening_end = content.find('\n').map_or(content.len(), |index| index + 1);
    let mut closing = None;
    let mut offset = opening_end;
    for line in content[opening_end..].split_inclusive('\n') {
        let end = offset + line.len();
        if matches!(line.trim_end_matches(['\r', '\n']), "---" | "...") {
            closing = Some((offset, end));
            break;
        }
        offset = end;
    }
    let Some((closing_start, closing_end)) = closing else {
        return FrontmatterSplit {
            prefix: "",
            body: raw,
            malformed: Some("frontmatter opened with `---` but was never closed"),
        };
    };

    let prefix_end = bom_len + closing_end;
    let yaml_start = bom_len + opening_end;
    let yaml_end = bom_len + closing_start;
    let yaml = raw[yaml_start..yaml_end].trim_end_matches(['\r', '\n']);
    let malformed = if yaml.len() > MAX_RICH_FRONTMATTER_BYTES {
        Some("frontmatter is too large for guarded rich editing")
    } else {
        match serde_yaml_ng::from_str::<serde_json::Value>(yaml) {
            Ok(serde_json::Value::Null | serde_json::Value::Object(_)) => None,
            Ok(_) => Some("frontmatter must contain key-value properties"),
            Err(_) => Some("frontmatter is malformed and must be edited as raw Markdown"),
        }
    };

    FrontmatterSplit {
        prefix: &raw[..prefix_end],
        body: &raw[prefix_end..],
        malformed,
    }
}

fn parse_supported_body(body: &str) -> Result<Vec<SourceBlock>, RichEditFallback> {
    if body.contains('\r') {
        return Err(fallback(
            RichEditFallbackCode::CrLfBody,
            "carriage returns in a note body require raw Markdown editing",
        ));
    }
    if body.chars().any(|character| {
        character == '\0' || (character.is_control() && character != '\n' && character != '\t')
    }) {
        return Err(malformed(
            "note body contains unsupported control characters",
        ));
    }
    if body.is_empty() {
        return Ok(Vec::new());
    }
    if body
        .bytes()
        .filter(|byte| *byte == b'\n')
        .take(MAX_RICH_LINES + 1)
        .count()
        > MAX_RICH_LINES
    {
        return Err(unsupported(
            "note contains too many lines for guarded rich editing",
        ));
    }

    let lines = lines_with_ranges(body);
    reject_document_level_raw_syntax(&lines)?;
    let mut blocks: Vec<SourceBlock> = Vec::new();
    let mut cursor = 0usize;
    let mut first_start = 0usize;

    while cursor < lines.len() {
        while cursor < lines.len() && is_blank(lines[cursor].text) {
            cursor += 1;
        }
        if cursor == lines.len() {
            if let Some(last) = blocks.last_mut() {
                last.end = body.len();
                last.trailing_separator = body
                    [last.start + last.leading_separator.len() + last.markdown.len()..last.end]
                    .to_string();
            } else {
                return Ok(vec![SourceBlock {
                    start: 0,
                    end: body.len(),
                    leading_separator: body.to_string(),
                    markdown: String::new(),
                    trailing_separator: String::new(),
                }]);
            }
            break;
        }

        let start_line = cursor;
        let syntax = classify_line(lines[cursor].text)?;
        cursor = match syntax {
            LineSyntax::Fence { marker, count } => consume_fence(&lines, cursor, marker, count)?,
            LineSyntax::Heading | LineSyntax::ThematicBreak => cursor + 1,
            LineSyntax::List => consume_list(&lines, cursor)?,
            LineSyntax::Blockquote => consume_blockquote(&lines, cursor)?,
            LineSyntax::Paragraph => consume_paragraph(&lines, cursor)?,
        };
        let syntax_end = lines[cursor - 1].end;
        let content_start = lines[start_line].start;
        let content_end = if body[..syntax_end].ends_with('\n') {
            syntax_end - 1
        } else {
            syntax_end
        };

        while cursor < lines.len() && is_blank(lines[cursor].text) {
            cursor += 1;
        }
        let start = if blocks.is_empty() {
            first_start
        } else {
            lines[start_line].start
        };
        let end = if cursor == 0 {
            0
        } else {
            lines[cursor - 1].end
        };
        let leading_separator = body[start..content_start].to_string();
        let markdown = body[content_start..content_end].to_string();
        let trailing_separator = body[content_end..end].to_string();
        validate_block_syntax(&markdown, syntax)?;
        blocks.push(SourceBlock {
            start,
            end,
            leading_separator,
            markdown,
            trailing_separator,
        });
        first_start = end;
        if blocks.len() > MAX_RICH_BLOCKS {
            return Err(fallback(
                RichEditFallbackCode::UnsupportedSyntax,
                "note contains too many top-level blocks for guarded rich editing",
            ));
        }
    }

    let reconstructed: String = blocks
        .iter()
        .flat_map(|block| {
            [
                block.leading_separator.as_str(),
                block.markdown.as_str(),
                block.trailing_separator.as_str(),
            ]
        })
        .collect();
    if reconstructed != body {
        return Err(malformed("top-level source ranges were ambiguous"));
    }
    Ok(blocks)
}

#[derive(Debug, Clone, Copy)]
enum LineSyntax {
    Fence { marker: u8, count: usize },
    Heading,
    ThematicBreak,
    List,
    Blockquote,
    Paragraph,
}

fn classify_line(line: &str) -> Result<LineSyntax, RichEditFallback> {
    let text = line.trim_end_matches('\n');
    if leading_spaces(text) >= 4 || text.starts_with('\t') {
        return Err(unsupported("indented code is raw-only"));
    }
    if let Some((marker, count, info)) = fence_open(text) {
        if !valid_fence_info(info) {
            return Err(unsupported(
                "fenced code metadata beyond one language token is raw-only",
            ));
        }
        if info.eq_ignore_ascii_case("dataview") {
            return Err(unsupported("Dataview code blocks are raw-only"));
        }
        return Ok(LineSyntax::Fence { marker, count });
    }
    let trimmed = text.trim_start();
    if is_atx_heading(trimmed) {
        return Ok(LineSyntax::Heading);
    }
    if is_thematic_break(trimmed) {
        return Ok(LineSyntax::ThematicBreak);
    }
    if is_list_item(trimmed) {
        return Ok(LineSyntax::List);
    }
    if trimmed.starts_with('>') {
        return Ok(LineSyntax::Blockquote);
    }
    Ok(LineSyntax::Paragraph)
}

fn consume_fence(
    lines: &[Line<'_>],
    start: usize,
    marker: u8,
    count: usize,
) -> Result<usize, RichEditFallback> {
    for (index, line) in lines.iter().enumerate().skip(start + 1) {
        let text = line.text.trim_end_matches('\n').trim_start();
        let bytes = text.as_bytes();
        let marker_count = bytes.iter().take_while(|byte| **byte == marker).count();
        if marker_count >= count && bytes[marker_count..].iter().all(u8::is_ascii_whitespace) {
            return Ok(index + 1);
        }
    }
    Err(malformed("fenced code block is not closed"))
}

fn consume_list(lines: &[Line<'_>], start: usize) -> Result<usize, RichEditFallback> {
    let mut cursor = start + 1;
    while cursor < lines.len() {
        if is_blank(lines[cursor].text) {
            let mut next = cursor;
            while next < lines.len() && is_blank(lines[next].text) {
                next += 1;
            }
            if next < lines.len()
                && (is_list_item(lines[next].text.trim_start())
                    || leading_indentation_columns(lines[next].text) >= 2)
            {
                cursor = next + 1;
                continue;
            }
            return Ok(cursor);
        }
        if leading_indentation_columns(lines[cursor].text) == 0
            && matches!(
                classify_line(lines[cursor].text)?,
                LineSyntax::Heading
                    | LineSyntax::ThematicBreak
                    | LineSyntax::Fence { .. }
                    | LineSyntax::Blockquote
            )
        {
            return Ok(cursor);
        }
        cursor += 1;
    }
    Ok(cursor)
}

fn consume_paragraph(lines: &[Line<'_>], start: usize) -> Result<usize, RichEditFallback> {
    let mut cursor = start + 1;
    while cursor < lines.len() && !is_blank(lines[cursor].text) {
        if !matches!(classify_line(lines[cursor].text)?, LineSyntax::Paragraph) {
            break;
        }
        cursor += 1;
    }
    Ok(cursor)
}

fn consume_blockquote(lines: &[Line<'_>], start: usize) -> Result<usize, RichEditFallback> {
    let mut cursor = start + 1;
    while cursor < lines.len() && !is_blank(lines[cursor].text) {
        if lines[cursor].text.trim_start().starts_with('>')
            || matches!(classify_line(lines[cursor].text)?, LineSyntax::Paragraph)
        {
            cursor += 1;
        } else {
            break;
        }
    }
    Ok(cursor)
}

fn validate_block_syntax(markdown: &str, syntax: LineSyntax) -> Result<(), RichEditFallback> {
    if matches!(syntax, LineSyntax::Fence { .. }) {
        return Ok(());
    }
    let without_fenced_code = validate_and_mask_nested_fenced_code(markdown)?;
    let visible = mask_inline_code(&without_fenced_code)?;
    let container_stripped = strip_container_prefixes_from_markdown(&visible);
    reject_document_level_raw_syntax(&lines_with_ranges(&container_stripped))?;
    reject_unsupported_visible_syntax(&container_stripped)?;
    reject_unsupported_visible_syntax(&visible)?;
    validate_inline_links(&visible)
}

fn strip_container_prefixes_from_markdown(markdown: &str) -> String {
    let mut stripped = String::with_capacity(markdown.len());
    for line in markdown.split_inclusive('\n') {
        let has_newline = line.ends_with('\n');
        let content = line.strip_suffix('\n').unwrap_or(line);
        stripped.push_str(strip_container_prefixes(content));
        if has_newline {
            stripped.push('\n');
        }
    }
    stripped
}

fn validate_and_mask_nested_fenced_code(markdown: &str) -> Result<String, RichEditFallback> {
    let lines = lines_with_ranges(markdown);
    let mut masked = markdown.as_bytes().to_vec();
    let mut active_fence: Option<(u8, usize)> = None;
    for line in lines {
        let line_text = line.text.trim_end_matches('\n');
        let content = strip_container_prefixes(line_text);
        if let Some((marker, count)) = active_fence {
            mask_source_line(&mut masked, line);
            if is_fence_close(content, marker, count) {
                active_fence = None;
            }
            continue;
        }
        if container_line_starts_with_indented_code(line_text) {
            return Err(unsupported("indented code is raw-only"));
        }

        let nested_fence = fence_open(content).or_else(|| {
            (leading_spaces(content) >= 4)
                .then(|| fence_open(content.trim_start()))
                .flatten()
        });
        if let Some((marker, count, info)) = nested_fence {
            if !valid_fence_info(info) {
                return Err(unsupported(
                    "fenced code metadata beyond one language token is raw-only",
                ));
            }
            if info.eq_ignore_ascii_case("dataview") {
                return Err(unsupported("Dataview code blocks are raw-only"));
            }
            active_fence = Some((marker, count));
            mask_source_line(&mut masked, line);
            continue;
        }

        if has_indented_code_prefix(content) && !is_list_item(content.trim_start()) {
            return Err(unsupported("indented code is raw-only"));
        }
    }
    if active_fence.is_some() {
        return Err(malformed("nested fenced code block is not closed"));
    }
    String::from_utf8(masked).map_err(|_| malformed("fenced code masking failed"))
}

fn strip_container_prefixes(mut line: &str) -> &str {
    loop {
        let spaces = leading_spaces(line);
        if spaces > 3 {
            return line;
        }
        let trimmed = &line[spaces..];
        if let Some(rest) = trimmed.strip_prefix('>') {
            line = rest.strip_prefix(' ').unwrap_or(rest);
            continue;
        }
        if let Some(content_start) = list_item_content_start(trimmed) {
            line = &trimmed[content_start..];
            continue;
        }
        return line;
    }
}

fn list_item_content_start(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let marker_end = if bytes.len() >= 2
        && matches!(bytes[0], b'-' | b'+' | b'*')
        && is_horizontal_whitespace(bytes[1])
    {
        1
    } else {
        let digits = bytes
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if digits == 0
            || !matches!(bytes.get(digits), Some(b'.' | b')'))
            || !bytes
                .get(digits + 1)
                .is_some_and(|byte| is_horizontal_whitespace(*byte))
        {
            return None;
        }
        digits + 1
    };
    let mut whitespace_end = marker_end;
    let mut column = marker_end;
    while let Some(byte) = bytes.get(whitespace_end).copied() {
        match byte {
            b' ' => column += 1,
            b'\t' => column += 4 - (column % 4),
            _ => break,
        }
        whitespace_end += 1;
    }
    let indentation = column - marker_end;
    if indentation <= 4 {
        Some(whitespace_end)
    } else if bytes.get(marker_end) == Some(&b' ') {
        // With five or more columns, CommonMark consumes only one separator
        // space and leaves at least four code-indentation columns as content.
        Some(marker_end + 1)
    } else {
        // A tab cannot be partially consumed without normalising source bytes.
        // Preserve it so the guarded raw-only check sees the ambiguity.
        Some(marker_end)
    }
}

fn is_horizontal_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t')
}

fn has_indented_code_prefix(value: &str) -> bool {
    leading_indentation_columns(value) >= 4
}

fn leading_indentation_columns(value: &str) -> usize {
    let mut column = 0usize;
    for byte in value.bytes() {
        match byte {
            b' ' => column += 1,
            b'\t' => column += 4 - (column % 4),
            _ => break,
        }
    }
    column
}

fn contains_obsidian_callout_marker(mut line: &str) -> bool {
    loop {
        let spaces = leading_spaces(line);
        if spaces > 3 {
            return false;
        }
        let trimmed = &line[spaces..];
        if let Some(rest) = trimmed.strip_prefix('>') {
            let content = rest.strip_prefix(' ').unwrap_or(rest);
            if content.starts_with("[!") {
                return true;
            }
            line = content;
            continue;
        }
        if let Some(content_start) = list_item_content_start(trimmed) {
            line = &trimmed[content_start..];
            continue;
        }
        return false;
    }
}

fn container_line_starts_with_indented_code(mut line: &str) -> bool {
    loop {
        let spaces = leading_spaces(line);
        if spaces > 3 {
            return false;
        }
        let trimmed = &line[spaces..];
        if let Some(rest) = trimmed.strip_prefix('>') {
            line = rest.strip_prefix(' ').unwrap_or(rest);
            continue;
        }
        if let Some(content_start) = list_item_content_start(trimmed) {
            let content = &trimmed[content_start..];
            if has_indented_code_prefix(content) {
                return true;
            }
            line = content;
            continue;
        }
        return false;
    }
}

fn is_fence_close(line: &str, marker: u8, count: usize) -> bool {
    let trimmed = line.trim_start();
    let bytes = trimmed.as_bytes();
    let marker_count = bytes.iter().take_while(|byte| **byte == marker).count();
    marker_count >= count && bytes[marker_count..].iter().all(u8::is_ascii_whitespace)
}

fn mask_source_line(masked: &mut [u8], line: Line<'_>) {
    for byte in &mut masked[line.start..line.end] {
        if *byte != b'\n' {
            *byte = b' ';
        }
    }
}

fn reject_document_level_raw_syntax(lines: &[Line<'_>]) -> Result<(), RichEditFallback> {
    for window in lines.windows(2) {
        let first = window[0].text.trim_end_matches('\n').trim();
        let second = window[1].text.trim_end_matches('\n').trim();
        if !first.is_empty()
            && !is_block_opener(first)
            && ((!second.is_empty() && second.chars().all(|character| character == '='))
                || (second.len() >= 3 && second.chars().all(|character| character == '-')))
        {
            return Err(unsupported("setext headings are raw-only"));
        }
        if looks_like_table_delimiter(second) && first.contains('|') {
            return Err(unsupported("Markdown tables are raw-only"));
        }
    }
    let mut yaml_like_open = false;
    for line in lines {
        let text = line.text.trim();
        if text == "---" {
            if yaml_like_open {
                return Err(unsupported("YAML-like body blocks are raw-only"));
            }
            yaml_like_open = true;
        } else if yaml_like_open
            && !text.is_empty()
            && text
                .split_once(':')
                .is_none_or(|(key, _)| key.trim().is_empty())
        {
            yaml_like_open = false;
        }
    }
    Ok(())
}

fn reject_unsupported_visible_syntax(visible: &str) -> Result<(), RichEditFallback> {
    let lower = visible.to_ascii_lowercase();
    if contains_unescaped(visible, "[[") || contains_unescaped(visible, "]]") {
        return Err(unsupported("Obsidian wikilinks and embeds are raw-only"));
    }
    if lower.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("import ") || trimmed.starts_with("export ")
    }) {
        return Err(unsupported("MDX import and export syntax is raw-only"));
    }
    if contains_unescaped(visible, "<!--") || contains_html_or_jsx_tag(visible) {
        return Err(unsupported("raw HTML and comments are raw-only"));
    }
    if contains_unescaped(visible, "[^") {
        return Err(unsupported("footnotes are raw-only"));
    }
    if contains_unescaped(visible, "$") {
        return Err(unsupported("math syntax is raw-only"));
    }
    if visible.lines().any(contains_obsidian_callout_marker) {
        return Err(unsupported("Obsidian callouts are raw-only"));
    }
    if visible.lines().any(|line| {
        let trimmed = line.trim_end();
        trimmed
            .rsplit_once(" ^")
            .is_some_and(|(_, id)| valid_obsidian_id(id))
            || trimmed.contains("#^")
    }) {
        return Err(unsupported(
            "Obsidian block IDs and references are raw-only",
        ));
    }
    if visible.lines().any(|line| {
        line.split_once("::")
            .is_some_and(|(key, _)| !key.trim().is_empty())
    }) {
        return Err(unsupported("Obsidian properties are raw-only"));
    }
    if contains_mdx_expression(visible) {
        return Err(unsupported("MDX and JSX expressions are raw-only"));
    }
    if contains_unescaped(visible, "![") {
        return Err(unsupported("Markdown images are raw-only"));
    }
    if visible.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with('[') && trimmed.contains("]: ")
            || trimmed
                .find("]:")
                .is_some_and(|index| index > 0 && trimmed.starts_with('['))
    }) {
        return Err(unsupported("reference link definitions are raw-only"));
    }
    Ok(())
}

fn validate_inline_links(visible: &str) -> Result<(), RichEditFallback> {
    let bytes = visible.as_bytes();
    let mut cursor = 0usize;
    let mut label_depth = 0usize;
    while cursor < bytes.len() {
        if bytes[cursor] == b'\\' {
            cursor = (cursor + 2).min(bytes.len());
            continue;
        }
        if bytes[cursor] == b'[' {
            label_depth = label_depth
                .checked_add(1)
                .ok_or_else(|| malformed("inline link label nesting is too deep"))?;
            cursor += 1;
            continue;
        }
        if bytes[cursor] != b']' || label_depth == 0 {
            cursor += 1;
            continue;
        }
        label_depth -= 1;
        if bytes.get(cursor + 1) == Some(&b'[') {
            return Err(unsupported("reference links are raw-only"));
        }
        if bytes.get(cursor + 1) != Some(&b'(') {
            cursor += 1;
            continue;
        }
        let destination_open = cursor + 1;
        let destination_start = destination_open + 1;
        let Some(destination_end) = find_balanced_destination_end(bytes, destination_open) else {
            return Err(malformed("inline link destination is not closed"));
        };
        let payload = visible[destination_start..destination_end].trim();
        let destination = link_destination(payload)?;
        validate_link_destination(destination)?;
        cursor = destination_end + 1;
    }
    Ok(())
}

fn find_balanced_destination_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'(') {
        return None;
    }
    let mut depth = 1usize;
    let mut cursor = start + 1;
    while cursor < bytes.len() {
        if bytes[cursor] == b'\\' {
            cursor = (cursor + 2).min(bytes.len());
            continue;
        }
        match bytes[cursor] {
            b'(' => depth = depth.checked_add(1)?,
            b')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(cursor);
                }
            }
            _ => {}
        }
        cursor += 1;
    }
    None
}

fn link_destination(payload: &str) -> Result<&str, RichEditFallback> {
    if payload.is_empty() || payload.starts_with('<') {
        return Err(unsupported("link destination is empty or ambiguous"));
    }
    let mut parts = payload.split_ascii_whitespace();
    let destination = parts.next().expect("non-empty payload");
    if let Some(title_start) = parts.next() {
        let title = std::iter::once(title_start)
            .chain(parts)
            .collect::<Vec<_>>()
            .join(" ");
        if !((title.starts_with('"') && title.ends_with('"'))
            || (title.starts_with('\'') && title.ends_with('\'')))
        {
            return Err(unsupported("link title syntax is ambiguous"));
        }
    }
    Ok(destination)
}

fn validate_link_destination(destination: &str) -> Result<(), RichEditFallback> {
    if contains_character_reference(destination) {
        return Err(unsupported(
            "HTML character references in link targets are raw-only",
        ));
    }
    if destination.chars().any(char::is_control)
        || destination.starts_with('/')
        || destination.starts_with('\\')
        || destination.starts_with("//")
        || destination.contains('\\')
    {
        return Err(unsupported(
            "link target is not a safe vault-relative or web URL",
        ));
    }
    let lower = destination.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Ok(());
    }
    if lower.starts_with("mailto:") {
        if destination[7..].contains('@') {
            return Ok(());
        }
        return Err(unsupported("mailto link is malformed"));
    }
    let decoded = decode_vault_link_once(destination)?;
    if decoded.contains('%') {
        return Err(unsupported(
            "double-encoded vault-relative links are raw-only",
        ));
    }
    let suffix_start = decoded.find(['?', '#']).unwrap_or(decoded.len());
    let path = &decoded[..suffix_start];
    let suffix = &decoded[suffix_start..];
    let unsafe_path = path
        .split('/')
        .any(|component| matches!(component, "." | ".."));
    let unsafe_suffix = suffix.chars().any(char::is_control)
        || suffix.contains('\\')
        || suffix.contains(':')
        || suffix.contains("#^");
    if decoded.chars().any(char::is_control)
        || decoded.contains(':')
        || unsafe_path
        || unsafe_suffix
    {
        return Err(unsupported(
            "link target is not a safe vault-relative or web URL",
        ));
    }
    Ok(())
}

fn contains_character_reference(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if bytes[cursor] != b'&' {
            cursor += 1;
            continue;
        }
        let mut entity = cursor + 1;
        if bytes.get(entity) == Some(&b'#') {
            entity += 1;
            if matches!(bytes.get(entity), Some(b'x' | b'X')) {
                entity += 1;
            }
        }
        let payload_start = entity;
        while bytes
            .get(entity)
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        {
            entity += 1;
        }
        if entity > payload_start && bytes.get(entity) == Some(&b';') {
            return true;
        }
        cursor += 1;
    }
    false
}

fn decode_vault_link_once(destination: &str) -> Result<String, RichEditFallback> {
    let bytes = destination.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if bytes[cursor] != b'%' {
            decoded.push(bytes[cursor]);
            cursor += 1;
            continue;
        }
        let Some(high) = bytes.get(cursor + 1).and_then(|byte| hex_value(*byte)) else {
            return Err(unsupported(
                "vault-relative link contains invalid percent encoding",
            ));
        };
        let Some(low) = bytes.get(cursor + 2).and_then(|byte| hex_value(*byte)) else {
            return Err(unsupported(
                "vault-relative link contains invalid percent encoding",
            ));
        };
        let value = high * 16 + low;
        if matches!(value, b'/' | b'\\') {
            return Err(unsupported(
                "encoded path separators in vault-relative links are raw-only",
            ));
        }
        decoded.push(value);
        cursor += 3;
    }
    String::from_utf8(decoded)
        .map_err(|_| unsupported("vault-relative link percent encoding is not valid UTF-8"))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn mask_inline_code(markdown: &str) -> Result<String, RichEditFallback> {
    let bytes = markdown.as_bytes();
    let mut masked = bytes.to_vec();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if bytes[cursor] != b'`' || is_escaped(bytes, cursor) {
            cursor += 1;
            continue;
        }
        let run = bytes[cursor..]
            .iter()
            .take_while(|byte| **byte == b'`')
            .count();
        let mut close = cursor + run;
        let mut found = None;
        while close < bytes.len() {
            if bytes[close] == b'`' && !is_escaped(bytes, close) {
                let close_run = bytes[close..]
                    .iter()
                    .take_while(|byte| **byte == b'`')
                    .count();
                if close_run == run {
                    found = Some(close + run);
                    break;
                }
                close += close_run;
            } else {
                close += 1;
            }
        }
        let Some(end) = found else {
            return Err(malformed("inline code span is not closed"));
        };
        for byte in &mut masked[cursor..end] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
        cursor = end;
    }
    String::from_utf8(masked).map_err(|_| malformed("inline code masking failed"))
}

fn block_id(revision: &str, ordinal: usize, block: &SourceBlock) -> String {
    let material = format!(
        "{revision}\0{ordinal}\0{}\0{}\0{}\0{}\0{}",
        block.start, block.end, block.leading_separator, block.markdown, block.trailing_separator
    );
    format!("rb{ordinal}x{}", content_hash(&material))
}

fn lines_with_ranges(input: &str) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    for segment in input.split_inclusive('\n') {
        let end = start + segment.len();
        lines.push(Line {
            start,
            end,
            text: segment,
        });
        start = end;
    }
    if start < input.len() {
        lines.push(Line {
            start,
            end: input.len(),
            text: &input[start..],
        });
    }
    lines
}

fn fence_open(line: &str) -> Option<(u8, usize, &str)> {
    let spaces = leading_spaces(line);
    if spaces > 3 {
        return None;
    }
    let trimmed = &line[spaces..];
    let marker = *trimmed.as_bytes().first()?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let count = trimmed
        .as_bytes()
        .iter()
        .take_while(|byte| **byte == marker)
        .count();
    (count >= 3).then(|| (marker, count, trimmed[count..].trim()))
}

fn valid_fence_info(info: &str) -> bool {
    info.is_empty()
        || (!info.contains(char::is_whitespace)
            && info
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_+#.-".contains(&byte)))
}

fn is_atx_heading(line: &str) -> bool {
    let count = line.bytes().take_while(|byte| *byte == b'#').count();
    (1..=6).contains(&count)
        && line
            .as_bytes()
            .get(count)
            .is_some_and(u8::is_ascii_whitespace)
}

fn is_thematic_break(line: &str) -> bool {
    let compact: String = line
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    compact.len() >= 3
        && compact.chars().next().is_some_and(|marker| {
            matches!(marker, '-' | '*' | '_') && compact.chars().all(|c| c == marker)
        })
}

fn is_list_item(line: &str) -> bool {
    let bytes = line.as_bytes();
    if bytes.len() >= 2 && matches!(bytes[0], b'-' | b'+' | b'*') && bytes[1].is_ascii_whitespace()
    {
        return true;
    }
    let digits = bytes
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    digits > 0
        && matches!(bytes.get(digits), Some(b'.' | b')'))
        && bytes.get(digits + 1).is_some_and(u8::is_ascii_whitespace)
}

fn is_block_opener(line: &str) -> bool {
    is_atx_heading(line)
        || is_thematic_break(line)
        || is_list_item(line)
        || line.starts_with('>')
        || fence_open(line).is_some()
}

fn looks_like_table_delimiter(line: &str) -> bool {
    let trimmed = line.trim_matches('|');
    let mut cells = trimmed.split('|');
    let mut count = 0usize;
    for cell in &mut cells {
        let cell = cell.trim().trim_matches(':');
        if cell.len() < 3 || !cell.chars().all(|character| character == '-') {
            return false;
        }
        count += 1;
    }
    count >= 2
}

fn contains_mdx_expression(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.match_indices('{').any(|(index, _)| {
        !is_escaped(bytes, index)
            && value[index + 1..]
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
    })
}

fn contains_html_or_jsx_tag(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.match_indices('<').any(|(index, _)| {
        !is_escaped(bytes, index)
            && bytes.get(index + 1).is_some_and(|byte| {
                byte.is_ascii_alphabetic() || matches!(byte, b'/' | b'!' | b'?' | b'>')
            })
    })
}

fn valid_obsidian_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn contains_unescaped(value: &str, needle: &str) -> bool {
    let bytes = value.as_bytes();
    value
        .match_indices(needle)
        .any(|(index, _)| !is_escaped(bytes, index))
}

fn is_escaped(bytes: &[u8], index: usize) -> bool {
    let slashes = bytes[..index]
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\\')
        .count();
    slashes % 2 == 1
}

fn leading_spaces(value: &str) -> usize {
    value.bytes().take_while(|byte| *byte == b' ').count()
}

fn is_blank(value: &str) -> bool {
    value.trim().is_empty()
}

fn fallback(code: RichEditFallbackCode, message: &str) -> RichEditFallback {
    RichEditFallback {
        code,
        message: message.into(),
    }
}

fn unsupported(message: &str) -> RichEditFallback {
    fallback(RichEditFallbackCode::UnsupportedSyntax, message)
}

fn malformed(message: &str) -> RichEditFallback {
    fallback(RichEditFallbackCode::MalformedMarkdown, message)
}
