// The live head's clock and its "still working" notice, as pure arithmetic over
// the three timestamps the fold stamps. Every case is expressed as a state
// transition at an explicit `now`, never as a wall-clock wait.

import { describe, expect, it } from "vitest";
import { emptyAssistant, type AssistantMessage } from "./chatMessage";
import { STALL_AFTER_MS, turnLiveness } from "./turnLiveness";

const START = 1_000_000;

/** A live turn whose first event landed at `START`. */
function running(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    ...emptyAssistant(),
    startedAt: START,
    lastEventAt: START,
    lastAliveAt: START,
    ...overrides,
  };
}

describe("turnLiveness", () => {
  it("reports no elapsed time before the first event", () => {
    // Zero would render as a measurement of a run that has taken no time. The
    // run has not started reporting yet, which is a different statement.
    expect(turnLiveness(emptyAssistant(), START).elapsedMs).toBeNull();
  });

  it("counts from the first event, not from the render", () => {
    expect(turnLiveness(running(), START + 3_500).elapsedMs).toBe(3_500);
  });

  it("stays quiet until the stall threshold and then says so", () => {
    const turn = running();

    expect(turnLiveness(turn, START + STALL_AFTER_MS - 1).stalled).toBe(false);
    expect(turnLiveness(turn, START + STALL_AFTER_MS).stalled).toBe(true);
  });

  it("keeps a keepalive from clearing a stall it did not resolve", () => {
    // A keepalive says the socket is alive, not that anything progressed. If it
    // cleared the notice, a provider that emits comment lines forever would
    // silently look busy forever.
    const alive = running({ lastAliveAt: START + STALL_AFTER_MS });

    const liveness = turnLiveness(alive, START + STALL_AFTER_MS);

    expect(liveness.stalled).toBe(true);
    expect(liveness.silent).toBe(false);
  });

  it("separates a provider that has gone quiet from one still checking in", () => {
    // The two sentences the head has to tell apart: "still working, nothing new
    // for a while" and "nothing at all has arrived".
    expect(turnLiveness(running(), START + STALL_AFTER_MS).silent).toBe(true);
  });

  it("clears the notice on the next real event", () => {
    const progressed = running({
      lastEventAt: START + STALL_AFTER_MS,
      lastAliveAt: START + STALL_AFTER_MS,
    });

    expect(turnLiveness(progressed, START + STALL_AFTER_MS + 1).stalled).toBe(false);
  });

  it("never calls a settled turn stalled", () => {
    // The head is gone by then, but a turn that ended is not a turn that hung,
    // and nothing should be able to render it as one.
    const settled = running({ done: true });

    expect(turnLiveness(settled, START + STALL_AFTER_MS * 10).stalled).toBe(false);
  });

  it("hands the clock over to the backend's number once the run settles", () => {
    // `usage.elapsedMs` is measured in Rust across the whole run and is the
    // authoritative figure.
    const settled = running({
      lastEventAt: START + 9_000,
      done: true,
      usage: { elapsedMs: 9_400, tokensIn: null, tokensOut: null, model: "m" },
    });

    expect(turnLiveness(settled, START + 60_000).elapsedMs).toBe(9_400);
  });

  it("never lets the settled number rewind the one already on screen", () => {
    // The client starts counting when the first event lands and the backend
    // counts from the run's own start, so the two can disagree by a little. A
    // clock that jumps backwards at the finish line reads as a bug, so the
    // larger of the two wins — measured from stored timestamps, never from the
    // render clock, so re-rendering the turn an hour later shows the same
    // number.
    const settled = running({
      lastEventAt: START + 9_000,
      done: true,
      usage: { elapsedMs: 8_100, tokensIn: null, tokensOut: null, model: "m" },
    });

    expect(turnLiveness(settled, START + 9_050).elapsedMs).toBe(9_000);
    expect(turnLiveness(settled, START + 3_600_000).elapsedMs).toBe(9_000);
  });
});
