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

  const changedRanges: Array<{ oldFrom: number; oldTo: number; newFrom: number; newTo: number }> = [];
  changes.iterChanges((oldFrom, oldTo, newFrom, newTo) => {
    changedRanges.push({ oldFrom, oldTo, newFrom, newTo });
  });

  const nextText = changes.apply(Text.of(source.text.split("\n"))).toString();
  const separators = newlinePositions(nextText).map((position) => {
    const retained = preserved.get(position);
    if (retained) return retained;

    const range = changedRanges.find(
      ({ newFrom, newTo }) => position >= newFrom && position < Math.max(newFrom + 1, newTo),
    );
    const estimatedOldPosition = range
      ? range.oldFrom + Math.min(position - range.newFrom, range.oldTo - range.oldFrom)
      : position;

    let nearest: { distance: number; position: number; separator: LineSeparator } | undefined;
    oldPositions.forEach((oldPosition, index) => {
      const candidate = {
        distance: Math.abs(oldPosition - estimatedOldPosition),
        position: oldPosition,
        separator: source.separators[index],
      };
      if (
        !nearest ||
        candidate.distance < nearest.distance ||
        (candidate.distance === nearest.distance && candidate.position < nearest.position)
      ) {
        nearest = candidate;
      }
    });
    return nearest?.separator ?? source.defaultSeparator;
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
