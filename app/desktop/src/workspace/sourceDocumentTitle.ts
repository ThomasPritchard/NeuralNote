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
    const text = atx[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
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
