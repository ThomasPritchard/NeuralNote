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
        JSON.stringify({ navigationExpanded: false, sidebarWidth: 344 }),
      ),
    ).toEqual({ navigationExpanded: false, sidebarWidth: 344 });
  });

  it.each([
    "not json",
    "null",
    "[]",
    JSON.stringify({ navigationExpanded: "yes", sidebarWidth: 300 }),
    JSON.stringify({ navigationExpanded: true, sidebarWidth: "300" }),
    JSON.stringify({ navigationExpanded: true, sidebarWidth: null }),
  ])("recovers malformed data to the complete default state", (raw) => {
    expect(parseWorkspaceLayout(raw)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("clamps finite saved widths into the supported range", () => {
    expect(
      parseWorkspaceLayout(
        JSON.stringify({ navigationExpanded: true, sidebarWidth: -10 }),
      ),
    ).toEqual({ navigationExpanded: true, sidebarWidth: 192 });
    expect(
      parseWorkspaceLayout(
        JSON.stringify({ navigationExpanded: false, sidebarWidth: 9_999 }),
      ),
    ).toEqual({ navigationExpanded: false, sidebarWidth: 420 });
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
        { navigationExpanded: false, sidebarWidth: 240 },
        storage,
      ),
    ).not.toThrow();
    expect(storage.setItem).toHaveBeenCalledWith(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      JSON.stringify({ navigationExpanded: false, sidebarWidth: 240 }),
    );
  });
});

describe("responsive workspace layout", () => {
  it("uses the saved expanded navigation and pane width when space allows", () => {
    expect(
      deriveEffectiveWorkspaceLayout(
        { navigationExpanded: true, sidebarWidth: 344 },
        { workspaceWidth: 1_440, chatWidth: 420 },
      ),
    ).toEqual({
      navigationExpanded: true,
      navigationWidth: 192,
      sidebarWidth: 344,
      sidebarMaxWidth: 420,
    });
  });

  it("temporarily compacts navigation and clamps the pane to preserve the editor", () => {
    expect(
      deriveEffectiveWorkspaceLayout(
        { navigationExpanded: true, sidebarWidth: 344 },
        { workspaceWidth: 800, chatWidth: 300 },
      ),
    ).toEqual({
      navigationExpanded: false,
      navigationWidth: 56,
      sidebarWidth: 196,
      sidebarMaxWidth: 196,
    });
  });

  it("does not expand a compact saved preference on a wide workspace", () => {
    expect(
      deriveEffectiveWorkspaceLayout(
        { navigationExpanded: false, sidebarWidth: 300 },
        { workspaceWidth: 1_440, chatWidth: 0 },
      ).navigationExpanded,
    ).toBe(false);
  });

  it("restores the untouched saved preference when space returns", () => {
    const preferred = { navigationExpanded: true, sidebarWidth: 380 };

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
    expect(preferred).toEqual({ navigationExpanded: true, sidebarWidth: 380 });
  });

  it("starts responsive compaction before an opening chat can squeeze the editor", () => {
    const preferred = { navigationExpanded: true, sidebarWidth: 296 };
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
        { navigationExpanded: true, sidebarWidth: 320 },
        { workspaceWidth: 0, chatWidth: 0 },
      ),
    ).toMatchObject({
      navigationExpanded: true,
      navigationWidth: 192,
      sidebarWidth: 320,
      sidebarMaxWidth: 420,
    });
  });
});
