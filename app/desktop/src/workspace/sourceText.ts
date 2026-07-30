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

    // A boundary the user just typed inherits from the region they edited, in
    // this order. Absolute byte proximity across the whole document is NOT a
    // candidate: it let a retyped run of LF lines inherit CRLF from an
    // unrelated stray line, writing bytes the user never typed.
    //
    // 1. A separator inside the range this edit replaced — those are precisely
    //    the endings being overwritten, so reusing them is lossless.
    if (range) {
      for (const [index, oldPosition] of oldPositions.entries()) {
        if (oldPosition >= range.oldFrom && oldPosition < range.oldTo) {
          return source.separators[index] ?? source.defaultSeparator;
        }
      }
    }

    // 2. The separator terminating the line the edit landed in — a pure
    //    insertion splits an existing line, so it should end the way that line
    //    already ends.
    const following = oldPositions.findIndex((oldPosition) => oldPosition >= estimatedOldPosition);
    if (following !== -1) return source.separators[following] ?? source.defaultSeparator;

    // 3. The document's prevailing ending (LF when it has none). This is the
    //    plan's documented fallback, and it is now genuinely reachable: the
    //    previous implementation could never get here, so `dominantSeparator`
    //    influenced nothing.
    return source.defaultSeparator;
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
