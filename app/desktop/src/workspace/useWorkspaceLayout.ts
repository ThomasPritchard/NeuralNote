// The workspace's layout + panel-routing state, grouped out of Workspace.tsx.
// Owns the persisted layout preference (sidebar width, navigation expand/compact,
// which sidebar panel is showing), the live pane measurements that drive
// responsive compaction, and the search-panel focus/query signals. All of these
// hang off the single `layoutPreference` object (mutated by both the geometry
// controls and the panel switches), so they stay in one hook rather than being
// split across two that share the same state.
//
// Deliberately NOT in the vault store — this is Workspace-local view state
// (specs/search-and-graph-view.md §View model).

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { SearchQueryRequest } from "./SearchPanel";
import {
  deriveEffectiveWorkspaceLayout,
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  type EffectiveWorkspaceLayout,
  type SidebarPanel,
  type WorkspaceLayoutState,
  type WorkspaceMeasurements,
} from "./workspaceLayout";

export interface WorkspaceLayoutController {
  effectiveLayout: EffectiveWorkspaceLayout;
  sidebarPanel: SidebarPanel;
  workspacePanesRef: RefObject<HTMLDivElement | null>;
  setLayoutPreference: Dispatch<SetStateAction<WorkspaceLayoutState>>;
  toggleNavigation: () => void;
  selectFiles: () => void;
  selectSearch: () => void;
  handleSearchTag: (tag: string) => void;
  handleShowFiles: () => void;
  handleShowSearch: () => void;
  searchFocusSignal: number;
  searchQueryRequest: SearchQueryRequest | null;
}

/**
 * @param showChat whether the cited-recall chat panel is open — feeds the
 *   pane-measurement effect so navigation compaction tracks the chat transition.
 * @param vaultPath the open vault's path — re-measures when the vault changes.
 */
export function useWorkspaceLayout(
  showChat: boolean,
  vaultPath: string | undefined,
): WorkspaceLayoutController {
  const [layoutPreference, setLayoutPreference] = useState(loadWorkspaceLayout);
  const sidebarPanel = layoutPreference.sidebarPanel;
  const [workspaceMeasurements, setWorkspaceMeasurements] =
    useState<WorkspaceMeasurements>({
      workspaceWidth: 0,
      chatWidth: 0,
      navigationWidth: 0,
      reservedChatWidth: 0,
    });
  const workspacePanesRef = useRef<HTMLDivElement>(null);
  // Bumped whenever ⌘K / the navigation Search action wants the field focused.
  const [searchFocusSignal, bumpSearchFocus] = useReducer((n: number) => n + 1, 0);
  const [searchQueryRequest, setSearchQueryRequest] =
    useState<SearchQueryRequest | null>(null);
  const searchQueryRequestId = useRef(0);

  const effectiveLayout = useMemo(
    () =>
      deriveEffectiveWorkspaceLayout(layoutPreference, workspaceMeasurements),
    [layoutPreference, workspaceMeasurements],
  );
  const effectiveNavigationExpandedRef = useRef(
    effectiveLayout.navigationExpanded,
  );
  effectiveNavigationExpandedRef.current = effectiveLayout.navigationExpanded;

  const toggleNavigation = useCallback(() => {
    setLayoutPreference((current) => ({
      ...current,
      // Toggle what the user can currently see. If responsive layout has
      // temporarily compacted an expanded preference, an attempted expansion
      // remains expanded in preference rather than silently reversing it.
      navigationExpanded: !effectiveNavigationExpandedRef.current,
    }));
  }, []);

  useEffect(() => saveWorkspaceLayout(layoutPreference), [layoutPreference]);

  useEffect(() => {
    const workspace = workspacePanesRef.current;
    if (!workspace) return;
    const chatSlot = workspace.querySelector<HTMLElement>(".nn-chat-slot");
    const chatPane = workspace.querySelector<HTMLElement>(".nn-chat-pane");
    const navigation = workspace.querySelector<HTMLElement>(".nn-ribbon");
    const measure = () => {
      const chatWidth = chatSlot?.getBoundingClientRect().width ?? 0;
      const chatTargetWidth = chatPane?.getBoundingClientRect().width ?? 0;
      // Reserve the chat's target width as soon as it starts opening. This
      // starts navigation compaction at the same time as the chat transition,
      // rather than waiting until the editor has nearly run out of space.
      const openReservedWidth = chatTargetWidth > 0 ? chatTargetWidth : chatWidth;
      const next = {
        workspaceWidth: workspace.getBoundingClientRect().width,
        // Read the slot's current rendered width so responsive clamping follows
        // the chat animation instead of jumping to its final state.
        chatWidth,
        navigationWidth: navigation?.getBoundingClientRect().width ?? 0,
        reservedChatWidth: showChat ? openReservedWidth : chatWidth,
      };
      setWorkspaceMeasurements((current) =>
        current.workspaceWidth === next.workspaceWidth &&
        current.chatWidth === next.chatWidth &&
        current.navigationWidth === next.navigationWidth &&
        current.reservedChatWidth === next.reservedChatWidth
          ? current
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    if (chatSlot) observer.observe(chatSlot);
    if (chatPane) observer.observe(chatPane);
    if (navigation) observer.observe(navigation);
    measure();
    return () => observer.disconnect();
  }, [showChat, vaultPath]);

  const selectFiles = useCallback(() => {
    setLayoutPreference((current) => ({ ...current, sidebarPanel: "files" }));
  }, []);
  const selectSearch = useCallback(() => {
    setLayoutPreference((current) => ({ ...current, sidebarPanel: "search" }));
    bumpSearchFocus();
  }, []);
  const handleSearchTag = useCallback((tag: string) => {
    if (!tag.startsWith("#") || tag.length < 2) return;
    setLayoutPreference((current) => ({ ...current, sidebarPanel: "search" }));
    setSearchQueryRequest({
      id: ++searchQueryRequestId.current,
      query: `tag:${tag}`,
    });
  }, []);
  const handleShowFiles = useCallback(() => {
    setLayoutPreference((current) => ({
      ...current,
      sidebarPanel: current.sidebarPanel === "files" ? null : "files",
    }));
  }, []);
  const handleShowSearch = useCallback(() => {
    setLayoutPreference((current) => {
      const opening = current.sidebarPanel !== "search";
      if (opening) bumpSearchFocus();
      return {
        ...current,
        sidebarPanel: opening ? "search" : null,
      };
    });
  }, []);

  return {
    effectiveLayout,
    sidebarPanel,
    workspacePanesRef,
    setLayoutPreference,
    toggleNavigation,
    selectFiles,
    selectSearch,
    handleSearchTag,
    handleShowFiles,
    handleShowSearch,
    searchFocusSignal,
    searchQueryRequest,
  };
}
