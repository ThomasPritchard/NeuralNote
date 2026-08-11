export type SidebarPanel = "files" | "search" | null;

export interface WorkspaceLayoutState {
  navigationExpanded: boolean;
  sidebarWidth: number;
  sidebarPanel: SidebarPanel;
  /**
   * Whether the chat pane is widened to its expanded size. The width itself
   * belongs to the `--chat-width` CSS token, responsive overrides included;
   * this flag only records which of the two sizes the user asked for.
   */
  chatExpanded: boolean;
}

export interface WorkspaceMeasurements {
  workspaceWidth: number;
  chatWidth: number;
  /** Current rendered navigation width, including intermediate animation frames. */
  navigationWidth?: number;
  /** Space to reserve when an opening pane has not reached its target width yet. */
  reservedChatWidth?: number;
}

export interface EffectiveWorkspaceLayout extends WorkspaceLayoutState {
  navigationWidth: number;
  sidebarMaxWidth: number;
  splitterWidth: number;
}

export const WORKSPACE_LAYOUT_STORAGE_KEY = "nn:workspace-layout:v2";
const LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY = "nn:workspace-layout:v1";
export const NAVIGATION_COMPACT_WIDTH = 56;
export const NAVIGATION_EXPANDED_WIDTH = 192;
export const SIDEBAR_MIN_WIDTH = 192;
export const SIDEBAR_MAX_WIDTH = 420;
export const EDITOR_MIN_WIDTH = 240;
export const SPLITTER_WIDTH = 8;
export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayoutState = {
  navigationExpanded: true,
  sidebarWidth: 296,
  sidebarPanel: "files",
  chatExpanded: false,
};

interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function defaultStorage(): LayoutStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isSidebarPanel(value: unknown): value is SidebarPanel {
  return value === "files" || value === "search" || value === null;
}

/**
 * Reads the chat expand flag tolerantly, so a stored payload written before the
 * toggle existed keeps the sidebar geometry saved alongside it. Rejecting the
 * whole payload over an absent or junk flag would reset every user's pane width,
 * which is why this stays on version 2 rather than becoming a version 3.
 */
function readChatExpanded(value: unknown): boolean {
  return value === true;
}

function parseLegacyWorkspaceLayout(raw: string | null): WorkspaceLayoutState | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.navigationExpanded !== "boolean" ||
      typeof candidate.sidebarWidth !== "number" ||
      !Number.isFinite(candidate.sidebarWidth)
    ) {
      return null;
    }
    return {
      navigationExpanded: candidate.navigationExpanded,
      sidebarWidth: clamp(
        candidate.sidebarWidth,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH,
      ),
      sidebarPanel: "files",
      chatExpanded: false,
    };
  } catch {
    return null;
  }
}

export function parseWorkspaceLayout(raw: string | null): WorkspaceLayoutState {
  if (raw === null) return { ...DEFAULT_WORKSPACE_LAYOUT };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_WORKSPACE_LAYOUT };
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.navigationExpanded !== "boolean" ||
      typeof candidate.sidebarWidth !== "number" ||
      !Number.isFinite(candidate.sidebarWidth) ||
      !isSidebarPanel(candidate.sidebarPanel)
    ) {
      return { ...DEFAULT_WORKSPACE_LAYOUT };
    }
    return {
      navigationExpanded: candidate.navigationExpanded,
      sidebarWidth: clamp(
        candidate.sidebarWidth,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH,
      ),
      sidebarPanel: candidate.sidebarPanel,
      chatExpanded: readChatExpanded(candidate.chatExpanded),
    };
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
}

export function loadWorkspaceLayout(storage = defaultStorage()): WorkspaceLayoutState {
  if (!storage) return { ...DEFAULT_WORKSPACE_LAYOUT };
  try {
    const current = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    if (current !== null) return parseWorkspaceLayout(current);

    const legacy = parseLegacyWorkspaceLayout(
      storage.getItem(LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY),
    );
    if (!legacy) return { ...DEFAULT_WORKSPACE_LAYOUT };
    saveWorkspaceLayout(legacy, storage);
    return legacy;
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
}

export function saveWorkspaceLayout(
  state: WorkspaceLayoutState,
  storage = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A layout preference is optional UI state. Quota and privacy-mode failures
    // must not prevent the workspace from rendering or resizing in memory.
  }
}

export function deriveEffectiveWorkspaceLayout(
  preferred: WorkspaceLayoutState,
  measurements: WorkspaceMeasurements,
): EffectiveWorkspaceLayout {
  const panelOpen = preferred.sidebarPanel !== null;
  const splitterWidth = panelOpen ? SPLITTER_WIDTH : 0;
  if (measurements.workspaceWidth <= 0) {
    return {
      ...preferred,
      sidebarWidth: panelOpen ? preferred.sidebarWidth : 0,
      navigationWidth: preferred.navigationExpanded
        ? NAVIGATION_EXPANDED_WIDTH
        : NAVIGATION_COMPACT_WIDTH,
      sidebarMaxWidth: SIDEBAR_MAX_WIDTH,
      splitterWidth,
    };
  }

  const workspaceWidth = Math.max(0, measurements.workspaceWidth);
  const chatWidth = Math.max(0, measurements.chatWidth);
  const reservedChatWidth = Math.max(
    chatWidth,
    measurements.reservedChatWidth ?? chatWidth,
  );
  const expandedSidebarSpace =
    workspaceWidth -
    NAVIGATION_EXPANDED_WIDTH -
    reservedChatWidth -
    splitterWidth -
    EDITOR_MIN_WIDTH;
  const navigationExpanded =
    preferred.navigationExpanded &&
    expandedSidebarSpace >= (panelOpen ? SIDEBAR_MIN_WIDTH : 0);
  const navigationWidth = navigationExpanded
    ? NAVIGATION_EXPANDED_WIDTH
    : NAVIGATION_COMPACT_WIDTH;
  const measuredNavigationWidth = measurements.navigationWidth;
  const renderedNavigationWidth =
    measuredNavigationWidth !== undefined && measuredNavigationWidth > 0
      ? measuredNavigationWidth
      : navigationWidth;
  const sidebarSpace =
    workspaceWidth -
    renderedNavigationWidth -
    chatWidth -
    splitterWidth -
    EDITOR_MIN_WIDTH;
  const sidebarMaxWidth = clamp(
    sidebarSpace,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
  );

  return {
    navigationExpanded,
    navigationWidth,
    sidebarPanel: preferred.sidebarPanel,
    sidebarWidth: panelOpen
      ? clamp(preferred.sidebarWidth, SIDEBAR_MIN_WIDTH, sidebarMaxWidth)
      : 0,
    sidebarMaxWidth,
    splitterWidth,
    // Passed through rather than responsively clamped: an expanded chat pane
    // reaches this derivation as a wider measured `chatWidth`, which compacts
    // the navigation ribbon above. Expanding chat means the user wants chat, so
    // the ribbon yielding is the intended trade rather than a fallback.
    chatExpanded: preferred.chatExpanded,
  };
}
