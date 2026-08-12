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
const LEAD_CAPTURE_LIMIT = 1_024;

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
  let leadStarted = false;
  let leadFinished = false;
  let capturedLength = 0;
  const leadParts: string[] = [];

  for (let start = 0; start <= body.length; ) {
    const newline = body.indexOf("\n", start);
    const end = newline === -1 ? body.length : newline;
    const lineEnd = end > start && body.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const line = body.slice(start, lineEnd);
    const fence = fenceMarker(line);

    if (fence) {
      if (!openFence) {
        openFence = fence;
      } else if (
        fence.closing &&
        fence.character === openFence.character &&
        fence.length >= openFence.length
      ) {
        openFence = null;
      }
    } else if (!openFence) {
      const bounds = trimmedBounds(line);
      if (atxHeading(line)) {
        sectionCount += 1;
      } else if (bounds) {
        wordCount += countWords(line, bounds.start, bounds.end);
        if (!leadFinished && capturedLength < LEAD_CAPTURE_LIMIT) {
          const remaining = LEAD_CAPTURE_LIMIT - capturedLength;
          const fragment = cleanInlineMarkdown(
            line.slice(bounds.start, Math.min(bounds.end, bounds.start + remaining)),
          );
          if (fragment) {
            leadParts.push(fragment);
            capturedLength += fragment.length + 1;
            leadStarted = true;
          }
        }
      } else if (leadStarted) {
        leadFinished = true;
      }
    }

    if (newline === -1) break;
    start = newline + 1;
  }

  const passage = leadParts.join(" ").replace(/\s+/g, " ").trim() || "No readable text.";
  const firstSentence = /^.*?(?:[.!?](?:\s|$)|[。！？])/u.exec(passage)?.[0]?.trim();
  return {
    lead: truncateAtWord(firstSentence || passage, leadCharacterLimit),
    sectionCount,
    wordCount,
    readingMinutes: Math.max(1, Math.ceil(wordCount / 220)),
  };
}

interface FenceMarker {
  character: "`" | "~";
  length: number;
  closing: boolean;
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

function trimmedBounds(value: string): { start: number; end: number } | null {
  let start = 0;
  let end = value.length;
  while (start < end && isWhitespace(value.charCodeAt(start))) start += 1;
  while (end > start && isWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return start === end ? null : { start, end };
}

function countWords(value: string, start: number, end: number): number {
  let words = 0;
  let insideWord = false;
  for (let index = start; index < end; index += 1) {
    if (isWhitespace(value.charCodeAt(index))) {
      insideWord = false;
    } else if (!insideWord) {
      words += 1;
      insideWord = true;
    }
  }
  return words;
}

function isWhitespace(code: number): boolean {
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

/** Small inline-Markdown projection for the already bounded lead fragment. */
function cleanInlineMarkdown(value: string): string {
  const output: string[] = [];
  let index = 0;

  if (value[index] === ">") {
    index += 1;
    if (value[index] === " " || value[index] === "\t") index += 1;
  } else if (
    (value[index] === "-" || value[index] === "*" || value[index] === "+") &&
    (value[index + 1] === " " || value[index + 1] === "\t")
  ) {
    index += 2;
  } else {
    let digitEnd = index;
    while (digitEnd < value.length && value.charCodeAt(digitEnd) >= 48 && value.charCodeAt(digitEnd) <= 57) {
      digitEnd += 1;
    }
    if (
      digitEnd > index &&
      value[digitEnd] === "." &&
      (value[digitEnd + 1] === " " || value[digitEnd + 1] === "\t")
    ) {
      index = digitEnd + 2;
    }
  }

  while (index < value.length) {
    const image = value[index] === "!" && value[index + 1] === "[";
    const linkStart = image ? index + 1 : index;
    if (value[linkStart] === "[" && value[linkStart + 1] === "[") {
      const close = value.indexOf("]]", linkStart + 2);
      if (close !== -1) {
        const content = value.slice(linkStart + 2, close);
        const alias = content.indexOf("|");
        output.push(alias === -1 ? content : content.slice(alias + 1));
        index = close + 2;
        continue;
      }
    } else if (value[linkStart] === "[") {
      const labelEnd = value.indexOf("]", linkStart + 1);
      if (labelEnd !== -1 && value[labelEnd + 1] === "(") {
        const targetEnd = value.indexOf(")", labelEnd + 2);
        if (targetEnd !== -1) {
          output.push(value.slice(linkStart + 1, labelEnd));
          index = targetEnd + 1;
          continue;
        }
      }
    }

    const character = value[index];
    if (character !== "*" && character !== "_" && character !== "~" && character !== "`") {
      output.push(character);
    }
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
