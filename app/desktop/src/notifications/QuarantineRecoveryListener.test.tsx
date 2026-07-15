import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuarantineRecoveryListener } from "./QuarantineRecoveryListener";
import type { QuarantineRecoveryReport } from "../lib/bindings/QuarantineRecoveryReport";

// Capture the callback registered with onQuarantineRecovery so the test can drive
// a report through it, and record the unlisten so teardown can be asserted.
const recovery: { cb?: (report: QuarantineRecoveryReport) => void } = {};
const unlisten = vi.fn();

vi.mock("../lib/api", () => ({
  onQuarantineRecovery: (cb: (report: QuarantineRecoveryReport) => void) => {
    recovery.cb = cb;
    return Promise.resolve(unlisten);
  },
}));

const toast = {
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  notify: vi.fn(),
  dismiss: vi.fn(),
};

vi.mock("./ToastProvider", () => ({
  useToast: () => toast,
}));

afterEach(() => {
  cleanup();
  recovery.cb = undefined;
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  // Let the onQuarantineRecovery promise resolve so the subscription is live.
  await Promise.resolve();
  await Promise.resolve();
}

describe("QuarantineRecoveryListener", () => {
  it("surfaces each recovery entry with a severity matching its status", async () => {
    render(<QuarantineRecoveryListener />);
    await flush();
    expect(recovery.cb).toBeDefined();

    recovery.cb!({
      entries: [
        { relPath: "A.md", status: "recovered", message: null },
        { relPath: "B.md", status: "removedInterruptedWrite", message: "was a cancelled draft" },
        { relPath: "C.md", status: "conflict", message: "original path occupied" },
        { relPath: "D.md", status: "retained", message: "unreadable record" },
      ],
    });

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success.mock.calls[0][0]).toContain("A.md");
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info.mock.calls[0][0]).toContain("was a cancelled draft");
    // conflict + retained both warn (they need the user to act).
    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(toast.warning.mock.calls[0][0]).toContain("original path occupied");
    // A user-attention notice is never silently downgraded to a plain error toast.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<QuarantineRecoveryListener />);
    await flush();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
