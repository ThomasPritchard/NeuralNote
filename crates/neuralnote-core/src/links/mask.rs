//! Code masking for the link scanner.
//!
//! Blanks out fenced code blocks and inline code spans (space-for-space,
//! newlines kept) so link syntax inside them is ignored — Obsidian behavior.
//! The graph builder in the parent module scans the masked text.

/// Blank out fenced code blocks and inline code spans, space-for-space
/// (newlines kept), so links inside them are ignored — Obsidian behavior.
pub(crate) fn mask_code(body: &str) -> String {
    mask_inline_spans(&mask_fences(body))
}

/// Mask fenced code blocks: a fence opens with ≥3 backticks or tildes and
/// closes only on a run of the SAME character at least as long (CommonMark) —
/// a 3-backtick line inside a 4-backtick fence is content, not a closer. An
/// unclosed fence masks to the end of the body.
fn mask_fences(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut open: Option<(char, usize)> = None;
    for line in body.split_inclusive('\n') {
        let marker = fence_marker(line);
        let masked = match (open, marker) {
            (None, Some(m)) => {
                open = Some(m);
                true
            }
            (None, None) => false,
            (Some((ch, len)), m) => {
                if m.is_some_and(|(c2, l2)| c2 == ch && l2 >= len) {
                    open = None;
                }
                true // opener, interior, and closer lines all mask
            }
        };
        if masked {
            blank_keeping_newlines(line, &mut out);
        } else {
            out.push_str(line);
        }
    }
    out
}

/// The leading code-fence run of a line (``` or ~~~, length ≥ 3), if any.
fn fence_marker(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start();
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let len = trimmed.chars().take_while(|&c| c == first).count();
    (len >= 3).then_some((first, len))
}

/// Blank inline code spans over the WHOLE body — CommonMark spans may cross
/// newlines. A run of N backticks closes on the next run of exactly N; an
/// unmatched opener is copied literally.
fn mask_inline_spans(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '`' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let open_len = backtick_run_len(&chars, i);
        match find_closing_run(&chars, i + open_len, open_len) {
            Some(close_start) => {
                let span_end = close_start + open_len;
                for &c in &chars[i..span_end] {
                    out.push(if c == '\n' || c == '\r' { c } else { ' ' });
                }
                i = span_end;
            }
            None => {
                out.extend(std::iter::repeat_n('`', open_len));
                i += open_len;
            }
        }
    }
    out
}

/// Push `line` as spaces, preserving newline chars so lines never shift.
fn blank_keeping_newlines(line: &str, out: &mut String) {
    for c in line.chars() {
        out.push(if c == '\n' || c == '\r' { c } else { ' ' });
    }
}

fn backtick_run_len(chars: &[char], from: usize) -> usize {
    chars[from..].iter().take_while(|&&c| c == '`').count()
}

/// The start of the next backtick run of exactly `n`, if any.
fn find_closing_run(chars: &[char], from: usize, n: usize) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == '`' {
            let len = backtick_run_len(chars, i);
            if len == n {
                return Some(i);
            }
            i += len;
        } else {
            i += 1;
        }
    }
    None
}
