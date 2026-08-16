export interface LocalNoteDigest {
  lead: string;
  sectionCount: number;
  wordCount: number;
  readingMinutes: number;
}

export interface NotePreviewMetrics {
  width: number;
  height: number;
  compact: boolean;
  tight: boolean;
  toolbarClearance: number;
}

export interface NotePreviewPlacement {
  anchorX: number;
  anchorY: number;
  bubbleX: number;
  bubbleY: number;
  tetherLength: number;
  tetherAngle: number;
}

export const GALAXY_COMPACT_TOOLBAR_WIDTH = 760;

const CANVAS_MARGIN = 14;
const TOOLBAR_CLEARANCE = 82;
const STACKED_TOOLBAR_CLEARANCE = 132;
const TETHER_GAP = 48;
const TIGHT_TETHER_GAP = 14;
const PLACEMENT_EPSILON = 0.01;
const LEAD_CHARACTER_LIMIT = 132;

/** UTF-16 units of the opening passage that enter Markdown cleanup. Exported so
 * a test probing the capture boundary walks the real budget rather than a copy
 * of it that silently stops overlapping when this number changes. */
export const LEAD_CAPTURE_LIMIT = 1_024;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/** Build the deliberately small, deterministic digest shown over the graph.
 * No provider is involved: this is derived entirely from the note body already
 * returned by the local read boundary.
 *
 * The body can legally be several MiB, so statistics use one bounded-memory
 * line scan. Only the first prose passage (capped at LEAD_CAPTURE_LIMIT) enters
 * Markdown cleanup; hostile unmatched-link text can therefore never trigger a
 * body-sized backtracking or repeated-scan cost. */
export function buildLocalNoteDigest(
  body: string,
  leadCharacterLimit = LEAD_CHARACTER_LIMIT,
): LocalNoteDigest {
  let sectionCount = 0;
  let wordCount = 0;
  let openFence: FenceMarker | null = null;
  const lead = new LeadPassage();

  for (const line of noteLines(body)) {
    const fence = fenceMarker(line);
    if (fence) {
      openFence = nextFenceState(openFence, fence);
      continue;
    }
    if (openFence) continue;

    const bounds = trimmedBounds(line);
    if (atxHeading(line)) {
      sectionCount += 1;
    } else if (bounds) {
      wordCount += countWords(line, bounds.start, bounds.end);
      lead.offer(line, bounds);
    } else {
      lead.closeOnBlankLine();
    }
  }

  const passage = lead.text();
  const firstSentence = /^.*?(?:[.!?](?:\s|$)|[。！？])/u.exec(passage)?.[0]?.trim();
  return {
    lead: truncateAtWord(firstSentence || passage, leadCharacterLimit),
    sectionCount,
    wordCount,
    readingMinutes: Math.max(1, Math.ceil(wordCount / 220)),
  };
}

/** Yield the body one line at a time, stripping the CR of a CRLF pair, without
 * ever holding more than a single line beyond the body itself. */
function* noteLines(body: string): Generator<string> {
  for (let start = 0; start <= body.length; ) {
    const newline = body.indexOf("\n", start);
    const end = newline === -1 ? body.length : newline;
    const lineEnd = end > start && body[end - 1] === "\r" ? end - 1 : end;
    yield body.slice(start, lineEnd);
    if (newline === -1) return;
    start = newline + 1;
  }
}

/** The note's opening prose passage, accumulated under a fixed capture budget
 * so a multi-MiB body never becomes a multi-MiB string. */
class LeadPassage {
  private readonly parts: string[] = [];
  private capturedLength = 0;
  private started = false;
  private finished = false;

  /** Take the trimmed prose of one line. Ignored once the passage has closed or
   * the budget is spent, and never captures a character it cannot hold whole. */
  offer(line: string, bounds: { start: number; end: number }): void {
    if (this.finished || this.capturedLength >= LEAD_CAPTURE_LIMIT) return;
    const remaining = LEAD_CAPTURE_LIMIT - this.capturedLength;
    const captureEnd = wholeCodePointEnd(
      line,
      Math.min(bounds.end, bounds.start + remaining),
    );
    const fragment = cleanInlineMarkdown(line.slice(bounds.start, captureEnd));
    if (!fragment) return;
    this.parts.push(fragment);
    this.capturedLength += fragment.length + 1;
    this.started = true;
  }

  /** A blank line ends the opening passage, but only once it has begun. */
  closeOnBlankLine(): void {
    if (this.started) this.finished = true;
  }

  text(): string {
    return (
      this.parts.join(" ").replace(/\s+/g, " ").trim() || "No readable text."
    );
  }
}

interface FenceMarker {
  character: "`" | "~";
  length: number;
  closing: boolean;
}

/** A fence opens a block when none is open, and only a longer-or-equal run of
 * the same character with nothing after it closes the one already open. */
function nextFenceState(
  open: FenceMarker | null,
  fence: FenceMarker,
): FenceMarker | null {
  if (!open) return fence;
  const closes =
    fence.closing &&
    fence.character === open.character &&
    fence.length >= open.length;
  return closes ? null : open;
}

function fenceMarker(line: string): FenceMarker | null {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  const character = line[index];
  if (character !== "`" && character !== "~") return null;
  let end = index;
  while (line[end] === character) end += 1;
  if (end - index < 3) return null;
  let suffix = end;
  while (line[suffix] === " " || line[suffix] === "\t") suffix += 1;
  return {
    character,
    length: end - index,
    closing: suffix === line.length,
  };
}

function atxHeading(line: string): boolean {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  const start = index;
  while (index < line.length && line[index] === "#" && index - start < 6) index += 1;
  const count = index - start;
  return (
    count >= 1 &&
    count <= 6 &&
    (index === line.length || line[index] === " " || line[index] === "\t")
  );
}

/** Pull a cut index back off the trailing half of a surrogate pair, so the
 * capture budget never emits a character it could not hold whole.
 *
 * `codePointAt(end - 1)` exceeds the BMP exactly when that unit is a high
 * surrogate whose low surrogate sits at `end` — which is precisely the case
 * where slicing at `end` would strand an unpaired half in the lead. */
function wholeCodePointEnd(value: string, end: number): number {
  const straddlesPair = (value.codePointAt(end - 1) ?? 0) > 0xffff;
  return straddlesPair ? end - 1 : end;
}

function trimmedBounds(value: string): { start: number; end: number } | null {
  let start = 0;
  let end = value.length;
  while (start < end && isWhitespaceCodePoint(value.codePointAt(start))) start += 1;
  while (end > start && isWhitespaceCodePoint(value.codePointAt(end - 1))) end -= 1;
  return start === end ? null : { start, end };
}

function countWords(value: string, start: number, end: number): number {
  let words = 0;
  let insideWord = false;
  for (let index = start; index < end; ) {
    const code = value.codePointAt(index);
    if (isWhitespaceCodePoint(code)) {
      insideWord = false;
    } else if (!insideWord) {
      words += 1;
      insideWord = true;
    }
    index += unitLength(code);
  }
  return words;
}

/** UTF-16 units a code point occupies. Astral characters take two, so a scan
 * reading whole code points must advance by this rather than by one. Unreadable
 * indices report one unit, which keeps every caller's loop advancing. */
function unitLength(code: number | undefined): number {
  return code !== undefined && code > 0xffff ? 2 : 1;
}

/** Whitespace and C0 controls, by code point. Every member is in the BMP, so an
 * astral character can never be mistaken for a word break. */
function isWhitespaceCodePoint(code: number | undefined): boolean {
  if (code === undefined) return false;
  return (
    code <= 0x20 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Only ASCII digits open a Markdown ordered-list marker. A full-width numeral
 * is ordinary prose and must survive into the lead. Reading past the end yields
 * `undefined`, which ends the scan. */
function isAsciiDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

const EMPHASIS_MARKERS = new Set(["*", "_", "~", "`"]);
const BULLET_MARKERS = new Set(["-", "*", "+"]);

const isSpaceOrTab = (character: string | undefined) =>
  character === " " || character === "\t";

/** Index of the first prose character, past any blockquote, bullet or ordered
 * list marker opening the line. */
function blockMarkerEnd(value: string): number {
  if (value.startsWith(">")) return isSpaceOrTab(value[1]) ? 2 : 1;
  if (BULLET_MARKERS.has(value[0]) && isSpaceOrTab(value[1])) return 2;
  return orderedMarkerEnd(value);
}

/** Length of a `12. ` style ordered-list marker, or 0 when the line opens with
 * something else. */
function orderedMarkerEnd(value: string): number {
  let digitEnd = 0;
  while (isAsciiDigit(value[digitEnd])) digitEnd += 1;
  const marked =
    digitEnd > 0 && value[digitEnd] === "." && isSpaceOrTab(value[digitEnd + 1]);
  return marked ? digitEnd + 2 : 0;
}

interface InlineLink {
  text: string;
  end: number;
}

/** Read the link starting at `index` — Obsidian wiki link or Markdown inline
 * link, image `!` included — or null when nothing there parses as one. */
function linkAt(value: string, index: number): InlineLink | null {
  const image = value[index] === "!" && value[index + 1] === "[";
  const start = image ? index + 1 : index;
  if (value[start] !== "[") return null;
  return value[start + 1] === "["
    ? wikiLinkAt(value, start)
    : inlineLinkAt(value, start);
}

/** `[[Target|alias]]` — the alias wins when present, else the whole target. */
function wikiLinkAt(value: string, start: number): InlineLink | null {
  const close = value.indexOf("]]", start + 2);
  if (close === -1) return null;
  const content = value.slice(start + 2, close);
  const alias = content.indexOf("|");
  return {
    text: alias === -1 ? content : content.slice(alias + 1),
    end: close + 2,
  };
}

/** `[label](target)` — only the label survives into the lead. */
function inlineLinkAt(value: string, start: number): InlineLink | null {
  const labelEnd = value.indexOf("]", start + 1);
  if (labelEnd === -1 || value[labelEnd + 1] !== "(") return null;
  const targetEnd = value.indexOf(")", labelEnd + 2);
  if (targetEnd === -1) return null;
  return { text: value.slice(start + 1, labelEnd), end: targetEnd + 1 };
}

/** Small inline-Markdown projection for the already bounded lead fragment.
 *
 * Copies whole UTF-16 units, so a surrogate pair always travels together: the
 * only place a character can be cut in half is the capture budget, which
 * `wholeCodePointEnd` guards. */
function cleanInlineMarkdown(value: string): string {
  const output: string[] = [];
  let index = blockMarkerEnd(value);

  while (index < value.length) {
    const link = linkAt(value, index);
    if (link) {
      output.push(link.text);
      index = link.end;
      continue;
    }

    const character = value[index];
    if (!EMPHASIS_MARKERS.has(character)) output.push(character);
    index += 1;
  }

  return output.join("").replace(/\s+/g, " ").trim();
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), ({ segment }) => segment);
  }
  return Array.from(value);
}

function truncateAtWord(value: string, limit: number): string {
  const units = graphemes(value);
  if (units.length <= limit) return value;
  const candidate = units.slice(0, limit + 1);
  let lastSpace = -1;
  for (let index = 0; index < candidate.length; index += 1) {
    if (/\s/u.test(candidate[index])) lastSpace = index;
  }
  const cutAt = lastSpace > limit * 0.65 ? lastSpace : limit;
  return `${candidate.slice(0, cutAt).join("").trimEnd()}…`;
}

export function notePreviewMetrics(width: number, height: number): NotePreviewMetrics {
  const compact = width < GALAXY_COMPACT_TOOLBAR_WIDTH || height < 500;
  const tight = width < 300;
  const toolbarClearance =
    width < GALAXY_COMPACT_TOOLBAR_WIDTH ? STACKED_TOOLBAR_CLEARANCE : TOOLBAR_CLEARANCE;
  const availableWidth = Math.max(0, width - CANVAS_MARGIN * (tight ? 3 : 2));
  return {
    width: Math.min(compact ? 260 : 304, availableWidth),
    height: Math.min(
      compact ? 292 : 432,
      Math.max(0, height - toolbarClearance - CANVAS_MARGIN),
    ),
    compact,
    tight,
    toolbarClearance,
  };
}

/** Horizontal screen coordinate reserved for the selected star when a stacked
 * toolbar leaves insufficient room for a centred star plus its bubble. */
export function notePreviewFocusScreenX(
  width: number,
  metrics: NotePreviewMetrics,
): number | null {
  if (width >= GALAXY_COMPACT_TOOLBAR_WIDTH) return null;
  const gap = metrics.tight ? TIGHT_TETHER_GAP : TETHER_GAP;
  return clamp(
    width - CANVAS_MARGIN - metrics.width - gap,
    CANVAS_MARGIN,
    width / 2,
  );
}

/** Place the preview beside its selected star, then clamp it within the graph
 * pane. A user-dragged position follows the same bounds. */
export function notePreviewPlacement(
  anchor: { x: number; y: number },
  metrics: NotePreviewMetrics,
  width: number,
  height: number,
  draggedPosition?: { x: number; y: number } | null,
): NotePreviewPlacement {
  const anchorX = clamp(anchor.x, 0, width);
  const anchorY = clamp(anchor.y, 0, height);
  const maxBubbleX = Math.max(CANVAS_MARGIN, width - metrics.width - CANVAS_MARGIN);
  const maxBubbleY = Math.max(
    metrics.toolbarClearance,
    height - metrics.height - CANVAS_MARGIN,
  );
  const tetherGap = metrics.tight ? TIGHT_TETHER_GAP : TETHER_GAP;
  const rightX = anchorX + tetherGap;
  const leftX = anchorX - tetherGap - metrics.width;
  const canOpenRight =
    rightX + metrics.width <= width - CANVAS_MARGIN + PLACEMENT_EPSILON;
  const canOpenLeft = leftX >= CANVAS_MARGIN - PLACEMENT_EPSILON;

  let bubbleX: number;
  let bubbleY: number;
  if (draggedPosition) {
    bubbleX = clamp(draggedPosition.x, CANVAS_MARGIN, maxBubbleX);
    bubbleY = clamp(draggedPosition.y, metrics.toolbarClearance, maxBubbleY);
  } else if (canOpenRight || canOpenLeft) {
    bubbleX = clamp(canOpenRight ? rightX : leftX, CANVAS_MARGIN, maxBubbleX);
    bubbleY = clamp(
      anchorY - metrics.height * 0.28,
      metrics.toolbarClearance,
      maxBubbleY,
    );
  } else {
    bubbleX = clamp(anchorX - metrics.width / 2, CANVAS_MARGIN, maxBubbleX);
    const belowY = anchorY + tetherGap;
    const aboveY = anchorY - tetherGap - metrics.height;
    if (belowY <= maxBubbleY) {
      bubbleY = belowY;
    } else if (aboveY >= metrics.toolbarClearance) {
      bubbleY = aboveY;
    } else {
      const spaceAbove = anchorY - metrics.toolbarClearance;
      const spaceBelow = height - CANVAS_MARGIN - anchorY;
      bubbleY = spaceBelow >= spaceAbove ? maxBubbleY : metrics.toolbarClearance;
    }
  }

  const connectX = clamp(anchorX, bubbleX, bubbleX + metrics.width);
  const connectY = clamp(anchorY, bubbleY + 18, bubbleY + metrics.height - 18);
  const dx = connectX - anchorX;
  const dy = connectY - anchorY;
  return {
    anchorX,
    anchorY,
    bubbleX,
    bubbleY,
    tetherLength: Math.hypot(dx, dy),
    tetherAngle: Math.atan2(dy, dx),
  };
}
