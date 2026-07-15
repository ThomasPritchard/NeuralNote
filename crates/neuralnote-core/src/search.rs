//! Full-text vault search — an on-demand scan per query, no index (the AI
//! phase's embeddings supersede ranking later).
//!
//! Matching is case-insensitive via a per-line fold map: each original char's
//! Unicode *full* case fold ([`fold_char`]) is recorded together with the char
//! it came from, and matches found in the folded text are mapped back through
//! that record. The original line is never indexed with offsets derived from a
//! folded copy — folding can change length (`İ` → `i` + combining dot, `ß` →
//! `ss`), so such offsets drift
//! and byte-slicing with them panics. Every slice boundary below comes from
//! `char_indices`, making boundary panics impossible by construction.

use caseless::Caseless;

use crate::error::CoreResult;
use crate::links::mask_code;
use crate::model::{FileHit, SearchMatch, SearchResponse, TreeNode};
use crate::note::{decode_note_text, parse_frontmatter, title_and_body, title_from, Parsed};
use crate::tree::{markdown_files, read_tree};
use icu_properties::{props::GeneralCategory, CodePointMapData, CodePointMapDataBorrowed};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

/// Total content matches returned per search (the UI shows a truncation banner).
pub const MAX_TOTAL_MATCHES: usize = 200;
/// Content matches returned per file.
pub const MAX_MATCHES_PER_FILE: usize = 50;
/// Snippet window size in Unicode scalars (chars).
pub const SNIPPET_MAX_CHARS: usize = 200;
/// Longest query actually searched, in chars — longer input is trimmed
/// server-side (never an error) so a pasted blob can't drive unbounded work.
pub const MAX_QUERY_CHARS: usize = 256;

/// Case-insensitively search every markdown note under `root` for `query`.
///
/// Ordinary queries scan the raw file text, frontmatter included (Obsidian
/// behavior). A single `tag:name` or `tag:#name` operator instead matches
/// canonical YAML tags and valid inline tags, including nested descendants.
/// Name/title hits rank before content-only hits, each group in tree-walk order.
/// Queries longer than [`MAX_QUERY_CHARS`] are truncated to it.
pub fn search_vault(root: &Path, query: &str) -> CoreResult<SearchResponse> {
    Ok(search_vault_inner(root, query, false)?.0)
}

/// Like [`search_vault`], but also returns the raw text of every file that
/// produced a content match, keyed by its absolute path (the same string as
/// [`FileHit::path`]). A caller that builds evidence spans (AI retrieval) reuses
/// this content instead of reading each hit a second time — one read per file per
/// search, not two (PA-007). The map holds only files with quotable matches (a
/// name-only hit has no line to cite), and the text is byte-identical to what
/// [`crate::note::read_note`] would load, so the reused content hashes to the same
/// `content_hash` the citation verifier expects.
pub(crate) fn search_vault_with_content(
    root: &Path,
    query: &str,
) -> CoreResult<(SearchResponse, HashMap<String, String>)> {
    search_vault_inner(root, query, true)
}

/// The shared search body. When `retain_content` is set, the raw text of each
/// content-hit file is kept and returned alongside the response (see
/// [`search_vault_with_content`]); otherwise the returned map is empty and the
/// content is dropped as soon as its hit is built (the public [`search_vault`]
/// path, byte-for-byte unchanged).
fn search_vault_inner(
    root: &Path,
    query: &str,
    retain_content: bool,
) -> CoreResult<(SearchResponse, HashMap<String, String>)> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok((
            SearchResponse {
                hits: Vec::new(),
                truncated: false,
                skipped_files: 0,
            },
            HashMap::new(),
        ));
    }
    let capped: String = trimmed.chars().take(MAX_QUERY_CHARS).collect();
    let mode = SearchMode::parse(&capped);
    if matches!(mode, SearchMode::InvalidTag) {
        return Ok((empty_response(), HashMap::new()));
    }
    let tree = read_tree(root)?;

    let mut name_hits: Vec<FileHit> = Vec::new();
    let mut content_hits: Vec<FileHit> = Vec::new();
    let mut content_by_path: HashMap<String, String> = HashMap::new();
    let mut total = 0usize;
    let mut truncated = false;
    let mut skipped_files: u32 = 0;

    for node in markdown_files(&tree) {
        // Decode via the ONE shared policy [`decode_note_text`], so the text search
        // indexes is byte-identical to what the reader ([`read_note`]) presents for
        // the same file — a Latin-1 note is searchable exactly as shown, and the
        // citation moat (retrieval reusing this content, then hashing it to match
        // the reader's) holds by construction, not coincidence (issue #33). An
        // unreadable file is skipped loudly (logged AND counted), never fatal.
        let raw = match std::fs::read(&node.path) {
            Ok(bytes) => decode_note_text(bytes).0,
            Err(e) => {
                log::warn!("search: skipping unreadable file {}: {e}", node.path);
                skipped_files = skipped_files.saturating_add(1);
                continue;
            }
        };
        let budget = MAX_MATCHES_PER_FILE.min(MAX_TOTAL_MATCHES - total);
        let (hit, clipped) = match &mode {
            SearchMode::Text(folded_query) => {
                build_file_hit(node, &raw, folded_query, budget, truncated)
            }
            SearchMode::Tag(query) => build_tag_file_hit(node, &raw, query, budget, truncated),
            SearchMode::InvalidTag => unreachable!("invalid tag queries return before tree scan"),
        };
        truncated |= clipped;
        let Some(hit) = hit else { continue };
        total += hit.matches.len();
        // Retain the content only for a hit with quotable lines — a name-only hit
        // carries no match to build a span from, so its content is never needed.
        if retain_content && !hit.matches.is_empty() {
            content_by_path.insert(node.path.clone(), raw);
        }
        if hit.name_match {
            name_hits.push(hit);
        } else {
            content_hits.push(hit);
        }
    }

    name_hits.append(&mut content_hits);
    Ok((
        SearchResponse {
            hits: name_hits,
            truncated,
            skipped_files,
        },
        content_by_path,
    ))
}

fn empty_response() -> SearchResponse {
    SearchResponse {
        hits: Vec::new(),
        truncated: false,
        skipped_files: 0,
    }
}

enum SearchMode {
    Text(Vec<char>),
    Tag(TagQuery),
    InvalidTag,
}

impl SearchMode {
    fn parse(query: &str) -> Self {
        let Some((operator, value)) = query.split_once(':') else {
            return Self::Text(fold(query));
        };
        if !operator.eq_ignore_ascii_case("tag") {
            return Self::Text(fold(query));
        }
        let name = value.strip_prefix('#').unwrap_or(value);
        if !valid_tag_name(name) {
            return Self::InvalidTag;
        }
        Self::Tag(TagQuery {
            folded_name: fold(name),
        })
    }
}

struct TagQuery {
    folded_name: Vec<char>,
}

/// Build a search hit for the `tag:` operator. Tag results are content-only:
/// file names and note titles containing the query text do not masquerade as a
/// tag match.
fn build_tag_file_hit(
    node: &TreeNode,
    raw: &str,
    query: &TagQuery,
    budget: usize,
    truncation_known: bool,
) -> (Option<FileHit>, bool) {
    if budget == 0 && truncation_known {
        return (None, false);
    }
    let stem = Path::new(&node.name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| node.name.clone());
    let parsed = parse_frontmatter(raw);
    let title = title_from(&parsed.frontmatter, &parsed.body, &stem);
    let (matches, clipped) = scan_tag_content(raw, &parsed, query, budget);
    if matches.is_empty() {
        return (None, clipped);
    }
    (
        Some(FileHit {
            path: node.path.clone(),
            rel_path: node.rel_path.clone(),
            title,
            name_match: false,
            matches,
        }),
        clipped,
    )
}

fn scan_tag_content(
    raw: &str,
    parsed: &Parsed,
    query: &TagQuery,
    budget: usize,
) -> (Vec<SearchMatch>, bool) {
    let mut matches = frontmatter_tag_matches(raw, parsed, query);
    if matches.len() > budget {
        matches.truncate(budget);
        return (matches, true);
    }

    // Unterminated frontmatter has no trustworthy body boundary. The note reader
    // keeps the raw source visible and surfaces the parse error; tag search fails
    // closed instead of treating malformed metadata as body tags.
    if parsed.frontmatter_error.is_some()
        && parsed.frontmatter_raw.is_none()
        && starts_with_frontmatter_fence(raw)
    {
        return (matches, false);
    }

    let body_line_offset = raw
        .len()
        .checked_sub(parsed.body.len())
        .map(|body_start| raw[..body_start].lines().count())
        .unwrap_or(0);
    let masked = mask_tag_syntax(&parsed.body);
    for (idx, (line, masked_line)) in parsed.body.lines().zip(masked.lines()).enumerate() {
        let ranges = matching_tag_ranges(line, masked_line, query);
        if ranges.is_empty() {
            continue;
        }
        if matches.len() >= budget {
            return (matches, true);
        }
        let fl = fold_line(line);
        let (snippet, ranges) = build_snippet(line, &fl, &ranges);
        matches.push(SearchMatch {
            line: u32::try_from(body_line_offset + idx + 1).unwrap_or(u32::MAX),
            snippet,
            ranges,
        });
    }
    (matches, false)
}

fn starts_with_frontmatter_fence(raw: &str) -> bool {
    let content = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    content.starts_with("---\n") || content.starts_with("---\r\n")
}

/// Return matches from a successfully parsed, canonical YAML `tags` property.
/// YAML decides membership; the source scan below is only for an honest snippet
/// and highlight location, never for accepting a tag value.
fn frontmatter_tag_matches(raw: &str, parsed: &Parsed, query: &TagQuery) -> Vec<SearchMatch> {
    let Some(tags) = parsed.frontmatter.as_ref().and_then(|fm| fm.get("tags")) else {
        return Vec::new();
    };
    let mut matching_names = Vec::new();
    collect_frontmatter_tags(tags, &mut matching_names);
    matching_names.retain(|name| tag_name_matches(name, query));
    if matching_names.is_empty() {
        return Vec::new();
    }

    let block_line_count = parsed
        .frontmatter_raw
        .as_deref()
        .map(|block| block.lines().count())
        .unwrap_or(0);
    let frontmatter_lines: Vec<&str> = raw.lines().skip(1).take(block_line_count).collect();
    let Some(tag_source) = frontmatter_tag_source(&frontmatter_lines) else {
        return Vec::new();
    };
    let mut located: BTreeMap<u32, (String, Vec<(usize, usize)>)> = BTreeMap::new();
    for name in &matching_names {
        let folded_name = fold(name);
        let mut found = false;
        for &(idx, line) in &tag_source.lines {
            let minimum_start = if idx == tag_source.key_index {
                tag_source.value_start
            } else {
                0
            };
            let occs = source_tag_name_ranges(line, &folded_name, minimum_start);
            if occs.is_empty() {
                continue;
            }
            located
                .entry(u32::try_from(idx + 2).unwrap_or(u32::MAX))
                .or_insert_with(|| (line.to_string(), Vec::new()))
                .1
                .extend(occs);
            found = true;
            break;
        }
        if !found {
            // Escaped YAML scalars may have no literal spelling of their decoded
            // value. Fall back to the property key line rather than inventing a
            // source range for content that is not present verbatim.
            let line = tag_source.lines[0].1;
            located
                .entry(u32::try_from(tag_source.key_index + 2).unwrap_or(u32::MAX))
                .or_insert_with(|| (line.to_string(), Vec::new()))
                .1
                .push(tag_source.key_range);
        }
    }

    located
        .into_iter()
        .map(|(line_no, (line, mut ranges))| {
            ranges.sort_unstable();
            ranges.dedup();
            let fl = fold_line(&line);
            let (snippet, ranges) = build_snippet(&line, &fl, &ranges);
            SearchMatch {
                line: line_no,
                snippet,
                ranges,
            }
        })
        .collect()
}

fn source_tag_name_ranges(
    line: &str,
    folded_name: &[char],
    minimum_start: usize,
) -> Vec<(usize, usize)> {
    let fl = fold_line(line);
    let chars: Vec<char> = line.chars().collect();
    let mut ranges = Vec::new();
    let mut i = 0usize;
    while i + folded_name.len() <= fl.folded.len() {
        if fl.folded[i..i + folded_name.len()] != *folded_name {
            i += 1;
            continue;
        }
        let start = fl.fold_origin[i];
        let end = fl.fold_origin[i + folded_name.len() - 1] + 1;
        let starts_at_boundary = start == 0 || !is_tag_char(chars[start - 1]);
        let ends_at_boundary = end == chars.len() || !is_tag_char(chars[end]);
        if start >= minimum_start && starts_at_boundary && ends_at_boundary {
            ranges.push((start, end));
        }
        i += folded_name.len();
    }
    ranges
}

struct FrontmatterTagSource<'a> {
    key_index: usize,
    key_range: (usize, usize),
    value_start: usize,
    lines: Vec<(usize, &'a str)>,
}

/// Locate the decoded root `tags` key and its exact source range. Each candidate
/// key scalar is decoded by serde_yaml_ng, so quoted and escaped spellings stay
/// aligned with the parsed mapping without duplicating YAML escape rules.
fn frontmatter_tag_source<'a>(lines: &'a [&'a str]) -> Option<FrontmatterTagSource<'a>> {
    let (key_index, key_line, key_range, value_start) =
        lines.iter().enumerate().find_map(|(index, line)| {
            decoded_tags_key_source(line)
                .map(|(key_range, value_start)| (index, *line, key_range, value_start))
        })?;
    let key_indent = key_line.chars().take_while(|ch| ch.is_whitespace()).count();
    let mut out = vec![(key_index, key_line)];
    for (index, line) in lines.iter().enumerate().skip(key_index + 1) {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push((index, *line));
            continue;
        }
        let indent = line.chars().take_while(|ch| ch.is_whitespace()).count();
        if indent <= key_indent {
            break;
        }
        out.push((index, *line));
    }
    Some(FrontmatterTagSource {
        key_index,
        key_range,
        value_start,
        lines: out,
    })
}

fn decoded_tags_key_source(line: &str) -> Option<((usize, usize), usize)> {
    if line.starts_with(char::is_whitespace) {
        return None;
    }
    for (colon_byte, character) in line.char_indices() {
        if character != ':' {
            continue;
        }
        let source = line[..colon_byte].trim_end();
        if serde_yaml_ng::from_str::<String>(source).ok().as_deref() == Some("tags") {
            let key_end = source.chars().count();
            let value_start = line[..=colon_byte].chars().count();
            return Some(((0, key_end), value_start));
        }
    }
    None
}

fn collect_frontmatter_tags(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(value) => {
            let name = value.trim().strip_prefix('#').unwrap_or(value.trim());
            if valid_tag_name(name) {
                out.push(name.to_string());
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_frontmatter_tags(value, out);
            }
        }
        _ => {}
    }
}

fn matching_tag_ranges(
    original_line: &str,
    masked_line: &str,
    query: &TagQuery,
) -> Vec<(usize, usize)> {
    let original: Vec<char> = original_line.chars().collect();
    let masked: Vec<char> = masked_line.chars().collect();
    debug_assert_eq!(original.len(), masked.len());
    let mut out = Vec::new();
    let mut cutoff = None;
    let mut i = 0usize;
    while i < masked.len() {
        if cutoff.is_some_and(|limit| i >= limit) {
            break;
        }
        if masked[i] != '#' || (i > 0 && !original[i - 1].is_whitespace()) {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        while end < masked.len() && is_tag_char(masked[end]) {
            end += 1;
        }
        let name: String = original[i + 1..end].iter().collect();
        if valid_tag_name(&name) && tag_name_matches(&name, query) {
            out.push((i, end));
            cutoff.get_or_insert(end.saturating_add(SNIPPET_MAX_CHARS));
        }
        i = end.max(i + 1);
    }
    out
}

fn tag_name_matches(name: &str, query: &TagQuery) -> bool {
    let folded = fold(name);
    folded == query.folded_name
        || (folded.starts_with(&query.folded_name)
            && folded.get(query.folded_name.len()) == Some(&'/'))
}

fn valid_tag_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(is_tag_char)
        && name.chars().any(|ch| !is_numeric_tag_char(ch))
}

static GENERAL_CATEGORY: CodePointMapDataBorrowed<'static, GeneralCategory> =
    CodePointMapData::<GeneralCategory>::new();

fn is_tag_char(ch: char) -> bool {
    if matches!(ch, '_' | '-' | '/' | '\u{200d}') {
        return true;
    }
    matches!(
        GENERAL_CATEGORY.get(ch),
        GeneralCategory::UppercaseLetter
            | GeneralCategory::LowercaseLetter
            | GeneralCategory::TitlecaseLetter
            | GeneralCategory::ModifierLetter
            | GeneralCategory::OtherLetter
            | GeneralCategory::NonspacingMark
            | GeneralCategory::SpacingMark
            | GeneralCategory::EnclosingMark
            | GeneralCategory::DecimalNumber
            | GeneralCategory::LetterNumber
            | GeneralCategory::OtherNumber
            | GeneralCategory::MathSymbol
            | GeneralCategory::CurrencySymbol
            | GeneralCategory::ModifierSymbol
            | GeneralCategory::OtherSymbol
    ) && (!ch.is_ascii() || ch.is_ascii_alphanumeric())
}

fn is_numeric_tag_char(ch: char) -> bool {
    matches!(
        GENERAL_CATEGORY.get(ch),
        GeneralCategory::DecimalNumber
            | GeneralCategory::LetterNumber
            | GeneralCategory::OtherNumber
    )
}

/// Mask Markdown constructs in which tag-like text is syntax rather than an
/// inline tag. Every input char maps to exactly one output char and all newlines
/// survive, so line and scalar offsets remain valid against the original body.
fn mask_tag_syntax(body: &str) -> String {
    let code_masked = mask_code(body);
    let mut chars: Vec<char> = code_masked.chars().collect();
    let mut reference_labels = HashSet::new();
    let line_ranges = markdown_line_ranges(&chars);

    let mut definition_index = 0usize;
    while definition_index < line_ranges.len() {
        if let Some((label, span_end, last_line)) =
            reference_definition_span(&chars, &line_ranges, definition_index)
        {
            reference_labels.insert(label);
            blank_chars(&mut chars, line_ranges[definition_index].0, span_end);
            definition_index = last_line + 1;
        } else {
            definition_index += 1;
        }
    }

    // Four-space/tab-indented code is not covered by the shared fence/span mask.
    let mut line_start = 0usize;
    while line_start < chars.len() {
        let line_end = chars[line_start..]
            .iter()
            .position(|&ch| ch == '\n')
            .map(|offset| line_start + offset)
            .unwrap_or(chars.len());
        let mut columns = 0usize;
        for &ch in &chars[line_start..line_end] {
            match ch {
                ' ' => columns += 1,
                '\t' => {
                    columns = 4;
                    break;
                }
                _ => break,
            }
        }
        if columns >= 4 {
            blank_chars(&mut chars, line_start, line_end);
        }
        line_start = line_end.saturating_add(1);
    }

    let mut i = 0usize;
    while i < chars.len() {
        if starts_with_chars(&chars, i, "<!--") {
            let end = find_chars(&chars, i + 4, "-->")
                .map(|end| end + 3)
                .unwrap_or(chars.len());
            blank_chars(&mut chars, i, end);
            i = end;
            continue;
        }
        if chars[i] == '<' {
            let end = chars[i + 1..]
                .iter()
                .position(|&ch| ch == '>')
                .map(|offset| i + 1 + offset + 1)
                .unwrap_or(chars.len());
            blank_chars(&mut chars, i, end);
            i = end;
            continue;
        }
        if starts_with_chars(&chars, i, "[[") {
            let end = find_chars(&chars, i + 2, "]]")
                .map(|end| end + 2)
                .unwrap_or(chars.len());
            blank_chars(&mut chars, i, end);
            i = end;
            continue;
        }
        if chars[i] == '[' {
            if let Some(label_end) = chars[i + 1..].iter().position(|&ch| ch == ']') {
                let label_end = i + 1 + label_end;
                let after = label_end + 1;
                let destination_end = match chars.get(after) {
                    Some('(') => chars[after + 1..]
                        .iter()
                        .position(|&ch| ch == ')')
                        .map(|offset| after + 1 + offset + 1),
                    Some('[') => chars[after + 1..]
                        .iter()
                        .position(|&ch| ch == ']')
                        .map(|offset| after + 1 + offset + 1),
                    _ => None,
                };
                if let Some(end) = destination_end {
                    blank_chars(&mut chars, i, end);
                    i = end;
                    continue;
                }
                let label = normalize_reference_label(&chars[i + 1..label_end]);
                if reference_labels.contains(&label) {
                    let end = label_end + 1;
                    blank_chars(&mut chars, i, end);
                    i = end;
                    continue;
                }
            }
        }
        i += 1;
    }
    chars.into_iter().collect()
}

fn markdown_line_ranges(chars: &[char]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0usize;
    for (index, &character) in chars.iter().enumerate() {
        if character == '\n' {
            ranges.push((start, index));
            start = index + 1;
        }
    }
    if start < chars.len() {
        ranges.push((start, chars.len()));
    }
    ranges
}

fn reference_definition_span(
    chars: &[char],
    lines: &[(usize, usize)],
    line_index: usize,
) -> Option<(String, usize, usize)> {
    let (line_start, line_end) = *lines.get(line_index)?;
    let (label, colon) = reference_definition_header(&chars[line_start..line_end])?;
    let mut destination_line = line_index;
    let mut destination_start = skip_horizontal_space(chars, line_start + colon + 1, line_end);
    if destination_start == line_end {
        destination_line += 1;
        let (next_start, next_end) = *lines.get(destination_line)?;
        destination_start = continuation_content_start(chars, next_start, next_end)?;
    }
    let destination_line_end = lines[destination_line].1;
    let destination_end =
        reference_destination_end(chars, destination_start, destination_line_end)?;
    let remainder = skip_horizontal_space(chars, destination_end, destination_line_end);
    if remainder < destination_line_end {
        let (span_end, last_line) =
            reference_title_span(chars, lines, destination_line, remainder)?;
        return Some((label, span_end, last_line));
    }

    let possible_title_line = destination_line + 1;
    if let Some(&(next_start, next_end)) = lines.get(possible_title_line) {
        if let Some(title_start) = continuation_content_start(chars, next_start, next_end) {
            if matches!(chars[title_start], '\'' | '"' | '(') {
                let (span_end, last_line) =
                    reference_title_span(chars, lines, possible_title_line, title_start)?;
                return Some((label, span_end, last_line));
            }
        }
    }
    Some((label, destination_line_end, destination_line))
}

fn reference_definition_header(line: &[char]) -> Option<(String, usize)> {
    let mut start = 0usize;
    while start < line.len() && start < 4 && line[start] == ' ' {
        start += 1;
    }
    if start > 3 || line.get(start) != Some(&'[') {
        return None;
    }
    let close = line[start + 1..].iter().position(|&ch| ch == ']')? + start + 1;
    if line.get(close + 1) != Some(&':') {
        return None;
    }
    let label = normalize_reference_label(&line[start + 1..close]);
    (!label.is_empty()).then_some((label, close + 1))
}

fn skip_horizontal_space(chars: &[char], mut start: usize, end: usize) -> usize {
    while start < end && matches!(chars[start], ' ' | '\t' | '\r') {
        start += 1;
    }
    start
}

fn continuation_content_start(chars: &[char], start: usize, end: usize) -> Option<usize> {
    let content = skip_horizontal_space(chars, start, end);
    let indent =
        chars[start..content].iter().fold(
            0usize,
            |columns, character| {
                if *character == '\t' {
                    4
                } else {
                    columns + 1
                }
            },
        );
    (content < end && indent <= 3).then_some(content)
}

fn reference_destination_end(chars: &[char], start: usize, line_end: usize) -> Option<usize> {
    if chars.get(start) == Some(&'<') {
        let mut index = start + 1;
        while index < line_end {
            match chars[index] {
                '\\' if index + 1 < line_end => index += 2,
                '>' => return Some(index + 1),
                '<' => return None,
                _ => index += 1,
            }
        }
        return None;
    }

    let mut index = start;
    let mut depth = 0usize;
    while index < line_end && !chars[index].is_whitespace() {
        match chars[index] {
            '\\' if index + 1 < line_end => index += 2,
            '(' => {
                depth += 1;
                if depth > 32 {
                    return None;
                }
                index += 1;
            }
            ')' if depth == 0 => return None,
            ')' => {
                depth -= 1;
                index += 1;
            }
            _ => index += 1,
        }
    }
    (index > start && depth == 0).then_some(index)
}

fn reference_title_span(
    chars: &[char],
    lines: &[(usize, usize)],
    start_line: usize,
    start: usize,
) -> Option<(usize, usize)> {
    let opener = *chars.get(start)?;
    let closer = match opener {
        '\'' => '\'',
        '"' => '"',
        '(' => ')',
        _ => return None,
    };
    let mut line_index = start_line;
    let mut index = start + 1;
    loop {
        let (line_start, line_end) = *lines.get(line_index)?;
        if skip_horizontal_space(chars, line_start, line_end) == line_end {
            return None;
        }
        while index < line_end {
            match chars[index] {
                '\\' if index + 1 < line_end => index += 2,
                character if character == closer => {
                    let after = skip_horizontal_space(chars, index + 1, line_end);
                    return (after == line_end).then_some((line_end, line_index));
                }
                _ => index += 1,
            }
        }
        line_index += 1;
        index = lines.get(line_index)?.0;
    }
}

fn normalize_reference_label(label: &[char]) -> String {
    label
        .iter()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn starts_with_chars(chars: &[char], at: usize, needle: &str) -> bool {
    chars
        .get(at..at + needle.chars().count())
        .is_some_and(|slice| slice.iter().copied().eq(needle.chars()))
}

fn find_chars(chars: &[char], from: usize, needle: &str) -> Option<usize> {
    (from..chars.len()).find(|&at| starts_with_chars(chars, at, needle))
}

fn blank_chars(chars: &mut [char], start: usize, end: usize) {
    for ch in &mut chars[start..end] {
        if !matches!(*ch, '\n' | '\r') {
            *ch = ' ';
        }
    }
}

/// The per-file hit-building step: the name/title check (which runs for every
/// file — a name hit costs no match budget) plus the budgeted content scan.
/// When the budget is spent AND truncation is already known, the scan is
/// skipped; otherwise a zero-budget scan still runs so a clipped match can
/// raise the truncation flag. Returns the file's hit (`None` when nothing
/// matched) and whether the scan was clipped.
fn build_file_hit(
    node: &TreeNode,
    raw: &str,
    folded_query: &[char],
    budget: usize,
    truncation_known: bool,
) -> (Option<FileHit>, bool) {
    let stem = Path::new(&node.name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| node.name.clone());
    let (title, _body) = title_and_body(raw, &stem);
    let name_match = contains_folded(&stem, folded_query) || contains_folded(&title, folded_query);

    let (matches, clipped) = if budget == 0 && truncation_known {
        (Vec::new(), false) // budget gone and truncation already known — skip
    } else {
        scan_content(raw, folded_query, budget)
    };

    if !name_match && matches.is_empty() {
        return (None, clipped);
    }
    let hit = FileHit {
        path: node.path.clone(),
        rel_path: node.rel_path.clone(),
        title,
        name_match,
        matches,
    };
    (Some(hit), clipped)
}

/// Scan `raw`'s lines for matches, keeping at most `budget` of them. The bool is
/// true iff at least one further matching line existed beyond the budget — the
/// exact "did a cap clip anything" signal for the `truncated` flag.
fn scan_content(raw: &str, folded_query: &[char], budget: usize) -> (Vec<SearchMatch>, bool) {
    let mut out = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let line_no = u32::try_from(idx + 1).unwrap_or(u32::MAX);
        let Some(m) = match_line(line, line_no, folded_query) else {
            continue;
        };
        if out.len() >= budget {
            return (out, true);
        }
        out.push(m);
    }
    (out, false)
}

/// Case-fold one char to its Unicode *full* case fold — the CaseFolding.txt
/// C+F mappings, where one code point can expand to several: `ß → "ss"`,
/// `ﬀ → "ff"`, `İ → "i\u{307}"`, and Greek final sigma `ς → σ` (so word-final
/// sigma still matches). The mapping is context-free per code point, which is
/// precisely why folding char-by-char preserves the `fold_origin` /
/// `char_starts` bookkeeping that maps a folded match back to an EXACT original
/// byte range — the citation moat. Full folding subsumes the previous
/// hand-rolled `to_lowercase` + final-sigma pass (and the old ß→ss limitation).
///
/// Unicode version: the tables are `caseless` 0.2.2's, targeting **Unicode
/// 16.0.0** (assert via `caseless::UNICODE_VERSION`). Upgrade policy: bump the
/// `caseless` dependency to adopt a newer Unicode revision — a fold table only
/// ever *adds* code points, so an upgrade can widen matches but never weakens
/// the byte-range guarantee, which is structural (from `char_indices`), not
/// data-driven.
fn fold_char(ch: char) -> impl Iterator<Item = char> {
    std::iter::once(ch).default_case_fold()
}

/// Case-fold a string the same way lines are folded (per-char [`fold_char`]).
pub(crate) fn fold(s: &str) -> Vec<char> {
    s.chars().flat_map(fold_char).collect()
}

/// Whether `text`, case-folded, contains the folded query.
fn contains_folded(text: &str, folded_query: &[char]) -> bool {
    let folded = fold(text);
    folded
        .windows(folded_query.len())
        .any(|w| w == folded_query)
}

/// A line's fold map: the folded text plus enough bookkeeping to map any folded
/// match back to an original char range and to slice the original line safely.
pub(crate) struct FoldedLine {
    /// Each original char's full case fold ([`fold_char`]), concatenated.
    pub(crate) folded: Vec<char>,
    /// The original CHAR index each folded char came from (pushed once per
    /// emitted folded char, so expansion like `İ` → 2 chars stays mapped).
    pub(crate) fold_origin: Vec<usize>,
    /// Byte offset of each original char, plus a final `line.len()` sentinel —
    /// `line[char_starts[a]..char_starts[b]]` is boundary-safe for any a ≤ b.
    pub(crate) char_starts: Vec<usize>,
}

pub(crate) fn fold_line(line: &str) -> FoldedLine {
    let mut folded = Vec::new();
    let mut fold_origin = Vec::new();
    let mut char_starts = Vec::new();
    for (char_idx, (byte_idx, ch)) in line.char_indices().enumerate() {
        char_starts.push(byte_idx);
        for lc in fold_char(ch) {
            folded.push(lc);
            fold_origin.push(char_idx);
        }
    }
    char_starts.push(line.len());
    FoldedLine {
        folded,
        fold_origin,
        char_starts,
    }
}

fn char_starts(line: &str) -> Vec<usize> {
    let mut starts: Vec<usize> = line.char_indices().map(|(idx, _)| idx).collect();
    starts.push(line.len());
    starts
}

fn snippet_window(n_chars: usize, first: (usize, usize)) -> (usize, usize) {
    if n_chars <= SNIPPET_MAX_CHARS {
        return (0, n_chars);
    }
    let (a, b) = (first.0.min(n_chars), first.1.min(n_chars));
    let start = ((a + b) / 2)
        .saturating_sub(SNIPPET_MAX_CHARS / 2)
        .min(n_chars - SNIPPET_MAX_CHARS);
    (start, start + SNIPPET_MAX_CHARS)
}

pub(crate) fn clip_line_around(line: &str, first: (usize, usize)) -> String {
    let starts = char_starts(line);
    let (start, end) = snippet_window(starts.len() - 1, first);
    line[starts[start]..starts[end]].to_string()
}

/// Non-overlapping occurrences of `query` in `folded`, as folded-index ranges.
///
/// The scan is bounded by the snippet window: the first occurrence pins the
/// window, and its end can never exceed `first_end + SNIPPET_MAX_CHARS` in
/// original chars — anything starting past that is discarded by
/// [`build_snippet`] anyway, so the scan stops there structurally (a multi-MB
/// single-line note cannot amplify allocations).
fn occurrences(folded: &[char], fold_origin: &[usize], query: &[char]) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut cutoff: Option<usize> = None; // original-char index; None until a match
    let mut i = 0;
    while i + query.len() <= folded.len() {
        if cutoff.is_some_and(|c| fold_origin[i] >= c) {
            break;
        }
        if folded[i..i + query.len()] == *query {
            if out.is_empty() {
                let first_end = fold_origin[i + query.len() - 1] + 1;
                cutoff = Some(first_end + SNIPPET_MAX_CHARS);
            }
            out.push((i, i + query.len()));
            i += query.len();
        } else {
            i += 1;
        }
    }
    out
}

/// Match one line: fold it, find occurrences, map them back to original char
/// ranges, and build the (possibly clipped) snippet. One [`SearchMatch`] per
/// matching line; `line_no` is 1-based.
fn match_line(line: &str, line_no: u32, folded_query: &[char]) -> Option<SearchMatch> {
    let fl = fold_line(line);
    let occs = occurrences(&fl.folded, &fl.fold_origin, folded_query);
    if occs.is_empty() {
        return None;
    }
    // A folded match [i, j) maps to original chars [origin[i], origin[j-1] + 1).
    let orig: Vec<(usize, usize)> = occs
        .iter()
        .map(|&(i, j)| (fl.fold_origin[i], fl.fold_origin[j - 1] + 1))
        .collect();
    let (snippet, ranges) = build_snippet(line, &fl, &orig);
    Some(SearchMatch {
        line: line_no,
        snippet,
        ranges,
    })
}

/// The snippet for a matched line: the whole line when short, else a
/// [`SNIPPET_MAX_CHARS`]-wide window centered on the first match (clamped to
/// the line). Ranges are rebased to the window; a range straddling a window
/// edge is CLIPPED to its visible part, and only fully-outside ranges are
/// dropped — so the first match (which the window is centered on) always
/// yields a range, even when wider than the window itself.
fn build_snippet(
    line: &str,
    fl: &FoldedLine,
    occs: &[(usize, usize)],
) -> (String, Vec<(u32, u32)>) {
    let n_chars = fl.char_starts.len() - 1; // minus the sentinel
    if n_chars <= SNIPPET_MAX_CHARS {
        let ranges = occs.iter().map(|&(a, b)| (a as u32, b as u32)).collect();
        return (line.to_string(), ranges);
    }
    let (start, end) = snippet_window(n_chars, occs[0]);
    let snippet = line[fl.char_starts[start]..fl.char_starts[end]].to_string();
    let ranges = occs
        .iter()
        .filter_map(|&(x, y)| {
            let (cx, cy) = (x.max(start), y.min(end));
            (cx < cy).then_some(((cx - start) as u32, (cy - start) as u32))
        })
        .collect();
    (snippet, ranges)
}

#[cfg(test)]
mod tag_parser_tests {
    use super::{matching_tag_ranges, SearchMode};

    #[test]
    fn dense_single_line_stops_collecting_ranges_outside_the_snippet_window() {
        let line = "#project ".repeat(60_000);
        let SearchMode::Tag(query) = SearchMode::parse("tag:#project") else {
            panic!("valid tag query did not parse");
        };
        let ranges = matching_tag_ranges(&line, &line, &query);
        assert!(ranges.len() <= 32, "collected {} ranges", ranges.len());
    }
}
