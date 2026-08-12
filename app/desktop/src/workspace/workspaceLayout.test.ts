import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKSPACE_LAYOUT,
  NAVIGATION_EXPANDED_WIDTH,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  deriveEffectiveWorkspaceLayout,
  loadWorkspaceLayout,
  parseWorkspaceLayout,
  saveWorkspaceLayout,
} from "./workspaceLayout";

/** The sidebar geometry a stored v2 payload carries, chat expand flag aside. */
const SAVED_GEOMETRY = {
  navigationExpanded: false,
  sidebarWidth: 344,
  sidebarPanel: "search",
} as const;

describe("workspace layout persistence", () => {
  it("uses the expanded 296px defaults when storage is missing", () => {
    expect(parseWorkspaceLayout(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("keeps the saved sidebar geometry when a payload predates the expand toggle", () => {
    const restored = parseWorkspaceLayout(
      JSON.stringify(SAVED_GEOMETRY),
    );

    expect(restored.chatExpanded).toBe(false);
    expect(restored.sidebarWidth).toBe(344);
    expect(restored.sidebarPanel).toBe("search");
  });

  it.each([
    JSON.stringify({ ...SAVED_GEOMETRY, chatExpanded: "yes" }),
    JSON.stringify({ ...SAVED_GEOMETRY, chatExpanded: "true" }),
    JSON.stringify({ ...SAVED_GEOMETRY, chatExpanded: null }),
    JSON.stringify({ ...SAVED_GEOMETRY, chatExpanded: 1 }),
  ])("reads a malformed chatExpanded as collapsed, keeping the geometry", (raw) => {
    expect(parseWorkspaceLayout(raw)).toEqual({
      ...SAVED_GEOMETRY,
      chatExpanded: false,
    });
  });

  it("round-trips an expanded chat pane through storage", () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    };
    const expanded = {
      navigationExpanded: true,
      sidebarWidth: 296,
      sidebarPanel: "files" as const,
      chatExpanded: true,
    };

    saveWorkspaceLayout(expanded, storage);

    expect(loadWorkspaceLayout(storage)).toEqual(expanded);
  });

  it("loads a valid saved preference", () => {
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          ...SAVED_GEOMETRY,
          chatExpanded: true,
        }),
      ),
    ).toEqual({
      ...SAVED_GEOMETRY,
      chatExpanded: true,
    });
  });

  it.each([
    "not json",
    "null",
    "[]",
    JSON.stringify({
      navigationExpanded: "yes",
      sidebarWidth: 300,
      sidebarPanel: "files",
    }),
    JSON.stringify({
      navigationExpanded: true,
      sidebarWidth: "300",
      sidebarPanel: "files",
    }),
    JSON.stringify({
      navigationExpanded: true,
      sidebarWidth: null,
      sidebarPanel: "files",
    }),
    JSON.stringify({
      navigationExpanded: true,
      sidebarWidth: 300,
      sidebarPanel: "graph",
    }),
  ])("recovers malformed data to the complete default state", (raw) => {
    expect(parseWorkspaceLayout(raw)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("clamps finite saved widths into the supported range", () => {
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          navigationExpanded: true,
          sidebarWidth: -10,
          sidebarPanel: "files",
        }),
      ),
    ).toEqual({
      navigationExpanded: true,
      sidebarWidth: 192,
      sidebarPanel: "files",
      chatExpanded: false,
    });
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          navigationExpanded: false,
          sidebarWidth: 9_999,
          sidebarPanel: null,
        }),
      ),
    ).toEqual({
      navigationExpanded: false,
      sidebarWidth: 420,
      sidebarPanel: null,
      chatExpanded: false,
    });
  });

  it("migrates a valid v1 preference once and writes version 2", () => {
    const storage = {
      getItem: vi.fn((key: string) =>
        key === "nn:workspace-layout:v1"
          ? JSON.stringify({ navigationExpanded: false, sidebarWidth: 344 })
          : null,
      ),
      setItem: vi.fn(),
    };

    expect(loadWorkspaceLayout(storage)).toEqual({
      navigationExpanded: false,
      sidebarWidth: 344,
      sidebarPanel: "files",
      chatExpanded: false,
    });
    expect(storage.getItem).toHaveBeenNthCalledWith(1, WORKSPACE_LAYOUT_STORAGE_KEY);
    expect(storage.getItem).toHaveBeenNthCalledWith(2, "nn:workspace-layout:v1");
    expect(storage.setItem).toHaveBeenCalledWith(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        navigationExpanded: false,
        sidebarWidth: 344,
        sidebarPanel: "files",
        chatExpanded: false,
      }),
    );
  });

  it("does not revive stale v1 data when version 2 is malformed", () => {
    const storage = {
      getItem: vi.fn((key: string) =>
        key === WORKSPACE_LAYOUT_STORAGE_KEY
          ? JSON.stringify({ sidebarPanel: "broken" })
          : JSON.stringify({ navigationExpanded: false, sidebarWidth: 344 }),
      ),
      setItem: vi.fn(),
    };

    expect(loadWorkspaceLayout(storage)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("keeps storage failures out of the workspace render path", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new DOMException("blocked", "SecurityError");
      }),
      setItem: vi.fn(() => {
        throw new DOMException("full", "QuotaExceededError");
      }),
    };

    expect(loadWorkspaceLayout(storage)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(() =>
      saveWorkspaceLayout(
        {
          navigationExpanded: false,
          sidebarWidth: 240,
          sidebarPanel: null,
          chatExpanded: false,
        },
        storage,
      ),
    ).not.toThrow();
    expect(storage.setItem).toHaveBeenCalledWith(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        navigationExpanded: false,
        sidebarWidth: 240,
        sidebarPanel: null,
        chatExpanded: false,
      }),
    );
  });
});

describe("responsive workspace layout", () => {
  it("uses the saved expanded navigation and pane width when space allows", () => {
    expect(
      deriveEffectiveWorkspaceLayout(
        {
          navigationExpanded: true,
          sidebarWidth: 344,
          sidebarPanel: "files",
          chatExpanded: false,
        },
        { workspaceWidth: 1_440, chatWidth: 420 },
      ),
    ).toEqual({
      navigationExpanded: true,
      navigationWidth: 192,
      sidebarWidth: 344,
      sidebarMaxWidth: 420,
      sidebarPanel: "files",
      splitterWidth: 8,
      chatExpanded: false,
    });
  });

  it("temporarily compacts navigation and clamps the pane to preserve the editor", () => {
    expect(
      deriveEffectiveWorkspaceLayout(
        {
          navigationExpanded: true,
          sidebarWidth: 344,
          sidebarPanel: "files",
          chatExpanded: false,
        },
        { workspaceWidth: 800, chatWidth: 300 },
      ),
    ).toEqual({
      navigationExpanded: false,
      navigationWidth: 56,
      sidebarWidth: 196,
      sidebarMaxWidth: 196,
      sidebarPanel: "files",
      splitterWidth: 8,
      chatExpanded: false,
    });
  });

  it("does not expand a compact saved preference on a wide workspace", () => {
    expect(
      deriveEffectiveWorkspaceLayout(
        {
          navigationExpanded: false,
          sidebarWidth: 300,
          sidebarPanel: "files",
          chatExpanded: false,
        },
        { workspaceWidth: 1_440, chatWidth: 0 },
      ).navigationExpanded,
    ).toBe(false);
  });

  it("restores the untouched saved preference when space returns", () => {
    const preferred = {
      navigationExpanded: true,
      sidebarWidth: 380,
      sidebarPanel: "files" as const,
      chatExpanded: false,
    };

    expect(
      deriveEffectiveWorkspaceLayout(preferred, {
        workspaceWidth: 760,
        chatWidth: 280,
      }),
    ).toMatchObject({ navigationExpanded: false, sidebarWidth: 192 });
    expect(
      deriveEffectiveWorkspaceLayout(preferred, {
        workspaceWidth: 1_440,
        chatWidth: 420,
      }),
    ).toMatchObject({ navigationExpanded: true, sidebarWidth: 380 });
    expect(preferred).toEqual({
      navigationExpanded: true,
      sidebarWidth: 380,
      sidebarPanel: "files",
      chatExpanded: false,
    });
  });

  it("starts responsive compaction before an opening chat can squeeze the editor", () => {
    const preferred = {
      navigationExpanded: true,
      sidebarWidth: 296,
      sidebarPanel: "files" as const,
      chatExpanded: false,
    };
    const openingFrames = [
      { chatWidth: 0, navigationWidth: 192 },
      { chatWidth: 162, navigationWidth: 124 },
      { chatWidth: 324, navigationWidth: 56 },
    ];

    for (const frame of openingFrames) {
      const layout = deriveEffectiveWorkspaceLayout(preferred, {
        workspaceWidth: 920,
        chatWidth: frame.chatWidth,
        navigationWidth: frame.navigationWidth,
        reservedChatWidth: 324,
      });
      const editorWidth =
        920 -
        frame.navigationWidth -
        frame.chatWidth -
        8 -
        layout.sidebarWidth;

      expect(layout.navigationExpanded).toBe(false);
      expect(editorWidth).toBeGreaterThanOrEqual(240);
    }
  });

  it("uses preferred geometry before the first measurement", () => {
    expect(
      deriveEffectiveWorkspaceLayout(
        {
          navigationExpanded: true,
          sidebarWidth: 320,
          sidebarPanel: "files",
          chatExpanded: true,
        },
        { workspaceWidth: 0, chatWidth: 0 },
      ),
    ).toMatchObject({
      navigationExpanded: true,
      navigationWidth: 192,
      sidebarWidth: 320,
      sidebarMaxWidth: 420,
      sidebarPanel: "files",
      splitterWidth: 8,
      chatExpanded: true,
    });
  });

  it("collapses the sidebar and splitter without discarding the preferred width", () => {
    const preferred = {
      navigationExpanded: true,
      sidebarWidth: 344,
      sidebarPanel: null,
      chatExpanded: false,
    } as const;

    expect(
      deriveEffectiveWorkspaceLayout(preferred, {
        workspaceWidth: 1_440,
        chatWidth: 420,
      }),
    ).toMatchObject({
      sidebarPanel: null,
      sidebarWidth: 0,
      splitterWidth: 0,
      sidebarMaxWidth: 420,
    });
    expect(preferred.sidebarWidth).toBe(344);
  });
});

describe("expanded chat pane", () => {
  // A workspace narrow enough that a wide chat pane and an expanded ribbon
  // cannot both fit, but a normal-width chat pane and an expanded ribbon can.
  const WORKSPACE_WIDTH = 1_200;
  const COLLAPSED_CHAT_WIDTH = 420;
  // Sized to land inside the band where compacting the ribbon frees enough room
  // to justify re-expanding it. Outside that band no feedback rule could flap,
  // so the settling test below would pass without proving anything.
  const EXPANDED_CHAT_WIDTH = 640;
  const preferred = {
    navigationExpanded: true,
    sidebarWidth: 296,
    sidebarPanel: "files" as const,
    chatExpanded: false,
  };

  // A window with room for a wide pane AND a labelled ribbon at the same time.
  // The pair of widths are what the tokens really resolve to there: 28vw and
  // 44vw of 1440.
  const ROOMY_WORKSPACE_WIDTH = 1_440;
  const ROOMY_COLLAPSED_CHAT_WIDTH = 420;
  const ROOMY_EXPANDED_CHAT_WIDTH = 634;

  // The flag itself yields the ribbon. It used to reach this derivation only as
  // a wider measured `chatWidth`, on the reasoning that the width is the CSS
  // token's business — but running out of room and being asked for room are
  // different things, and only the second is what the toggle means. Width alone
  // compacted nothing above ~1176px, so at any comfortable window the toggle
  // left the ribbon exactly as it was.
  it("yields the navigation ribbon whenever the pane is expanded, room or not", () => {
    const measurements = {
      workspaceWidth: ROOMY_WORKSPACE_WIDTH,
      chatWidth: ROOMY_EXPANDED_CHAT_WIDTH,
    };

    const collapsed = deriveEffectiveWorkspaceLayout(preferred, {
      workspaceWidth: ROOMY_WORKSPACE_WIDTH,
      chatWidth: ROOMY_COLLAPSED_CHAT_WIDTH,
    });
    const expanded = deriveEffectiveWorkspaceLayout(
      { ...preferred, chatExpanded: true },
      measurements,
    );

    expect(collapsed.navigationExpanded).toBe(true);
    expect(expanded.navigationExpanded).toBe(false);
    // And it is the flag that did it, not the extra pixels: the same wide pane
    // with the flag off keeps its labels. Without this the test passes on a rule
    // that only ever reacts to width, which is the rule that shipped the defect.
    expect(
      deriveEffectiveWorkspaceLayout(preferred, measurements).navigationExpanded,
    ).toBe(true);
  });

  // The pane has to be occupying the row to claim anything. `chatExpanded` is
  // persisted, so it outlives the pane being closed, and a closed pane that took
  // the labels with it would compact the ribbon for no visible reason.
  it("leaves the ribbon alone while an expanded pane is closed", () => {
    expect(
      deriveEffectiveWorkspaceLayout(
        { ...preferred, chatExpanded: true },
        { workspaceWidth: ROOMY_WORKSPACE_WIDTH, chatWidth: 0 },
      ).navigationExpanded,
    ).toBe(true);
  });

  it("settles compaction as the pane widens instead of oscillating", () => {
    // The hook re-measures on every animation frame, so the ribbon width it
    // renders this frame is the width it feeds back next frame. Compaction must
    // not chase its own output: freeing 136px by compacting must never re-open
    // the ribbon, which would consume that space again and flap forever. The
    // frames dwell at the expanded width so a flapping rule gets caught mid-flap
    // rather than sampled once.
    //
    // `chatExpanded` stays OFF here on purpose. Only the width-driven path can
    // flap — the flag holds still by definition, so running these frames with it
    // on would pin the answer and prove nothing. This is the chat pane opening.
    const paneWidthFrames = [
      COLLAPSED_CHAT_WIDTH,
      520,
      580,
      EXPANDED_CHAT_WIDTH,
      EXPANDED_CHAT_WIDTH,
      EXPANDED_CHAT_WIDTH,
      EXPANDED_CHAT_WIDTH,
      EXPANDED_CHAT_WIDTH,
    ];

    let measuredNavigationWidth = NAVIGATION_EXPANDED_WIDTH;
    const withFeedback = paneWidthFrames.map((chatWidth) => {
      const layout = deriveEffectiveWorkspaceLayout(preferred, {
        workspaceWidth: WORKSPACE_WIDTH,
        chatWidth,
        navigationWidth: measuredNavigationWidth,
      });
      measuredNavigationWidth = layout.navigationWidth;
      return layout.navigationExpanded;
    });
    const withoutFeedback = paneWidthFrames.map(
      (chatWidth) =>
        deriveEffectiveWorkspaceLayout(preferred, {
          workspaceWidth: WORKSPACE_WIDTH,
          chatWidth,
        }).navigationExpanded,
    );
    const flips = withFeedback.filter(
      (expanded, frame) => frame > 0 && expanded !== withFeedback[frame - 1],
    ).length;

    expect(withFeedback.at(0)).toBe(true);
    expect(withFeedback.at(-1)).toBe(false);
    expect(flips).toBeLessThanOrEqual(1);
    expect(withFeedback).toEqual(withoutFeedback);
  });
});
