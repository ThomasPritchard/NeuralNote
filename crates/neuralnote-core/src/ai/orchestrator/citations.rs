//! `[eN]` citation-marker grammar used to verify answers and to strip stale
//! markers from carried history.

/// Extract the evidence ids the answer cited, in first-appearance order, deduped.
/// A citation is a `[eN]` marker (case-insensitive `e`, then ASCII digits). Byte
/// scanning is UTF-8-safe here: only ASCII bytes are ever matched or sliced on.
pub(super) fn extract_cited_ids(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut ids = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if let Some((id, next)) = citation_at(text, bytes, i) {
            if !ids.contains(&id) {
                ids.push(id);
            }
            i = next;
        } else {
            i += 1;
        }
    }
    ids
}

pub(super) fn citation_at(text: &str, bytes: &[u8], open: usize) -> Option<(String, usize)> {
    if bytes[open] != b'[' {
        return None;
    }
    let mut j = open + 1;
    if !is_evidence_prefix(bytes, j) {
        return None;
    }
    j += 1;
    let digits_start = j;
    while j < bytes.len() && bytes[j].is_ascii_digit() {
        j += 1;
    }
    if j == digits_start || j >= bytes.len() || bytes[j] != b']' {
        return None;
    }
    Some((format!("e{}", &text[digits_start..j]), j + 1))
}

fn is_evidence_prefix(bytes: &[u8], pos: usize) -> bool {
    pos < bytes.len() && (bytes[pos] == b'e' || bytes[pos] == b'E')
}

/// Remove every `[eN]` citation marker (and a single leading space) from prior-turn
/// text. Uses the same grammar as [`citation_at`], so it strips exactly what the
/// verifier would parse. Evidence ids are assigned fresh per run, so a marker carried
/// into a later turn refers to nothing in that turn's registry — and if the model
/// echoes it, the verifier can re-validate it against an *unrelated* freshly-retrieved
/// span, surfacing as a "verified" citation whose source text doesn't match the prose
/// claim (the exact mis-citation the moat forbids). History is plain context for the
/// model, so the markers add nothing; dropping them all closes the hole in the core,
/// not just the client. UTF-8-safe: markers are ASCII, so slices land on boundaries.
pub(super) fn strip_cited_markers(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied_from = 0;
    let mut i = 0;
    while i < bytes.len() {
        if let Some((_, next)) = citation_at(text, bytes, i) {
            // Copy up to the marker, dropping one preceding space so
            // "a claim [e1]." becomes "a claim." (not "a claim .").
            let mut end = i;
            if end > copied_from && bytes[end - 1] == b' ' {
                end -= 1;
            }
            out.push_str(&text[copied_from..end]);
            copied_from = next;
            i = next;
        } else {
            i += 1;
        }
    }
    out.push_str(&text[copied_from..]);
    out
}
