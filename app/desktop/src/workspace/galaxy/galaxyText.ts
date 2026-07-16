// Presentation text helpers for the galaxy overlays.

/** "1 note" / "2 notes" — pluralize a noun by count. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
