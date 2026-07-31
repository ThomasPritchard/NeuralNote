import { describe, expect, it, vi } from "vitest";

import { MockScheduler } from "./mockScheduler";

describe("MockScheduler", () => {
  it("runs queued work only when advanced and preserves insertion order", () => {
    const scheduler = new MockScheduler();
    const seen: string[] = [];

    scheduler.schedule(() => seen.push("first"));
    scheduler.schedule(() => seen.push("second"));

    expect(seen).toEqual([]);
    expect(scheduler.runNext()).toBe(true);
    expect(seen).toEqual(["first"]);
    expect(scheduler.runAll()).toBe(1);
    expect(seen).toEqual(["first", "second"]);
  });

  it("cancels pending work without running it", () => {
    const scheduler = new MockScheduler();
    const task = vi.fn();

    const handle = scheduler.schedule(task);
    expect(scheduler.cancel(handle)).toBe(true);

    expect(scheduler.runAll()).toBe(0);
    expect(task).not.toHaveBeenCalled();
  });

  it("keeps explicitly late work manual when ordinary work auto-flushes", async () => {
    const scheduler = new MockScheduler(true);
    const seen: string[] = [];

    scheduler.schedule(() => seen.push("ordinary"));
    scheduler.scheduleManual(() => seen.push("late"));
    await Promise.resolve();

    expect(seen).toEqual(["ordinary"]);
    expect(scheduler.runAll()).toBe(1);
    expect(seen).toEqual(["ordinary", "late"]);
  });
});
