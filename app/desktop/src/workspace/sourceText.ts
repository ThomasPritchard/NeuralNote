import { Text, type ChangeSet } from "@codemirror/state";

export type LineSeparator = "\n" | "\r\n" | "\r";

export interface SourceText {
  readonly text: string;
  readonly separators: readonly LineSeparator[];
  readonly defaultSeparator: LineSeparator;
}

export class SourcePreservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcePreservationError";
  }
}

function newlinePositions(text: string): number[] {
  const positions: number[] = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    positions.push(index);
  }
  return positions;
}

function dominantSeparator(separators: readonly LineSeparator[]): LineSeparator {
  if (separators.length === 0) return "\n";

  const counts = new Map<LineSeparator, number>();
  for (const separator of separators) counts.set(separator, (counts.get(separator) ?? 0) + 1);

  let dominant = separators[0];
  let dominantCount = counts.get(dominant) ?? 0;
  for (const separator of separators) {
    const count = counts.get(separator) ?? 0;
    if (count > dominantCount) {
      dominant = separator;
      dominantCount = count;
    }
  }
  return dominant;
}

function assertValid(source: SourceText): void {
  const boundaryCount = newlinePositions(source.text).length;
  if (boundaryCount !== source.separators.length) {
    throw new SourcePreservationError(
      `Cannot preserve line endings: ${boundaryCount} logical boundaries have ${source.separators.length} separators.`,
    );
  }
}

export function loadSourceText(source: string): SourceText {
  const separators: LineSeparator[] = [];
  const text = source.replace(/\r\n|\r|\n/g, (separator) => {
    separators.push(separator as LineSeparator);
    return "\n";
  });
  return { text, separators, defaultSeparator: dominantSeparator(separators) };
}

/** One replacement reported by `ChangeSet.iterChanges`. */
interface ChangedRange {
  readonly oldFrom: number;
  readonly oldTo: number;
  readonly newFrom: number;
  readonly newTo: number;
}

/** An old newline competing to donate its separator to a rewritten one. */
interface SeparatorCandidate {
  readonly distance: number;
  readonly position: number;
  readonly separator: LineSeparator;
}

/** Where a position in the rewritten span falls back in the span it replaced,
 *  interpolated by length. A pure insertion or a pure deletion has no span to
 *  interpolate across, so it projects onto the start of the change. */
function projectedOldPosition(range: ChangedRange, position: number): number {
  const oldSpan = range.oldTo - range.oldFrom;
  const newSpan = range.newTo - range.newFrom;
  if (oldSpan <= 0 || newSpan <= 0) return range.oldFrom;
  return range.oldFrom + ((position - range.newFrom) / newSpan) * oldSpan;
}

/** Did this change consume the newline that sat at `oldPosition`? An insertion
 *  consumes nothing, so it can only draw on a newline sitting exactly at the
 *  point of insertion. */
function isReplacedBy(range: ChangedRange, oldPosition: number): boolean {
  const isInsideReplacement = oldPosition >= range.oldFrom && oldPosition < range.oldTo;
  const isInsertionAtBoundary = range.oldTo === range.oldFrom
    && oldPosition === range.oldFrom;
  return isInsideReplacement || isInsertionAtBoundary;
}

function isNearer(
  candidate: SeparatorCandidate,
  incumbent: SeparatorCandidate | undefined,
): boolean {
  if (incumbent === undefined) return true;
  if (candidate.distance === incumbent.distance) {
    return candidate.position < incumbent.position;
  }
  return candidate.distance < incumbent.distance;
}

/** The separator a newline written by `range` inherits: the one carried by the
 *  nearest newline that change consumed, ties going to the earliest. Undefined
 *  when the change consumed no newline to inherit from. */
function inheritedSeparator(
  source: SourceText,
  oldPositions: readonly number[],
  range: ChangedRange,
  position: number,
): LineSeparator | undefined {
  const target = projectedOldPosition(range, position);
  let nearest: SeparatorCandidate | undefined;
  for (const [index, oldPosition] of oldPositions.entries()) {
    if (!isReplacedBy(range, oldPosition)) continue;
    const candidate: SeparatorCandidate = {
      distance: Math.abs(oldPosition - target),
      position: oldPosition,
      separator: source.separators[index] ?? source.defaultSeparator,
    };
    if (isNearer(candidate, nearest)) nearest = candidate;
  }
  return nearest?.separator;
}

export function applySourceChanges(source: SourceText, changes: ChangeSet): SourceText {
  assertValid(source);
  if (changes.length !== source.text.length) {
    throw new SourcePreservationError(
      `Cannot preserve line endings: transaction length ${changes.length} does not match source length ${source.text.length}.`,
    );
  }
  if (changes.empty) return source;

  const oldPositions = newlinePositions(source.text);
  const oldSeparators = new Map<number, LineSeparator>();
  oldPositions.forEach((position, index) => oldSeparators.set(position, source.separators[index]));

  const preserved = new Map<number, LineSeparator>();
  changes.iterGaps((oldFrom, newFrom, length) => {
    const oldTo = oldFrom + length;
    for (const position of oldPositions) {
      if (position < oldFrom) continue;
      if (position >= oldTo) break;
      preserved.set(newFrom + position - oldFrom, oldSeparators.get(position)!);
    }
  });

  const changedRanges: ChangedRange[] = [];
  changes.iterChanges((oldFrom, oldTo, newFrom, newTo) => {
    changedRanges.push({ oldFrom, oldTo, newFrom, newTo });
  }, true);

  const nextText = changes.apply(Text.of(source.text.split("\n"))).toString();
  const separators = newlinePositions(nextText).map((position) => {
    const retained = preserved.get(position);
    if (retained) return retained;

    const range = changedRanges.find(
      ({ newFrom, newTo }) => position >= newFrom && position < Math.max(newFrom + 1, newTo),
    );
    if (range === undefined) return source.defaultSeparator;

    return inheritedSeparator(source, oldPositions, range, position)
      ?? source.defaultSeparator;
  });

  return { text: nextText, separators, defaultSeparator: source.defaultSeparator };
}

export function serializeSourceText(source: SourceText): string {
  assertValid(source);
  const lines = source.text.split("\n");
  let serialized = lines[0] ?? "";
  for (let index = 0; index < source.separators.length; index += 1) {
    serialized += source.separators[index] + lines[index + 1];
  }
  return serialized;
}

export function serializeSourceRange(
  source: SourceText,
  from: number,
  to: number,
): string {
  assertValid(source);
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    from > to ||
    to > source.text.length
  ) {
    throw new SourcePreservationError(
      `Cannot preserve source range: [${from}, ${to}) is outside logical length ${source.text.length}.`,
    );
  }

  const selected: string[] = [];
  let separatorIndex = 0;
  for (let index = 0; index < source.text.length; index += 1) {
    const character = source.text[index];
    if (character === "\n") {
      const separator = source.separators[separatorIndex];
      separatorIndex += 1;
      if (index >= from && index < to) selected.push(separator);
    } else if (index >= from && index < to) {
      selected.push(character);
    }
  }
  return selected.join("");
}
