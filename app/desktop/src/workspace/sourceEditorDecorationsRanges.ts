import type { VisibleRange } from "./sourceEditorDecorationsTypes";

export function mergeVisibleRanges(
  ranges: readonly VisibleRange[],
  docLength: number,
  margin = 0,
): VisibleRange[] {
  const ordered = ranges
    .map(({ from, to }) => ({
      from: Math.max(0, Math.min(docLength, from - margin)),
      to: Math.max(0, Math.min(docLength, to + margin)),
    }))
    .filter((range) => range.from <= range.to)
    .sort((left, right) => left.from - right.from);
  const merged: VisibleRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: Math.max(previous.to, range.to) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

export function insideVisibleRanges(
  from: number,
  to: number,
  ranges: readonly VisibleRange[],
): boolean {
  return ranges.some((range) => from >= range.from && to <= range.to);
}

export function intersectsVisibleRanges(
  from: number,
  to: number,
  ranges: readonly VisibleRange[],
): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}
