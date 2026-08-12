/**
 * How many characters a scan actually reads — the property a ReDoS fix is
 * really about, counted instead of timed.
 *
 * The wall-clock version of this check (issue #143) measured a growth RATIO
 * rather than an absolute budget, which held on a quiet machine and still red
 * under fourteen CPU burners on fourteen cores: a 40 µs measurement is far
 * below the scheduler's quantum, so one preemption inside it dwarfs the signal.
 * Issue #100 records macOS CI runners at roughly 10x local, and a gate that
 * reds under contention gets ignored, then disabled, then the regression it
 * guards ships. So there is no clock here at all. Reading a character is an
 * integer event; a saturated machine cannot change how many happen.
 *
 * The input is a `Proxy` over a boxed `String` that counts index reads, so
 * nothing is instrumented in the production path — no counter, no probe
 * parameter, no second copy of the scan to drift from the real one.
 *
 * **A regex reads zero characters through this instrument.** `matchAll` and
 * `replace` coerce their receiver to a primitive first and then backtrack
 * inside the engine, where no `Proxy` can see. That is not a blind spot to
 * paper over: it is why every caller must assert {@link characterReads} saw at
 * least one read per character before trusting a count. Reinstating either
 * regex trips that guard rather than reporting a flattering zero.
 */

/**
 * The ceiling for a 4x input step: linear work lands at 4, quadratic at 16, and
 * this sits halfway between them on the ratio's own log scale. The count is an
 * exact integer, so unlike its wall-clock predecessor this bound is not
 * absorbing measurement noise — it is leaving room for an honest constant
 * factor, and the observed ratios sit at 3.999.
 */
export const LINEAR_GROWTH_CEILING = 8;

/**
 * A stand-in for `input` that reports every index read.
 *
 * `String.prototype` methods reject a `Proxy` as their `this`, so each method
 * comes back bound to the underlying primitive. Work done inside `slice` is
 * therefore uncounted — acceptable, because a scan's cost lives in how many
 * characters it VISITS, and unavoidable without reimplementing `String`.
 */
function countingProxy(input: string, onRead: () => void): string {
  const boxed = Object(input) as object;
  const proxy = new Proxy(boxed, {
    get(target, key) {
      if (typeof key === "string" && /^\d+$/.test(key)) onRead();
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(input)
        : value;
    },
  });
  return proxy as unknown as string;
}

/**
 * The number of characters `scan` reads out of `input`.
 *
 * @param scan - the scan under test, called with a counting stand-in
 * @param input - the text to scan
 * @returns how many index reads the scan performed
 */
export function characterReads(scan: (input: string) => unknown, input: string): number {
  let reads = 0;
  scan(countingProxy(input, () => { reads += 1; }));
  return reads;
}
