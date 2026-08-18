// The ticking half of the live readout. Every assertion here is about a state
// transition driven by an advanced fake clock — never about a real wait, which
// would make the suite slow and flaky at once.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyAssistant, type AssistantMessage } from "./chatMessage";
import { STALL_AFTER_MS, useTurnLiveness } from "./turnLiveness";

const START = 1_000_000;

function running(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    ...emptyAssistant(),
    startedAt: START,
    lastEventAt: START,
    lastAliveAt: START,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useTurnLiveness", () => {
  it("advances the readout once a second while the run is live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const { result } = renderHook(() => useTurnLiveness(running(), true));

    expect(result.current.elapsedMs).toBe(0);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(result.current.elapsedMs).toBe(3_000);
  });

  it("raises the stall notice from the tick, with no event to prompt it", () => {
    // The whole point: nothing arrives, so nothing but the clock can notice.
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const { result } = renderHook(() => useTurnLiveness(running(), true));

    expect(result.current.stalled).toBe(false);

    act(() => {
      vi.advanceTimersByTime(STALL_AFTER_MS);
    });

    expect(result.current.stalled).toBe(true);
    expect(result.current.silent).toBe(true);
  });

  it("stops ticking once the run is no longer live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) => useTurnLiveness(running(), live),
      { initialProps: { live: true } },
    );

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    rerender({ live: false });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(result.current.elapsedMs).toBe(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands over to the backend's settled figure without rewinding", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const { result, rerender } = renderHook(
      ({ turn, live }: { turn: AssistantMessage; live: boolean }) =>
        useTurnLiveness(turn, live),
      { initialProps: { turn: running(), live: true } },
    );

    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(result.current.elapsedMs).toBe(9_000);

    // The run settles, and the backend reports slightly less than the client
    // counted. The readout must not jump backwards.
    rerender({
      turn: running({
        lastEventAt: START + 9_000,
        done: true,
        usage: { elapsedMs: 8_600, tokensIn: null, tokensOut: null, model: "m" },
      }),
      live: false,
    });

    expect(result.current.elapsedMs).toBe(9_000);
    expect(result.current.stalled).toBe(false);
  });
});
