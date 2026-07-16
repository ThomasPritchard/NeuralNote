// Markdown text primitives shared by the search and link-graph mirrors
// (crates/neuralnote-core/src/search.rs + links.rs). Offsets are Unicode CODE
// POINTS (`Array.from`), matching the Rust side's char (scalar-value) offsets —
// never UTF-16 units. Each helper names the core function it mirrors; keep them
// in lockstep.

export const SNIPPET_MAX_CHARS = 200;

/** Mirror of core `fold_char`: full per-char Unicode lowercasing (which may
 *  EXPAND, e.g. İ → i + combining dot) plus Greek final-sigma normalisation
 *  (ς → σ). Applied per code point, as core folds char-by-char — the
 *  whole-string context-sensitive final-sigma rule can't fire. */
export const foldChar = (cp: string): string[] =>
  Array.from(cp.toLowerCase(), (c) => (c === "ς" ? "σ" : c));

/** Mirror of core `fold`. */
export const fold = (s: string): string[] => Array.from(s).flatMap(foldChar);

/** Mirror of core `FoldedLine`/`fold_line`: the folded code points plus the
 *  original char index each folded code point came from (pushed once per
 *  emitted code point, so expansions like İ → 2 chars stay mapped). No byte
 *  bookkeeping — JS slices code-point arrays directly. */
export interface FoldedLine {
  folded: string[];
  foldOrigin: number[];
}

export const foldLine = (lineCps: string[]): FoldedLine => {
  const folded: string[] = [];
  const foldOrigin: number[] = [];
  for (let charIdx = 0; charIdx < lineCps.length; charIdx += 1) {
    for (const lc of foldChar(lineCps[charIdx])) {
      folded.push(lc);
      foldOrigin.push(charIdx);
    }
  }
  return { folded, foldOrigin };
};

/** Mirror of core `build_snippet`: the whole line when short, else a
 *  SNIPPET_MAX_CHARS-wide window centered on the first match (clamped to the
 *  line). Ranges are rebased to the window; a range straddling a window edge
 *  is CLIPPED to its visible part, and only fully-outside ranges are dropped —
 *  so the first match always yields a range, even when wider than the window. */
export const buildSnippet = (
  lineCps: string[],
  occs: [number, number][],
): { snippet: string; ranges: [number, number][] } => {
  if (lineCps.length <= SNIPPET_MAX_CHARS) {
    return { snippet: lineCps.join(""), ranges: occs };
  }
  const [a, b] = occs[0];
  const start = Math.min(
    Math.max(Math.floor((a + b) / 2) - SNIPPET_MAX_CHARS / 2, 0),
    lineCps.length - SNIPPET_MAX_CHARS,
  );
  const end = start + SNIPPET_MAX_CHARS;
  const ranges: [number, number][] = [];
  for (const [x, y] of occs) {
    const cx = Math.max(x, start);
    const cy = Math.min(y, end);
    if (cx < cy) ranges.push([cx - start, cy - start]);
  }
  return { snippet: lineCps.slice(start, end).join(""), ranges };
};

// ── Code masking (crates/neuralnote-core/src/links.rs) ───────────────────────

/** Mirror of core `fence_marker`: the leading code-fence run of a line
 *  (``` or ~~~, length ≥ 3), if any. */
const fenceMarker = (line: string): [string, number] | null => {
  const trimmed = line.trimStart();
  const first = trimmed.charAt(0);
  if (first !== "`" && first !== "~") return null;
  let len = 1;
  while (len < trimmed.length && trimmed.charAt(len) === first) len += 1;
  return len >= 3 ? [first, len] : null;
};

/** Mirror of core `blank_keeping_newlines`: spaces, newline chars preserved
 *  so lines never shift. */
const blankKeepingNewlines = (line: string): string =>
  Array.from(line, (c) => (c === "\n" || c === "\r" ? c : " ")).join("");

/** Mirror of core `mask_fences`: fences are LINE-anchored (a mid-line ``` is
 *  not a fence), open with ≥3 backticks or tildes, and close only on a run of
 *  the SAME char at least as long (CommonMark) — a 3-backtick line inside a
 *  4-backtick fence is content, not a closer. An unclosed fence masks to the
 *  end of the body; opener, interior, and closer lines all mask. */
const maskFences = (body: string): string => {
  let out = "";
  let open: [string, number] | null = null;
  // split_inclusive('\n'): each piece keeps its trailing newline.
  for (const line of body.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    const marker = fenceMarker(line);
    let masked: boolean;
    if (open === null) {
      masked = marker !== null;
      if (marker !== null) open = marker;
    } else {
      if (marker !== null && marker[0] === open[0] && marker[1] >= open[1]) {
        open = null;
      }
      masked = true; // opener, interior, and closer lines all mask
    }
    out += masked ? blankKeepingNewlines(line) : line;
  }
  return out;
};

/** Mirror of core `backtick_run_len`. */
const backtickRunLen = (chars: string[], from: number): number => {
  let len = 0;
  while (from + len < chars.length && chars[from + len] === "`") len += 1;
  return len;
};

/** Mirror of core `find_closing_run`: the start of the next backtick run of
 *  EXACTLY `n`, if any. */
const findClosingRun = (chars: string[], from: number, n: number): number | null => {
  let i = from;
  while (i < chars.length) {
    if (chars[i] === "`") {
      const len = backtickRunLen(chars, i);
      if (len === n) return i;
      i += len;
    } else {
      i += 1;
    }
  }
  return null;
};

/** Mirror of core `mask_inline_spans`: whole-body backtick-run spans that may
 *  cross newlines — a run of N backticks closes on the next run of exactly N;
 *  an unmatched opener is copied literally; newlines preserved. */
const maskInlineSpans = (text: string): string => {
  const chars = Array.from(text);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== "`") {
      out += chars[i];
      i += 1;
      continue;
    }
    const openLen = backtickRunLen(chars, i);
    const closeStart = findClosingRun(chars, i + openLen, openLen);
    if (closeStart === null) {
      out += "`".repeat(openLen);
      i += openLen;
    } else {
      const spanEnd = closeStart + openLen;
      for (; i < spanEnd; i += 1) {
        out += chars[i] === "\n" || chars[i] === "\r" ? chars[i] : " ";
      }
    }
  }
  return out;
};

/** Mirror of core `mask_code`: fences first, then inline spans. */
export const maskCode = (body: string): string => maskInlineSpans(maskFences(body));
