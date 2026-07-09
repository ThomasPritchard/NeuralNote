//! Reading and writing note content: frontmatter parsing and crash-safe writes.

use crate::error::{CoreError, CoreResult};
use crate::model::NoteDoc;
use crate::paths::{ensure_within, rel_path};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Per-process counter making each write's temp sibling unique, so two concurrent
/// writers of the same note never collide on the temp path (PA-016).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Stable content fingerprint for optimistic-concurrency conflict detection.
/// `DefaultHasher::new()` uses fixed keys, so the digest is stable across runs.
/// Returned as a decimal string to survive the JS number-precision boundary.
///
/// `pub(crate)` so AI retrieval can hash content it already loaded (via
/// `search_vault`) without re-reading the file — the single source of truth for
/// the algorithm, so a reused-content span carries the exact same `content_hash`
/// the citation verifier expects (PA-007).
pub(crate) fn content_hash(content: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut h);
    h.finish().to_string()
}

/// Build a [`NoteDoc`] from already-in-hand `raw` content (read from, or just
/// written to, `path`). `lossy` is true when `raw` came from a non-UTF-8 text note
/// decoded with replacement chars. Avoids a redundant disk read on the write path.
fn build_doc(root: &Path, path: &Path, raw: String, lossy: bool) -> NoteDoc {
    let parsed = parse_frontmatter(&raw);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let title = title_from(&parsed.frontmatter, &parsed.body, &stem);
    NoteDoc {
        path: path.to_string_lossy().into_owned(),
        rel_path: rel_path(root, path),
        title,
        frontmatter: parsed.frontmatter,
        frontmatter_raw: parsed.frontmatter_raw,
        frontmatter_error: parsed.frontmatter_error,
        content_hash: content_hash(&raw),
        body: parsed.body,
        raw,
        binary: false,
        lossy_text: lossy,
    }
}

/// Build a [`NoteDoc`] for a non-UTF-8 file (image/PDF/other attachment). The
/// reader keys off `binary` to show its "no preview" notice rather than the
/// generic read error; the bytes themselves are never marshalled to the webview.
fn build_binary_doc(root: &Path, path: &Path) -> NoteDoc {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    NoteDoc {
        path: path.to_string_lossy().into_owned(),
        rel_path: rel_path(root, path),
        title: stem,
        frontmatter: None,
        frontmatter_raw: None,
        frontmatter_error: None,
        content_hash: String::new(),
        body: String::new(),
        raw: String::new(),
        binary: true,
        lossy_text: false,
    }
}

/// Read a note: split frontmatter from body, parse the YAML leniently, and keep
/// the full raw file regardless. The path is vault-scoped first.
pub fn read_note(root: &Path, target: &Path) -> CoreResult<NoteDoc> {
    let path = ensure_within(root, target)?;
    if !path.is_file() {
        return Err(CoreError::NotFound(path.display().to_string()));
    }
    // Read bytes, not a UTF-8 string: a vault's attachments folder is full of
    // images/PDFs, and `read_to_string` would fail on them, dead-ending the
    // reader's graceful binary branch.
    let bytes = std::fs::read(&path)?;
    match String::from_utf8(bytes) {
        Ok(raw) => Ok(build_doc(root, &path, raw, false)),
        Err(e) => {
            // Not valid UTF-8. A note file (`.md`/`.txt`) is text in some other
            // encoding (e.g. Windows-1252/Latin-1 from a migrated vault) — decode
            // it lossily so the content is SHOWN, never hidden, and flag it so the
            // reader can warn that some characters may be wrong. Anything else
            // (image/PDF/binary) stays a no-preview attachment.
            if is_text_note(&path) {
                let raw = String::from_utf8_lossy(e.as_bytes()).into_owned();
                Ok(build_doc(root, &path, raw, true))
            } else {
                Ok(build_binary_doc(root, &path))
            }
        }
    }
}

/// Whether a path is a text note we should always try to show as text (decoding
/// lossily if needed) rather than treat as a binary attachment.
fn is_text_note(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| matches!(e.as_str(), "md" | "markdown" | "txt" | "text" | "mdx"))
}

/// Read a file as a string the *same way the reader does* — lossily — so a note
/// that was lossy-decoded on read (non-UTF-8, e.g. a Windows-1252 note from a
/// migrated vault) yields the same string, and therefore the same content hash, on
/// the write-path conflict check. Strict `read_to_string` here would error on such
/// a file and make every save of an editable note fail.
fn read_to_string_lossy(path: &Path) -> std::io::Result<String> {
    Ok(String::from_utf8_lossy(&std::fs::read(path)?).into_owned())
}

/// Overwrite a note's full content, atomically (write to a temp sibling, then
/// rename) so a crash mid-write can never leave a half-written, corrupt note.
/// Returns the fresh [`NoteDoc`] built from the content just written — the caller
/// never needs a second read (so a save can't be mislabelled a failure).
///
/// If `expected_hash` is provided and the file's current content hashes
/// differently, it changed on disk since it was read (e.g. an external edit from
/// Obsidian): we refuse with [`CoreError::Conflict`] rather than silently
/// clobbering it. Pass `None` to force the write (the user chose "overwrite").
pub fn write_note(
    root: &Path,
    target: &Path,
    content: &str,
    expected_hash: Option<String>,
) -> CoreResult<NoteDoc> {
    let path = ensure_within(root, target)?;
    if !path.is_file() {
        return Err(CoreError::NotFound(path.display().to_string()));
    }
    if let Some(expected) = expected_hash {
        // Read the current bytes (surfaces I/O errors — never a silent skip) and
        // compare. Fail safe: any mismatch is a conflict, not an overwrite.
        // (There is a microsecond check-then-rename TOCTOU window; accepted — the
        // threat model is a single cooperative user, not racing writers, and the
        // worst case is overwriting an edit that landed in that window, not corruption.)
        // Lossy read so a non-UTF-8 (editable, lossy-decoded) note can still be saved.
        let current = read_to_string_lossy(&path)?;
        if content_hash(&current) != expected {
            return Err(CoreError::Conflict(
                "this note changed on disk since you opened it".into(),
            ));
        }
    }
    // Hidden temp sibling on the same filesystem → rename is atomic, and the
    // dot-prefix keeps it out of the tree scan. The pid+sequence suffix makes the
    // name unique per write, so two concurrent saves of the same note can't
    // overwrite each other's temp (PA-016).
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "note".into());
    let parent = path
        .parent()
        .ok_or_else(|| CoreError::OutsideVault(path.display().to_string()))?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{file_name}.{}.{seq}.nn-tmp", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, content) {
        let _ = std::fs::remove_file(&tmp); // don't leak a partially-written temp
        return Err(e.into());
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp); // don't leak the temp on failure
        return Err(e.into());
    }
    Ok(build_doc(root, &path, content.to_string(), false))
}

/// Title + frontmatter-stripped body for already-in-hand `raw` content, using the
/// same precedence as [`read_note`] (frontmatter `title` → first `# H1` → `stem`),
/// so search, graph, tree, and reader all agree on a note's name.
pub(crate) fn title_and_body(raw: &str, stem: &str) -> (String, String) {
    let parsed = parse_frontmatter(raw);
    let title = title_from(&parsed.frontmatter, &parsed.body, stem);
    (title, parsed.body)
}

struct Parsed {
    frontmatter: Option<serde_json::Value>,
    frontmatter_raw: Option<String>,
    frontmatter_error: Option<String>,
    body: String,
}

/// Extract a leading `---` … `---` YAML block (Obsidian/Jekyll style) and parse
/// it. On a malformed or unterminated block we never lose content: the error is
/// surfaced and the body falls back to the whole file.
fn parse_frontmatter(raw: &str) -> Parsed {
    // A leading UTF-8 BOM (some Windows editors prepend one) must not hide the
    // opening fence — skip it for detection and extraction only. `raw` itself (and
    // therefore the content hash and the editor draft) is left untouched.
    let content = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    // Frontmatter must be the very first thing in the file.
    let starts = content.starts_with("---\r\n") || content.starts_with("---\n");
    if !starts {
        return Parsed {
            frontmatter: None,
            frontmatter_raw: None,
            frontmatter_error: None,
            body: raw.to_string(),
        };
    }

    // Skip the opening fence line, then find a closing `---` (or `...`) line.
    let after_open = content.split_once('\n').map(|x| x.1).unwrap_or("");
    let mut block_lines: Vec<&str> = Vec::new();
    let mut rest: Option<&str> = None;
    let mut consumed = 0usize;
    for line in after_open.split_inclusive('\n') {
        consumed += line.len();
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" || trimmed == "..." {
            rest = Some(&after_open[consumed..]);
            break;
        }
        block_lines.push(trimmed);
    }

    match rest {
        None => Parsed {
            // Opened but never closed — surface it, keep the whole file as body.
            frontmatter: None,
            frontmatter_raw: None,
            frontmatter_error: Some(
                "frontmatter block was opened with `---` but never closed".into(),
            ),
            body: raw.to_string(),
        },
        Some(body) => {
            let block = block_lines.join("\n");
            let (frontmatter, frontmatter_error) = parse_frontmatter_block(&block);
            Parsed {
                frontmatter,
                frontmatter_raw: Some(block),
                frontmatter_error,
                body: body.to_string(),
            }
        }
    }
}

/// Largest frontmatter block we will hand to the YAML parser. Real note
/// frontmatter is a few hundred bytes, so 4 KiB is generous; anything past it is
/// treated as malformed rather than parsed. Kept deliberately small because it is
/// also the bound on quadratic alias amplification (see `parse_frontmatter_block`).
const MAX_FRONTMATTER_BYTES: usize = 4 << 10; // 4 KiB

/// Parse a frontmatter block into a JSON object, treating it as hostile-by-default
/// (notes come from migrated/synced/shared vaults). The DoS surface is YAML
/// anchors/aliases, defended in two layers:
///
/// 1. **Exponential "billion laughs"** (anchors referencing anchors) — caught by
///    the parser itself: serde_yaml_ng (via unsafe-libyaml) enforces a repetition
///    limit that rejects such a bomb in milliseconds with `repetition limit
///    exceeded`, surfaced here as a `frontmatter_error`. This is exact (the same
///    tokenizer that would expand it), so unlike a hand-rolled detector it can't be
///    evaded by a grammar edge case. The `serde_yaml_dependency_rejects_alias_bombs`
///    test is the canary if a dependency bump ever drops that limit.
/// 2. **Quadratic amplification** (one large anchor referenced N times — a flat
///    fan-out the repetition limit does NOT catch) — bounded by the small size cap
///    above: at 4 KiB the worst case expands to a sub-second, recoverable hitch
///    instead of an OOM/multi-second hang, which suits v1's own-vault threat model.
///    TODO(quadratic-yaml-dos): when vaults become shareable/synced (untrusted
///    notes), replace this size bound with a real-lexer anchor ban — scan
///    unsafe-libyaml's (in-tree) or saphyr-parser's token stream and refuse any
///    anchor/alias outright (legit frontmatter never uses them); a hand-rolled
///    byte-scan is NOT acceptable (it was bypassed twice — quote-mid-scalar and
///    hyphenated anchor names).
fn parse_frontmatter_block(block: &str) -> (Option<serde_json::Value>, Option<String>) {
    if block.len() > MAX_FRONTMATTER_BYTES {
        return (
            None,
            Some(format!(
                "frontmatter is too large ({} bytes; limit {MAX_FRONTMATTER_BYTES})",
                block.len()
            )),
        );
    }
    match serde_yaml_ng::from_str::<serde_json::Value>(block) {
        Ok(serde_json::Value::Null) => (None, None),
        // Only a YAML mapping is valid frontmatter; a top-level list or scalar is
        // malformed for our key/value properties view.
        Ok(v @ serde_json::Value::Object(_)) => (Some(v), None),
        Ok(_) => (
            None,
            Some("frontmatter must be a set of key: value pairs".into()),
        ),
        Err(e) => (None, Some(format!("invalid YAML frontmatter: {e}"))),
    }
}

/// Title precedence: frontmatter `title` → first markdown `# H1` → file stem.
fn title_from(frontmatter: &Option<serde_json::Value>, body: &str, stem: &str) -> String {
    if let Some(serde_json::Value::String(t)) = frontmatter.as_ref().and_then(|f| f.get("title")) {
        let t = t.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    for line in body.lines() {
        let line = line.trim();
        if let Some(h1) = line.strip_prefix("# ") {
            let h1 = h1.trim();
            if !h1.is_empty() {
                return h1.to_string();
            }
        }
    }
    stem.to_string()
}
