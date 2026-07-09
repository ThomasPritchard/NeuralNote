// Pure Markdown selection transforms behind the Format menu (Bold / Italic /
// Heading / Link). Each takes the textarea's value + selection and returns the
// new value + selection — no DOM, so they're fully unit-testable. The Editor
// applies the result to its uncontrolled textarea (write `.value`, re-fire
// onChange, restore the selection), exactly like the `[[` autocomplete does.

export interface Selection {
  /** The full textarea value. */
  value: string;
  /** selectionStart. */
  start: number;
  /** selectionEnd (=== start for a bare caret). */
  end: number;
}

export interface FormatResult {
  value: string;
  /** New selectionStart. */
  start: number;
  /** New selectionEnd. */
  end: number;
}

export type FormatAction =
  | "format-bold"
  | "format-italic"
  | "format-h1"
  | "format-h2"
  | "format-h3"
  | "format-link";

/**
 * Wrap the selection in `token` (`**` bold, `*` italic), or unwrap if it's
 * already wrapped. Two unwrap shapes are recognised: tokens sitting just outside
 * the selection (select the word, toggle off), and the selection itself being
 * wrapped (select `**word**`, toggle off). With an empty caret it inserts an
 * empty pair and drops the caret between them, or removes an empty pair around
 * the caret.
 */
export function toggleWrap(sel: Selection, token: string): FormatResult {
  const { value, start, end } = sel;
  const len = token.length;
  const selected = value.slice(start, end);
  const marker = token[0]; // both `*` (italic) and `**` (bold) are runs of `*`

  // Length of the marker run immediately flanking the selection on each side.
  let leftRun = 0;
  while (start - leftRun - 1 >= 0 && value[start - leftRun - 1] === marker) leftRun += 1;
  let rightRun = 0;
  while (end + rightRun < value.length && value[end + rightRun] === marker) rightRun += 1;

  // Outer unwrap — the emphasis of *this* width is already applied by the flanking
  // runs, so toggle it off by removing `len` markers per side (covers the empty
  // caret too). A `*` run encodes italic when its length is odd (1, 3, …) and bold
  // when it is ≥ 2. So italicising a word inside `**bold**` (run 2 — bold, no italic)
  // correctly *adds* a layer → `***bold***` (falls through to wrap), while italicising
  // inside `***bold***` (run 3 — bold + italic) removes just the italic → `**bold**`.
  const italicApplied = leftRun % 2 === 1 && rightRun % 2 === 1;
  const boldApplied = leftRun >= 2 && rightRun >= 2;
  const alreadyApplied = len === 1 ? italicApplied : boldApplied;
  if (leftRun >= len && rightRun >= len && alreadyApplied) {
    return {
      value: value.slice(0, start - len) + selected + value.slice(end + len),
      start: start - len,
      end: end - len,
    };
  }

  // Inner unwrap — the selection itself is wrapped. Guard against stripping one
  // marker off a longer run (e.g. italic over `**bold**`) by refusing when the
  // inner text still begins/ends with the token.
  if (selected.length >= 2 * len && selected.startsWith(token) && selected.endsWith(token)) {
    const inner = selected.slice(len, selected.length - len);
    if (!inner.startsWith(token) && !inner.endsWith(token)) {
      return {
        value: value.slice(0, start) + inner + value.slice(end),
        start,
        end: end - 2 * len,
      };
    }
  }

  // Wrap. The inserted tokens push the selection right by `len`; the selection
  // now covers just the original text (between the new markers).
  return {
    value: value.slice(0, start) + token + selected + token + value.slice(end),
    start: start + len,
    end: end + len,
  };
}

/**
 * Toggle an ATX heading of `level` (1–6) on the line containing the caret.
 * Re-applying the same level removes it; a different level replaces it.
 */
export function toggleHeading(sel: Selection, level: number): FormatResult {
  const { value } = sel;
  const lineStart = value.lastIndexOf("\n", sel.start - 1) + 1;
  const rest = value.slice(lineStart);
  const existing = /^(#{1,6}) /.exec(rest);
  const marker = `${"#".repeat(level)} `;

  let newRest: string;
  if (!existing) {
    newRest = marker + rest;
  } else if (existing[1].length === level) {
    newRest = rest.slice(existing[0].length); // same level → strip
  } else {
    newRest = marker + rest.slice(existing[0].length); // change level
  }

  const delta = newRest.length - rest.length;
  const shift = (pos: number) =>
    pos < lineStart ? pos : Math.max(lineStart, pos + delta);
  return {
    value: value.slice(0, lineStart) + newRest,
    start: shift(sel.start),
    end: shift(sel.end),
  };
}

/**
 * Insert a Markdown link `[text](url)` around the selection. With text selected
 * the caret lands in the empty url slot; with no selection it lands in the empty
 * text slot so the user types the label first.
 */
export function insertLink(sel: Selection): FormatResult {
  const { value, start, end } = sel;
  const text = value.slice(start, end);
  const inserted = `[${text}]()`;
  const caret = text.length === 0 ? start + 1 : start + inserted.length - 1;
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    start: caret,
    end: caret,
  };
}

/** Dispatch a Format menu action to its transform. */
export function applyFormat(action: FormatAction, sel: Selection): FormatResult {
  switch (action) {
    case "format-bold":
      return toggleWrap(sel, "**");
    case "format-italic":
      return toggleWrap(sel, "*");
    case "format-h1":
      return toggleHeading(sel, 1);
    case "format-h2":
      return toggleHeading(sel, 2);
    case "format-h3":
      return toggleHeading(sel, 3);
    case "format-link":
      return insertLink(sel);
  }
}
