// The chat pane's provider hook, at the seam the composer reads: which reasoning
// facts the backend's status echo actually reaches the composer's state as.
//
// The pane-level rendering of these lives in `ChatPaneReasoning.test.tsx`. This
// suite exists because two of them — the control and the effort override — are
// routed for a surface that has not been built yet, and a value nothing renders
// can only be pinned where it is derived.

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    aiStatus: vi.fn(),
    refreshReasoningSupport: vi.fn(),
    setReasoning: vi.fn(),
  };
});

import * as api from "../lib/api";
import type { AiStatus, ReasoningControl } from "../lib/types";
import { ALWAYS_ASK_APPROVAL_STATUS } from "../lib/approvalStatusFixture";
import { useChatPaneProvider } from "./useChatPaneProvider";

const MODEL = "anthropic/claude-sonnet-4.5";

const mockAiStatus = vi.mocked(api.aiStatus);
const mockRefreshSupport = vi.mocked(api.refreshReasoningSupport);
const mockSetReasoning = vi.mocked(api.setReasoning);

function status(overrides: {
  reasoning?: boolean;
  reasoningControl?: ReasoningControl;
  reasoningEffort?: string | null;
  reasoningEffortOverride?: { stored: string; sending: string | null };
} = {}): AiStatus {
  const { reasoningEffortOverride, ...openrouter } = overrides;
  return {
    activeProvider: "openRouter",
    reasoningSupported: "supported",
    reasoningControl: overrides.reasoningControl ?? { kind: "pending" },
    openrouter: {
      hasKey: true,
      model: MODEL,
      reasoning: openrouter.reasoning ?? false,
      reasoningEffort: openrouter.reasoningEffort ?? null,
      ...(reasoningEffortOverride ? { reasoningEffortOverride } : {}),
    },
    local: { activeModelTag: null },
    approval: ALWAYS_ASK_APPROVAL_STATUS,
  };
}

/** Mount the hook against a settled status echo, with the capability probe
 *  echoing the same status so nothing overwrites it. */
async function provider(echo: AiStatus) {
  mockAiStatus.mockResolvedValue(echo);
  mockRefreshSupport.mockResolvedValue(echo);
  const reportError = vi.fn();
  const rendered = renderHook(() =>
    useChatPaneProvider({ reportError, refreshSignal: 0 }),
  );
  await waitFor(() => expect(rendered.result.current.view).toBe("chat"));
  return { ...rendered, reportError };
}

beforeEach(() => {
  mockAiStatus.mockReset();
  mockRefreshSupport.mockReset();
  mockSetReasoning.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChatPaneProvider — the reasoning facts the composer reads", () => {
  it("says reasoning is on for a mandatory model the user opted out of", async () => {
    // The bug this pins: the composer derived its state from the persisted
    // opt-in alone, so a user who once opted out saw "off" on a model that
    // always reasons — while Settings, reading the control, said "Always on".
    const { result } = await provider(
      status({ reasoning: false, reasoningControl: { kind: "locked" } }),
    );

    expect(result.current.reasoningOn).toBe(false);
    expect(result.current.reasoningIndicatorOn).toBe(true);
  });

  it("says reasoning is on for an effort menu with no off position", async () => {
    const { result } = await provider(
      status({
        reasoning: false,
        reasoningControl: {
          kind: "efforts",
          options: ["high", "low"],
          defaultEffort: "high",
          canDisable: false,
        },
      }),
    );

    expect(result.current.reasoningIndicatorOn).toBe(true);
  });

  it("follows the persisted opt-in wherever the model can be turned off", async () => {
    const { result } = await provider(
      status({ reasoning: false, reasoningControl: { kind: "toggle", defaultOn: true } }),
    );

    // `default_on` is the MODEL's default, never the user's setting: a model
    // that reasons by default can still be told not to show it.
    expect(result.current.reasoningIndicatorOn).toBe(false);
  });

  it("refuses to toggle a control that offers no off position", async () => {
    const { result } = await provider(
      status({ reasoning: false, reasoningControl: { kind: "locked" } }),
    );

    await result.current.toggleReasoning();

    // Settings renders no checkbox at all for this control. A write from here
    // would persist a preference whose effect the user can never see change.
    expect(mockSetReasoning).not.toHaveBeenCalled();
    expect(result.current.reasoningIndicatorOn).toBe(true);
  });

  it("routes the control itself, so the effort surface reads one source of truth", async () => {
    const control: ReasoningControl = {
      kind: "efforts",
      options: ["xhigh", "high"],
      defaultEffort: null,
      canDisable: true,
    };
    const { result } = await provider(status({ reasoningControl: control }));

    expect(result.current.reasoningControl).toEqual(control);
  });

  it("reports pending while no status has arrived, never a guessed control", async () => {
    mockAiStatus.mockReturnValue(new Promise<AiStatus>(() => {}));
    mockRefreshSupport.mockReturnValue(new Promise<AiStatus>(() => {}));
    const { result } = renderHook(() =>
      useChatPaneProvider({ reportError: vi.fn(), refreshSignal: 0 }),
    );

    expect(result.current.reasoningControl).toEqual({ kind: "pending" });
    expect(result.current.reasoningIndicatorOn).toBe(false);
  });

  it("routes the effort substitution the send path is applying", async () => {
    const { result } = await provider(
      status({
        reasoning: true,
        reasoningEffort: "xhigh",
        reasoningEffortOverride: { stored: "xhigh", sending: "high" },
      }),
    );

    // Amendment E3: the stored preference survives a menu that shrank, and the
    // substitution has to be visible to the person paying for it.
    expect(result.current.reasoningEffortOverride).toEqual({
      stored: "xhigh",
      sending: "high",
    });
  });

  it("reports no substitution as null, the one representation of absent", async () => {
    const { result } = await provider(status({ reasoning: true }));

    expect(result.current.reasoningEffortOverride).toBeNull();
  });
});
