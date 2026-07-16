// The workspace's central panes region: navigation ribbon · file-tree / search
// sidebar · graph or note reader/editor · cited-recall chat slot. Extracted
// verbatim from Workspace.tsx as a pure presentational subtree — it owns no
// state; the composing view threads it every value and handler. Kept as its own
// component so Workspace.tsx stays a readable orchestrator.

import type {
  Dispatch,
  RefObject,
  SetStateAction,
} from "react";
import type { LoadedDir } from "../lib/store";
import type { TreeNode } from "../lib/types";
import { ChatPane } from "./ChatPane";
import { FileTree } from "./FileTree";
import { GraphView } from "./GraphView";
import type { NoteIndexEntry } from "./linkResolve";
import { NotePane } from "./NotePane";
import { PaneSplitter } from "./PaneSplitter";
import { Ribbon, type CenterView } from "./Ribbon";
import { SearchPanel, type SearchQueryRequest } from "./SearchPanel";
import {
  GRAPH_PANEL_ID,
  GRAPH_TAB_ID,
  noteTabPanelId,
  noteTabTriggerId,
} from "./TitleBar";
import type { CreateKind } from "./TreeRow";
import type { OpenNote } from "./useOpenNote";
import {
  SIDEBAR_MIN_WIDTH,
  type EffectiveWorkspaceLayout,
  type SidebarPanel,
  type WorkspaceLayoutState,
} from "./workspaceLayout";

export interface WorkspacePanesProps {
  panesRef: RefObject<HTMLDivElement | null>;
  effectiveLayout: EffectiveWorkspaceLayout;
  vaultName: string;
  vaultPath: string;
  sidebarPanel: SidebarPanel;
  centerView: CenterView;
  setLayoutPreference: Dispatch<SetStateAction<WorkspaceLayoutState>>;
  // Ribbon
  onShowFiles: () => void;
  onShowSearch: () => void;
  onInsertTemplate: () => void;
  onToggleGraph: () => void;
  onNewNote: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  onCloseVault: () => void;
  // FileTree
  activePath: string | null;
  loaded: ReadonlyMap<string, LoadedDir>;
  expanded: ReadonlySet<string>;
  onToggle: (relPath: string) => void;
  onListDir: (relPath: string) => Promise<void>;
  onRefreshDir: (relPath: string) => Promise<void>;
  onSelect: (path: string, openInNewTab: boolean) => void;
  onDeleteRequest: (node: TreeNode) => void;
  onRemap: (oldPath: string, newNode: TreeNode) => void;
  pendingCreate: CreateKind | null;
  onCreateConsumed: () => void;
  // SearchPanel
  searchFocusSignal: number;
  searchQueryRequest: SearchQueryRequest | null;
  // Graph / note panel
  activeTabId: string | null;
  onOpenNote: (relPath: string) => void;
  open: OpenNote;
  noteIndex: NoteIndexEntry[];
  onSearchTag: (tag: string) => void;
  reportError: (message: string) => void;
  // Chat
  showChat: boolean;
  aiStatusVersion: number;
  onOpenChatSettings: () => void;
  /** Shared open-by-absolute-path handler — SearchPanel results and chat citations. */
  openNoteAt: (absPath: string) => void;
}

export function WorkspacePanes({
  panesRef,
  effectiveLayout,
  vaultName,
  vaultPath,
  sidebarPanel,
  centerView,
  setLayoutPreference,
  onShowFiles,
  onShowSearch,
  onInsertTemplate,
  onToggleGraph,
  onNewNote,
  onNewFolder,
  onRefresh,
  onCloseVault,
  activePath,
  loaded,
  expanded,
  onToggle,
  onListDir,
  onRefreshDir,
  onSelect,
  onDeleteRequest,
  onRemap,
  pendingCreate,
  onCreateConsumed,
  searchFocusSignal,
  searchQueryRequest,
  activeTabId,
  onOpenNote,
  open,
  noteIndex,
  onSearchTag,
  reportError,
  showChat,
  aiStatusVersion,
  onOpenChatSettings,
  openNoteAt,
}: Readonly<WorkspacePanesProps>) {
  return (
    <div
      ref={panesRef}
      id="nn-main-content"
      tabIndex={-1}
      data-testid="workspace-panes"
      className="nn-workspace-panes flex min-h-0 flex-1 overflow-hidden outline-none"
    >
      <Ribbon
        navigationExpanded={effectiveLayout.navigationExpanded}
        vaultName={vaultName}
        sidebarPanel={sidebarPanel}
        centerView={centerView}
        onShowFiles={onShowFiles}
        onShowSearch={onShowSearch}
        onInsertTemplate={onInsertTemplate}
        onToggleGraph={onToggleGraph}
        onNewNote={onNewNote}
        onNewFolder={onNewFolder}
        onRefresh={onRefresh}
        onCloseVault={onCloseVault}
      />
      <div
        id="nn-primary-sidebar"
        aria-hidden={sidebarPanel === null}
        inert={sidebarPanel === null ? true : undefined}
        className="nn-primary-sidebar flex min-h-0 shrink-0"
      >
        <div
          className="nn-primary-sidebar-panel"
          hidden={sidebarPanel !== "files"}
          inert={sidebarPanel === "files" ? undefined : true}
        >
          <FileTree
            vaultPath={vaultPath}
            activePath={activePath}
            loaded={loaded}
            expanded={expanded}
            onToggle={onToggle}
            onListDir={onListDir}
            onRefreshDir={onRefreshDir}
            onSelect={onSelect}
            onDeleteRequest={onDeleteRequest}
            onRemap={onRemap}
            pendingCreate={pendingCreate}
            onCreateConsumed={onCreateConsumed}
          />
        </div>
        <div
          className="nn-primary-sidebar-panel"
          hidden={sidebarPanel !== "search"}
          inert={sidebarPanel === "search" ? undefined : true}
        >
          <SearchPanel
            focusSignal={searchFocusSignal}
            queryRequest={searchQueryRequest}
            onOpen={openNoteAt}
          />
        </div>
      </div>
      {sidebarPanel !== null && (
        <PaneSplitter
          paneId="nn-primary-sidebar"
          width={effectiveLayout.sidebarWidth}
          minWidth={SIDEBAR_MIN_WIDTH}
          maxWidth={effectiveLayout.sidebarMaxWidth}
          onResize={(sidebarWidth) =>
            setLayoutPreference((current) => ({ ...current, sidebarWidth }))
          }
        />
      )}
      {centerView === "graph" ? (
        <div
          id={GRAPH_PANEL_ID}
          role="tabpanel"
          aria-labelledby={GRAPH_TAB_ID}
          tabIndex={0}
          className="flex min-w-0 flex-1"
        >
          <GraphView onOpenNote={onOpenNote} />
        </div>
      ) : (
        <div
          id={activeTabId ? noteTabPanelId(activeTabId) : "nn-empty-note-panel"}
          role="tabpanel"
          aria-labelledby={activeTabId ? noteTabTriggerId(activeTabId) : undefined}
          tabIndex={activeTabId ? 0 : -1}
          className="flex min-w-0 flex-1"
        >
          <NotePane
            open={open}
            noteIndex={noteIndex}
            onOpenLink={onOpenNote}
            onSearchTag={onSearchTag}
            reportError={reportError}
          />
        </div>
      )}
      {/* Keep ChatPane mounted and collapse only its clipping slot. Unmounting
          would discard the transcript and abandon an in-flight streamed answer;
          inert + aria-hidden remove the collapsed controls from interaction. */}
      <div
        className="nn-chat-slot"
        data-visible={showChat}
        aria-hidden={!showChat}
        inert={!showChat}
      >
        <ChatPane
          openNoteAt={openNoteAt}
          onOpenSettings={onOpenChatSettings}
          refreshSignal={aiStatusVersion}
        />
      </div>
    </div>
  );
}
