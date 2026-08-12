/**
 * "Is this still linear?", in a unit a loaded or a faster machine cannot move.
 *
 * An absolute wall-clock budget answers a question about the MACHINE: the same
 * scan that takes 1 ms idle takes 8 ms under load, so any threshold tight enough
 * to catch a regression is loose enough to flake (the reasoning
 * `sourceEditorPerformance.test.ts` already records for its own budgets). A
 * ratio between two input sizes measured in the SAME run cancels the machine
 * out — whatever slows the numerator slows the denominator with it — and leaves
 * a statement about the algorithm's shape. Quadruple the input and a linear scan
 * costs four times as much; a quadratic one costs sixteen.
 *
 * Two details make the ratio trustworthy at the sub-millisecond costs a fixed
 * scan reaches:
 *
 * 1. **Auto-calibration.** Each measurement repeats the work until
 *    {@link CALIBRATION_BUDGET_MS} of wall clock has passed and reports the mean
 *    per-iteration cost, so a 50 µs scan is averaged over hundreds of runs
 *    rather than read off one timer tick. Work that already exceeds the budget
 *    runs once — which is what a REGRESSED implementation does, and at hundreds
 *    of milliseconds a single sample is plenty.
 * 2. **Alternating samples, reduced by median.** A scheduling stall lands inside
 *    one pair, inflating both halves of that one ratio, and the median discards
 *    the pair outright.
 */

/** Long enough to average out timer granularity, short enough to stay cheap. */
const CALIBRATION_BUDGET_MS = 2;

/** Odd, so the median is a measured value rather than an average of two. */
const SAMPLES = 9;

/**
 * The ceiling for a 4x input step: linear work lands at 4, quadratic at 16, and
 * this sits halfway between them on the ratio's own log scale. Matches the
 * `SUPERLINEAR_RATIO` that `sourceEditorPerformance.test.ts` arrived at the same
 * way, deliberately — one project, one bar.
 */
export const SUPERLINEAR_RATIO = 8;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Mean cost of one `work()` call, over as many calls as fit in the budget. */
function iterationCost(work: () => void): number {
  const started = performance.now();
  let iterations = 0;
  let elapsed = 0;
  do {
    work();
    iterations += 1;
    elapsed = performance.now() - started;
  } while (elapsed < CALIBRATION_BUDGET_MS);
  return elapsed / iterations;
}

/**
 * How many times dearer `costlier` is than `cheaper`.
 *
 * @param cheaper - the work at the smaller input size
 * @param costlier - the same work at the larger input size
 * @returns the median of {@link SAMPLES} alternately-measured cost ratios
 */
export function growthRatio(cheaper: () => void, costlier: () => void): number {
  // Warm up: the first call through a function pays for its own JIT compilation,
  // and at these costs that alone would dominate the first sample.
  cheaper();
  costlier();

  const ratios: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const costlierCost = iterationCost(costlier);
    const cheaperCost = iterationCost(cheaper);
    ratios.push(costlierCost / cheaperCost);
  }
  return median(ratios);
}
