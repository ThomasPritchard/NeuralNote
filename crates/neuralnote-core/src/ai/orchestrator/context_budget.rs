//! Token-aware prompt budgeting so a dense-script vault cannot push grounding
//! out of a small local (or catalogue-reported) context window.

use crate::ai::llm::{LlmMessage, Role};

// ── Token-aware context budgeting (PA-029) ──────────────────────────────────
//
// The char guards above (MAX_HISTORY_CHARS, Guards::max_context_chars) bound cloud
// token *cost* and keep the assembled prompt sane, but they measure CHARS. A CJK- or
// symbol-dense vault tokenises far denser than the ~4 chars/token those budgets assume,
// so the SUM of system + history + evidence can still blow past a small local window
// even with every char budget respected — at which point Ollama silently truncates from
// the FRONT, dropping the grounding rules (sent first) and breaking cited recall (the
// moat). `fit_prompt_to_window` is the authoritative second pass: it budgets the fully
// assembled prompt against the active model's window in *tokens* right before each send,
// deterministically dropping the OLDEST evidence/history while always preserving the
// grounding prefix and the newest evidence, and reporting any loss so it is never silent.
//
// The window comes from the client (`LlmClient::context_window_tokens`): the local
// client reports the `num_ctx` it sends to Ollama; a cloud client reports the model's
// catalogue `context_length` when the shell's cache knows it. An UNKNOWN window (a
// cloud model the catalogue never listed) is deliberately inert — the char guards
// remain its ceiling — because a guessed window is worse than none.

/// The local (Ollama) context window in tokens — the SAME constant the shell sends
/// as `num_ctx` ([`crate::ai::local::OLLAMA_NUM_CTX`]), so the budget and the window
/// Ollama actually enforces can never drift apart.
pub(super) const LOCAL_CONTEXT_WINDOW_TOKENS: usize = crate::ai::local::OLLAMA_NUM_CTX as usize;

/// Tokens held back from the window for the streamed answer, which shares the same
/// `num_ctx`. Mirrors [`crate::ai::openai::ANSWER_MAX_TOKENS`].
pub(super) const ANSWER_RESERVE_TOKENS: usize = crate::ai::openai::ANSWER_MAX_TOKENS as usize;

/// Fixed headroom for chat-template special tokens plus the residual imprecision of a
/// char-classified estimate (non-BPE merge quirks that can exceed the byte-fallback
/// weight, e.g. multi-scalar emoji/ZWJ sequences the tokenizer splits unusually).
/// Over-reserving only trims slightly early; under-reserving risks the silent
/// front-truncation this whole pass exists to prevent — so we err high.
pub(super) const PROMPT_OVERHEAD_TOKENS: usize = 1_024;

/// Per-message framing overhead (the role marker and delimiters the chat template adds
/// around every message).
const PER_MESSAGE_OVERHEAD_TOKENS: usize = 8;

/// Chars of ASCII alphanumeric/whitespace text per token — the easy ~4:1 case.
const ASCII_CHARS_PER_TOKEN: usize = 4;

/// Appended to any single message head-truncated to fit the window, so the loss is
/// visible in-band as well as in the Coverage footer.
const TRUNCATION_MARKER: &str = "\n\n[older content trimmed to fit the model's context window]";

/// A conservative, script-aware UPPER-BOUND estimate of the BPE token count of `text`.
/// ASCII letters/digits/whitespace tokenise at ~4 chars/token; ASCII punctuation/symbols
/// are counted as a whole token each; every non-ASCII scalar is weighted by its UTF-8
/// BYTE length, because byte-level BPE tokenisers (Qwen/Llama via Ollama) fall back to
/// one token PER BYTE for scalars with no merge rules (rare CJK extensions, cuneiform,
/// tag blocks, some emoji/ZWJ) — up to 4 tokens for a 4-byte scalar where a flat
/// 1-token/scalar weight would under-budget ~4× and let Ollama silently front-truncate
/// the grounding (the moat). We deliberately OVER-count so the budget errs toward
/// trimming a little early rather than letting that happen. Accumulated in
/// quarter-tokens to keep the 4:1 ratio without floats, then rounded up.
pub(super) fn estimate_tokens(text: &str) -> usize {
    let sub_tokens: usize = text.chars().map(char_sub_tokens).sum();
    sub_tokens.div_ceil(ASCII_CHARS_PER_TOKEN)
}

/// Sub-token weight of one scalar, in units of 1/[`ASCII_CHARS_PER_TOKEN`] of a token
/// (see [`estimate_tokens`]): 1 sub-token for easy ASCII (so `ASCII_CHARS_PER_TOKEN` of
/// them make a token), a whole token's worth for other ASCII, and one token per UTF-8
/// byte for non-ASCII (the byte-fallback BPE upper bound).
fn char_sub_tokens(ch: char) -> usize {
    // TODO(token-estimate): mergeless random-alnum payloads (base64-ish blobs) can
    // tokenize denser than the 4:1 weight below (real-world ~1.5-3 chars/token), so a
    // pathological ASCII blob could still under-budget a small window. Accepted residual
    // from the #22 adversarial review; tighten to 2:1 or scale PROMPT_OVERHEAD_TOKENS
    // with prompt size if dense-ASCII vaults prove it out.
    if ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace() {
        1
    } else if ch.is_ascii() {
        ASCII_CHARS_PER_TOKEN
    } else {
        ASCII_CHARS_PER_TOKEN * ch.len_utf8()
    }
}

/// Estimated tokens of one assembled message: its framing overhead plus its content,
/// tool-call names/arguments, and tool-result name — everything that reaches the wire.
fn message_tokens(message: &LlmMessage) -> usize {
    let mut tokens = PER_MESSAGE_OVERHEAD_TOKENS;
    if let Some(content) = &message.content {
        tokens += estimate_tokens(content);
    }
    for call in &message.tool_calls {
        tokens += estimate_tokens(&call.name) + estimate_tokens(&call.arguments);
    }
    if let Some(name) = &message.name {
        tokens += estimate_tokens(name);
    }
    tokens
}

pub(super) fn total_tokens(messages: &[LlmMessage]) -> usize {
    messages.iter().map(message_tokens).sum()
}

/// The curated-local fallback window, used only when the client did not report one
/// (a non-shell host running a curated local model). Only the local (Ollama)
/// provider has the small fixed window that silently front-truncates, and the shell
/// refuses any non-curated local tag — so a curated tag here IS the local path.
/// Cloud (OpenRouter) ids never match the curated list: their window is whatever the
/// client reports from the catalogue (`context_length`), or unknown — and unknown
/// stays inert under the char guards, never guessed.
pub(super) fn context_window_tokens(model: &str) -> Option<usize> {
    crate::ai::local::is_curated_model(model).then_some(LOCAL_CONTEXT_WINDOW_TOKENS)
}

/// The assembled prompt after budgeting to the window, plus whether any content was
/// dropped or truncated (a coverage loss the caller must surface).
pub(super) struct BudgetOutcome {
    pub(super) messages: Vec<LlmMessage>,
    pub(super) lost: bool,
}

/// Budget the fully assembled prompt to the active model's context window (see the
/// section comment above [`LOCAL_CONTEXT_WINDOW_TOKENS`]). The window is the one the
/// client reports it will actually enforce (`reported_window` — the local `num_ctx`,
/// or a cloud model's catalogue `context_length`), falling back to the curated-local
/// default when the client reports none. Grounding (the leading system prefix) and
/// the newest evidence are always preserved; the oldest history/evidence is dropped
/// deterministically as whole protocol units; a lone evidence span larger than the
/// whole window is head-truncated with an explicit marker rather than allowed to push
/// grounding out. A prompt whose window is unknown (a cloud model absent from the
/// catalogue cache) is returned unchanged — inert-with-reason, left to the char
/// guards that bound cloud cost. Trimming only ever REMOVES content, so budgeting
/// can never increase what a call would have sent. The persistent `messages`
/// accumulator is never mutated — this returns the trimmed copy for one request.
pub(super) fn fit_prompt_to_window(
    messages: &[LlmMessage],
    model: &str,
    reported_window: Option<usize>,
) -> BudgetOutcome {
    let Some(window) = reported_window.or_else(|| context_window_tokens(model)) else {
        return BudgetOutcome {
            messages: messages.to_vec(),
            lost: false,
        };
    };
    let budget = window
        .saturating_sub(ANSWER_RESERVE_TOKENS)
        .saturating_sub(PROMPT_OVERHEAD_TOKENS);
    if total_tokens(messages) <= budget {
        return BudgetOutcome {
            messages: messages.to_vec(),
            lost: false,
        };
    }
    trim_to_budget(messages, budget)
}

fn trim_to_budget(messages: &[LlmMessage], budget: usize) -> BudgetOutcome {
    let prefix_len = messages
        .iter()
        .take_while(|m| m.role == Role::System)
        .count();
    let (prefix, rest) = messages.split_at(prefix_len);
    let units = group_units(rest);
    let unit_tokens: Vec<usize> = units
        .iter()
        .map(|u| rest[u.clone()].iter().map(message_tokens).sum())
        .collect();
    // The current user question — the newest User-role unit — anchors the model's
    // intent and is pinned like the grounding prefix.
    let pinned_question = units.iter().rposition(|u| rest[u.start].role == Role::User);

    let mut keep = vec![false; units.len()];
    let mut used: usize = prefix.iter().map(message_tokens).sum();

    // The newest unit (freshest evidence, or the question itself on a conversational
    // turn) and the question are force-kept even if they alone overflow — a single
    // oversized span is head-truncated below, never dropped in favour of older evidence.
    for forced in [units.len().checked_sub(1), pinned_question]
        .into_iter()
        .flatten()
    {
        if !keep[forced] {
            keep[forced] = true;
            used += unit_tokens[forced];
        }
    }
    // Fill the remaining budget with the newest still-fitting history/evidence.
    for i in (0..units.len()).rev() {
        if !keep[i] && used + unit_tokens[i] <= budget {
            used += unit_tokens[i];
            keep[i] = true;
        }
    }

    let mut out = prefix.to_vec();
    let mut lost = false;
    for (i, unit) in units.iter().enumerate() {
        if keep[i] {
            out.extend_from_slice(&rest[unit.clone()]);
        } else {
            lost = true;
        }
    }
    // A single message larger than the whole window still overflows after unit
    // selection. Grounding is the hard invariant, so head-truncate the largest
    // non-system message instead of letting it push grounding out of the window.
    if total_tokens(&out) > budget {
        lost |= truncate_largest_to_fit(&mut out, budget);
    }
    BudgetOutcome {
        messages: out,
        lost,
    }
}

/// Group messages into protocol units so an assistant tool-call turn is never split
/// from its tool results: a unit starts at any non-`Tool` message; `Tool` results
/// attach to the unit before them. Returns index ranges into `messages`.
fn group_units(messages: &[LlmMessage]) -> Vec<std::ops::Range<usize>> {
    let mut units: Vec<std::ops::Range<usize>> = Vec::new();
    for (i, message) in messages.iter().enumerate() {
        if message.role == Role::Tool {
            if let Some(last) = units.last_mut() {
                last.end = i + 1;
                continue;
            }
        }
        units.push(i..i + 1);
    }
    units
}

/// Head-truncate the largest non-system message until the whole prompt fits `budget`,
/// appending [`TRUNCATION_MARKER`]. Returns whether it truncated anything. Never touches
/// a system (grounding) message — grounding is the invariant the whole pass protects.
fn truncate_largest_to_fit(messages: &mut [LlmMessage], budget: usize) -> bool {
    let total = total_tokens(messages);
    if total <= budget {
        return false;
    }
    let Some(idx) = largest_droppable(messages) else {
        return false;
    };
    let content = messages[idx].content.as_deref().unwrap_or_default();
    let current = estimate_tokens(content);
    let overflow = total - budget;
    let marker_tokens = estimate_tokens(TRUNCATION_MARKER);
    let keep_tokens = current
        .saturating_sub(overflow)
        .saturating_sub(marker_tokens);
    messages[idx].content = Some(truncate_content_to_tokens(content, keep_tokens));
    true
}

fn largest_droppable(messages: &[LlmMessage]) -> Option<usize> {
    messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role != Role::System && m.content.is_some())
        .max_by_key(|(_, m)| estimate_tokens(m.content.as_deref().unwrap_or_default()))
        .map(|(i, _)| i)
}

/// Keep the longest head of `content` whose estimate stays within `max_tokens`, then
/// append [`TRUNCATION_MARKER`]. UTF-8-safe: the cut always lands on a char boundary.
fn truncate_content_to_tokens(content: &str, max_tokens: usize) -> String {
    let cap = max_tokens.saturating_mul(ASCII_CHARS_PER_TOKEN);
    let mut sub_tokens = 0usize;
    let mut cut = 0usize;
    for (offset, ch) in content.char_indices() {
        let weight = char_sub_tokens(ch);
        if sub_tokens + weight > cap {
            break;
        }
        sub_tokens += weight;
        cut = offset + ch.len_utf8();
    }
    let mut out = String::with_capacity(cut + TRUNCATION_MARKER.len());
    out.push_str(&content[..cut]);
    out.push_str(TRUNCATION_MARKER);
    out
}
