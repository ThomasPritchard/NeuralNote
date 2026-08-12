const TOP_SCAN_LIMIT = 65_536;

function nextLine(source: string, start: number, limit = source.length): { text: string; next: number } {
  let end = start;
  while (end < limit && source[end] !== "\r" && source[end] !== "\n") end += 1;
  const separatorLength = source[end] === "\r" && source[end + 1] === "\n" && end + 1 < limit
    ? 2
    : end < limit
      ? 1
      : 0;
  return { text: source.slice(start, end), next: end + separatorLength };
}

function bodyStart(source: string): number | null {
  const limit = Math.min(source.length, TOP_SCAN_LIMIT);
  let cursor = source.startsWith("\uFEFF") ? 1 : 0;
  const first = nextLine(source, cursor, limit);
  if (first.text !== "---") return cursor;

  cursor = first.next;
  while (cursor <= limit) {
    const line = nextLine(source, cursor, limit);
    if (line.text === "---" || line.text === "...") return line.next;
    if (line.next <= cursor) break;
    cursor = line.next;
  }
  return null;
}

function isSpaceOrTab(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

/**
 * A heading's text with its optional closing sequence removed — the trailing
 * run of `#` that lets `## Title ##` mean the same as `## Title`, which
 * CommonMark accepts only when preceded by a space or tab.
 *
 * Read backwards from the end, not with `/[ \t]+#+[ \t]*$/` (issue #143,
 * `typescript:S5852`). That pattern is quadratic in the length of the line: it
 * opens a greedy `[ \t]+` run at every whitespace character, consumes the rest
 * of the line, then backtracks a character at a time hunting a `#` that is not
 * there. A heading of `# ` and 64K spaces cost 1.75 s, and `TOP_SCAN_LIMIT` does
 * not save that — it DEFINES it, as the worst case.
 *
 * Backwards is a single pass because the sequence is unique: the pattern is
 * anchored to the end, so the run of `#` it strips can only be the LAST one, and
 * it qualifies only if nothing but spaces and tabs follow it and at least one
 * precedes it. Three reverse runs — trailing space, the hashes, the gap — decide
 * that, and each character is read once. The regex's leftmost-match rule starts
 * the match at the beginning of the maximal gap, which is exactly where the
 * third run stops.
 *
 * Exported with no consumer outside this module, which is a smell worth naming.
 * It is the only place the linearity guarantee can be MEASURED: the heading text
 * arrives here as a fresh primitive out of `RegExp.exec`, so the character-read
 * probe in `sourceDocumentTitle.redos.test.ts` cannot reach it through
 * `sourceTitleMode` and would report a quadratic strip as linear. The stripped
 * text is invisible from outside for the same reason — `leadingH1` reports only
 * whether it is empty — so a differential run through the public function would
 * map almost every input to the same answer.
 *
 * @param text - everything after the opening `#` run and its following spaces
 */
export function withoutAtxClosingSequence(text: string): string {
  let cursor = text.length - 1;
  while (isSpaceOrTab(text[cursor])) cursor -= 1;
  while (text[cursor] === "#") cursor -= 1;

  // One check answers both requirements. Where the gap is missing there is
  // nothing to strip; and where the run of `#` is missing, this cursor never
  // left the non-space character the first run stopped on, so the gap that
  // would have to precede that run is missing with it.
  const beforeGap = cursor;
  while (isSpaceOrTab(text[cursor])) cursor -= 1;
  if (cursor === beforeGap) return text;

  return text.slice(0, cursor + 1);
}

function leadingH1(source: string, start: number): string | null {
  const limit = Math.min(source.length, TOP_SCAN_LIMIT);
  let cursor = start;
  while (cursor < limit) {
    const line = nextLine(source, cursor, limit);
    if (line.text.trim() !== "") break;
    if (line.next <= cursor) return null;
    cursor = line.next;
  }

  const first = nextLine(source, cursor, limit);
  const atx = /^ {0,3}#[ \t]+(.+)$/.exec(first.text);
  if (atx) {
    const text = withoutAtxClosingSequence(atx[1]).trim();
    return text === "" ? null : text;
  }

  const underline = nextLine(source, first.next, limit).text;
  if (/^ {0,3}=+[ \t]*$/.test(underline)) {
    const text = first.text.trim();
    return text === "" ? null : text;
  }
  return null;
}

export type SourceTitleMode = "source" | "placeholder" | "external";

export interface SourceTitleContext {
  readonly documentLength?: number;
  readonly frontmatterError?: boolean;
}

export function sourceTitleMode(
  source: string,
  context: SourceTitleContext = {},
): SourceTitleMode {
  if (context.frontmatterError) return "external";
  const start = bodyStart(source);
  if (start === null) return "external";
  return leadingH1(source, start) === null ? "placeholder" : "source";
}

export interface SourceTitleInsertion {
  readonly from: number;
  readonly insert: string;
  readonly caret: number;
}

export function sourceTitleInsertion(
  source: string,
  title: string,
  context: SourceTitleContext = {},
): SourceTitleInsertion | null {
  if (context.frontmatterError) return null;
  const from = bodyStart(source);
  const safeTitle = title.replace(/[\r\n]+/g, " ").trim();
  if (from === null || leadingH1(source, from) !== null || safeTitle === "") return null;
  const heading = `# ${safeTitle}`;
  const frontmatterOffset = source.startsWith("\uFEFF") ? 1 : 0;
  const hasFrontmatter = nextLine(
    source,
    frontmatterOffset,
    Math.min(source.length, TOP_SCAN_LIMIT),
  ).text === "---";
  const needsLeadingSeparator = hasFrontmatter
    && from > 0
    && source[from - 1] !== "\r"
    && source[from - 1] !== "\n";
  const leadingSeparator = needsLeadingSeparator ? "\n" : "";
  return {
    from,
    insert: `${leadingSeparator}${heading}${from < (context.documentLength ?? source.length) ? "\n\n" : ""}`,
    caret: from + leadingSeparator.length + heading.length,
  };
}
