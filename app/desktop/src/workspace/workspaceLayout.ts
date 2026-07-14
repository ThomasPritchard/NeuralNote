export interface WorkspaceLayoutState {
  navigationExpanded: boolean;
  sidebarWidth: number;
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
}

export const WORKSPACE_LAYOUT_STORAGE_KEY = "nn:workspace-layout:v1";
export const NAVIGATION_COMPACT_WIDTH = 56;
export const NAVIGATION_EXPANDED_WIDTH = 192;
export const SIDEBAR_MIN_WIDTH = 192;
export const SIDEBAR_MAX_WIDTH = 420;
export const EDITOR_MIN_WIDTH = 240;
export const SPLITTER_WIDTH = 8;
export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayoutState = {
  navigationExpanded: true,
  sidebarWidth: 296,
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
      !Number.isFinite(candidate.sidebarWidth)
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
    };
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
}

export function loadWorkspaceLayout(storage = defaultStorage()): WorkspaceLayoutState {
  if (!storage) return { ...DEFAULT_WORKSPACE_LAYOUT };
  try {
    return parseWorkspaceLayout(storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY));
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
  if (measurements.workspaceWidth <= 0) {
    return {
      ...preferred,
      navigationWidth: preferred.navigationExpanded
        ? NAVIGATION_EXPANDED_WIDTH
        : NAVIGATION_COMPACT_WIDTH,
      sidebarMaxWidth: SIDEBAR_MAX_WIDTH,
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
    SPLITTER_WIDTH -
    EDITOR_MIN_WIDTH;
  const navigationExpanded =
    preferred.navigationExpanded && expandedSidebarSpace >= SIDEBAR_MIN_WIDTH;
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
    SPLITTER_WIDTH -
    EDITOR_MIN_WIDTH;
  const sidebarMaxWidth = clamp(
    sidebarSpace,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
  );

  return {
    navigationExpanded,
    navigationWidth,
    sidebarWidth: clamp(
      preferred.sidebarWidth,
      SIDEBAR_MIN_WIDTH,
      sidebarMaxWidth,
    ),
    sidebarMaxWidth,
  };
}
