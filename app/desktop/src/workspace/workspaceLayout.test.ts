import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKSPACE_LAYOUT,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  deriveEffectiveWorkspaceLayout,
  loadWorkspaceLayout,
  parseWorkspaceLayout,
  saveWorkspaceLayout,
} from "./workspaceLayout";

describe("workspace layout persistence", () => {
  it("uses the expanded 296px defaults when storage is missing", () => {
    expect(parseWorkspaceLayout(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("loads a valid saved preference", () => {
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          navigationExpanded: false,
          sidebarWidth: 344,
          sidebarPanel: "search",
        }),
      ),
    ).toEqual({
      navigationExpanded: false,
      sidebarWidth: 344,
      sidebarPanel: "search",
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
    });
    expect(storage.getItem).toHaveBeenNthCalledWith(1, WORKSPACE_LAYOUT_STORAGE_KEY);
    expect(storage.getItem).toHaveBeenNthCalledWith(2, "nn:workspace-layout:v1");
    expect(storage.setItem).toHaveBeenCalledWith(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        navigationExpanded: false,
        sidebarWidth: 344,
        sidebarPanel: "files",
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
    });
  });

  it("temporarily compacts navigation and clamps the pane to preserve the editor", () => {
    expect(
      deriveEffectiveWorkspaceLayout(
        {
          navigationExpanded: true,
          sidebarWidth: 344,
          sidebarPanel: "files",
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
    });
  });

  it("does not expand a compact saved preference on a wide workspace", () => {
    expect(
      deriveEffectiveWorkspaceLayout(
        {
          navigationExpanded: false,
          sidebarWidth: 300,
          sidebarPanel: "files",
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
    });
  });

  it("starts responsive compaction before an opening chat can squeeze the editor", () => {
    const preferred = {
      navigationExpanded: true,
      sidebarWidth: 296,
      sidebarPanel: "files" as const,
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
    });
  });

  it("collapses the sidebar and splitter without discarding the preferred width", () => {
    const preferred = {
      navigationExpanded: true,
      sidebarWidth: 344,
      sidebarPanel: null,
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
