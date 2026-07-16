// The workspace: navigation · file tree / search panel · reader/editor / graph ·
// cited-chat stub · status bar. This orchestrator owns the multi-note tab state,
// the shared open-by-path handlers, the settings/template dialogs, and the native
// menu + window-close wiring that ties every concern together. The three concern
// clusters it used to hold inline now live in co-located hooks:
//   · useWorkspaceLayout      — sidebar/navigation geometry, panel routing, search signals
//   · useWorkspaceLifecycle   — durable tab state + the destructive-action guard
//   · workspaceIntents        — the pure copy/serialisation behind those two
// and the central panes subtree renders through WorkspacePanes. The menu/close
// subscriptions stay here on purpose — they dispatch across all three concerns.
// Tree CRUD lives in FileTree; lifecycle errors flow from the store.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import * as api from "../lib/api";
import { useVault } from "../lib/store";
import { useToast } from "../notifications";
import type { TreeNode } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { vaultRelPath } from "./fileMeta";
import { useVaultTree } from "./useVaultTree";
import { buildNoteIndex, type NoteIndexEntry } from "./linkResolve";
import { type CenterView } from "./Ribbon";
import { SettingsModal, type SettingsSection } from "./SettingsModal";
import { StatusBar } from "./StatusBar";
import { TemplateInsertDialog } from "./TemplateInsertDialog";
import { TitleBar, type TitleBarTabSummary } from "./TitleBar";
import type { CreateKind } from "./TreeRow";
import { useNoteTabs } from "./useNoteTabs";
import { useWorkspaceLayout } from "./useWorkspaceLayout";
import { useWorkspaceLifecycle } from "./useWorkspaceLifecycle";
import { useWorkspaceMenu } from "./useWorkspaceMenu";
import { WorkspacePanes } from "./WorkspacePanes";
import {
  confirmDialogLabel,
  confirmDialogTitle,
  isEditableTextNote,
} from "./workspaceIntents";

export function Workspace() {
  const {
    vault,
    loaded,
    expanded,
    listDir,
    toggle,
    refreshDir,
    close,
    openExisting,
    openByPath,
    error,
    clearError,
    reportError,
  } = useVault();
  // The lazy store (issue #40) no longer holds the whole tree — it loads
  // directories on demand for the FileTree DISPLAY. But wikilink/`[[` resolution
  // (buildNoteIndex), the status-bar counts, and the template folder picker all
  // need the WHOLE vault (a link into an unexpanded folder must still resolve —
  // moat-adjacent). This keeps a full read_tree for those consumers only, while
  // the sidebar tree stays lazy. `reportError` is a stable useCallback, so this
  // doesn't re-read every render.
  const { tree: fullTree, refresh: refreshFullTree } = useVaultTree(
    vault?.path,
    reportError,
  );
  const toast = useToast();
  const noteTabs = useNoteTabs();
  const open = noteTabs.active;
  // Workspace-local view state (specs/search-and-graph-view.md §View model).
  const [centerView, setCenterView] = useState<CenterView>("note");
  // Whether the cited-recall chat panel is shown. The webview owns this state now;
  // an effect below pushes each change to Rust, which keeps a copy only to paint the
  // View-menu checkmark (mirrors the editing → setMenuEditing pattern).
  const [showChat, setShowChat] = useState(true);
  // A menu-requested "new note/folder" awaiting the FileTree to open its inline
  // create row; cleared once consumed so it can't re-fire on a sidebar remount.
  const [pendingCreate, setPendingCreate] = useState<CreateKind | null>(null);
  // Settings modal state, plus a version bumped when it closes so the chat
  // pane re-reads the AI status (a provider configured in Settings must reach
  // the pane without remounting it and wiping the transcript).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("whatsNew");
  const [templateInsertOpen, setTemplateInsertOpen] = useState(false);
  const [templates, setTemplates] = useState<Awaited<ReturnType<typeof api.listTemplates>>>([]);
  const [aiStatusVersion, bumpAiStatusVersion] = useReducer((n: number) => n + 1, 0);

  const vaultPath = vault?.path;

  // Layout geometry + panel routing + search signals (effects: save layout, measure).
  const {
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
  } = useWorkspaceLayout(showChat, vaultPath);

  // Durable tab state + destructive-action guard (effects: load, restore, write, flush).
  const {
    pendingIntent,
    requestIntent,
    handleDeleteRequest,
    handleCloseVault,
    discardMessage,
    confirmPendingIntent,
    cancelPendingIntent,
  } = useWorkspaceLifecycle({
    vaultPath,
    noteTabs,
    toast,
    setCenterView,
    close,
    openExisting,
    openByPath,
    refreshDir,
  });

  // Stable callbacks read the latest tabs without re-registering native listeners
  // on every editor keystroke.
  const noteTabsRef = useRef(noteTabs);
  noteTabsRef.current = noteTabs;

  /** Open a note by absolute path. Dirty active tabs are preserved by the tab
   *  controller, so navigation itself is never destructive and never prompts. */
  const openNoteAt = useCallback((absPath: string, forceNew = false) => {
    noteTabsRef.current.open(absPath, { forceNew });
    setCenterView("note");
  }, []);

  /** Open a note by vault-relative path (graph nodes, wikilinks, backlink
   *  sources); joins onto the vault root, same as ChatPane's citation-open.
   *  The plain join is safe — the backend canonicalizes through
   *  ensure_within, and mockVault keys entries exactly this way. */
  const openNoteRel = useCallback(
    (relPath: string) => {
      if (vaultPath) openNoteAt(`${vaultPath}/${relPath}`);
    },
    [openNoteAt, vaultPath],
  );

  /** Wikilink/markdown-link resolution index over the full vault tree, shared by
   *  the reader (clickable links) and editor (`[[` autocomplete). Memoized on
   *  the tree — it only rebuilds when the vault actually rescans. */
  const noteIndex = useMemo<NoteIndexEntry[]>(() => {
    if (!vault) return [];
    return buildNoteIndex({
      kind: "folder",
      name: vault.name,
      path: vault.path,
      relPath: "",
      ext: null,
      children: fullTree,
    });
  }, [vault, fullTree]);

  const handleSelect = useCallback(
    (path: string, forceNew: boolean) => {
      if (!forceNew && path === noteTabsRef.current.active.path) return;
      openNoteAt(path, forceNew);
    },
    [openNoteAt],
  );

  const handleOpenSettings = useCallback((section: SettingsSection = "whatsNew") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const handleInsertTemplate = useCallback(async () => {
    try {
      const listed = await api.listTemplates();
      if (listed.length === 0) {
        toast.warning("No templates found", {
          dedupKey: "no-templates",
          action: {
            label: "Open template settings",
            onClick: () => handleOpenSettings("templates"),
          },
        });
        return;
      }
      setTemplates(listed);
      setTemplateInsertOpen(true);
    } catch (settingsError) {
      toast.error(api.errorMessage(settingsError));
    }
  }, [handleOpenSettings, toast]);

  const handleCreateFromTemplate = useCallback(
    (template: string, name: string, parentPath: string) => {
      void (async () => {
        try {
          const created = await api.createNoteFromTemplate(
            parentPath,
            name,
            template,
          );
          // Re-list just the destination folder (targeted, per spec §CRUD).
          if (vaultPath) await refreshDir(vaultRelPath(parentPath, vaultPath));
          setTemplateInsertOpen(false);
          openNoteAt(created.path);
        } catch (createError) {
          reportError(api.errorMessage(createError));
        }
      })();
    },
    [openNoteAt, refreshDir, reportError, vaultPath],
  );
  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
    bumpAiStatusVersion();
  }, []);

  const handleToggleGraph = useCallback(
    () => setCenterView((v) => (v === "graph" ? "note" : "graph")),
    [],
  );
  const consumeCreate = useCallback(() => setPendingCreate(null), []);

  // Manual "Refresh" (Ribbon): re-list every currently-loaded directory in
  // place. Unexpanded folders aren't loaded, so there's nothing to refresh for
  // them — they fetch fresh on their next expand. Also re-read the whole-vault
  // tree that feeds the wikilink index, counts, and template picker — the manual
  // refresh must NOT depend on the disk watcher (working around a dead watcher is
  // exactly why this button exists), or those consumers would stay silently stale.
  const handleRefreshTree = useCallback(() => {
    for (const relPath of loaded.keys()) void refreshDir(relPath);
    refreshFullTree();
  }, [loaded, refreshDir, refreshFullTree]);

  /** Arm an inline create in the FileTree and select its owning Files pane. */
  const startCreate = useCallback((kind: CreateKind) => {
    selectFiles();
    setPendingCreate(kind);
  }, [selectFiles]);

  const handleRemap = useCallback((oldPath: string, newNode: TreeNode) => {
    noteTabsRef.current.remap(oldPath, newNode.path, newNode.relPath);
  }, []);

  useEffect(() => {
    if (!error) return;
    toast.error(error, { dedupKey: `vault-error:${error}` });
    clearError();
  }, [clearError, error, toast]);

  // Native menu + window-close integration (effects: close guard, menu dispatch,
  // Format-menu sync, chat-visibility sync). It dispatches across every concern,
  // so it takes their handlers; called last so its effects run after the others.
  const editing = isEditableTextNote(open.note);
  useWorkspaceMenu({
    noteTabs,
    requestIntent,
    reportError,
    startCreate,
    selectFiles,
    selectSearch,
    toggleNavigation,
    setCenterView,
    setShowChat,
    editing,
    showChat,
  });

  const titlebarTabs = useMemo<TitleBarTabSummary[]>(
    () =>
      noteTabs.tabs.map((tab) => ({
        id: tab.id,
        title:
          tab.note?.title ??
          tab.path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ??
          "Untitled",
        path: tab.path,
        dirty: tab.dirty,
        loading: tab.loading,
        error: tab.error,
      })),
    [noteTabs.tabs],
  );

  const handleActivateTab = useCallback((tabId: string) => {
    noteTabsRef.current.activate(tabId);
    setCenterView("note");
  }, []);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      requestIntent({
        kind: "close-tab",
        tabId,
        restoreFocus: document.activeElement as HTMLElement | null,
      });
    },
    [requestIntent],
  );

  const handleCloseGraph = useCallback(() => setCenterView("note"), []);

  if (!vault) return null;

  const layoutStyle = {
    "--navigation-width": `${effectiveLayout.navigationWidth}px`,
    "--sidebar-width": `${effectiveLayout.sidebarWidth}px`,
    "--splitter-width": `${effectiveLayout.splitterWidth}px`,
  } as CSSProperties;

  return (
    <div
      className="nn-app-shell flex h-full w-full flex-col bg-background text-foreground"
      style={layoutStyle}
    >
      <TitleBar
        navigationExpanded={effectiveLayout.navigationExpanded}
        onToggleNavigation={toggleNavigation}
        chatOpen={showChat}
        onToggleChat={() => setShowChat((v) => !v)}
        onOpenSettings={handleOpenSettings}
        tabs={titlebarTabs}
        activeTabId={noteTabs.activeTabId}
        activeView={centerView === "graph" ? "graph" : "note"}
        onActivateTab={handleActivateTab}
        onCloseTab={handleCloseTab}
        onCloseGraph={handleCloseGraph}
      />
      <WorkspacePanes
        panesRef={workspacePanesRef}
        effectiveLayout={effectiveLayout}
        vaultName={vault.name}
        vaultPath={vault.path}
        sidebarPanel={sidebarPanel}
        centerView={centerView}
        setLayoutPreference={setLayoutPreference}
        onShowFiles={handleShowFiles}
        onShowSearch={handleShowSearch}
        onInsertTemplate={() => void handleInsertTemplate()}
        onToggleGraph={handleToggleGraph}
        onNewNote={() => startCreate("note")}
        onNewFolder={() => startCreate("folder")}
        onRefresh={handleRefreshTree}
        onCloseVault={handleCloseVault}
        activePath={open.path}
        loaded={loaded}
        expanded={expanded}
        onToggle={toggle}
        onListDir={listDir}
        onRefreshDir={refreshDir}
        onSelect={handleSelect}
        onDeleteRequest={handleDeleteRequest}
        onRemap={handleRemap}
        pendingCreate={pendingCreate}
        onCreateConsumed={consumeCreate}
        searchFocusSignal={searchFocusSignal}
        searchQueryRequest={searchQueryRequest}
        activeTabId={noteTabs.activeTabId}
        onOpenNote={openNoteRel}
        open={open}
        noteIndex={noteIndex}
        onSearchTag={handleSearchTag}
        reportError={reportError}
        showChat={showChat}
        aiStatusVersion={aiStatusVersion}
        onOpenChatSettings={() => handleOpenSettings("ai")}
        openNoteAt={openNoteAt}
      />

      <StatusBar vaultName={vault.name} tree={fullTree} note={open.note} />

      <SettingsModal
        open={settingsOpen}
        onClose={handleCloseSettings}
        initialSection={settingsSection}
      />
      <TemplateInsertDialog
        open={templateInsertOpen}
        templates={templates}
        vaultPath={vault.path}
        tree={fullTree}
        onCreate={handleCreateFromTemplate}
        onClose={() => setTemplateInsertOpen(false)}
      />

      {pendingIntent && (
        <ConfirmDialog
          title={confirmDialogTitle(pendingIntent)}
          message={discardMessage}
          confirmLabel={confirmDialogLabel(pendingIntent)}
          tone="danger"
          onConfirm={confirmPendingIntent}
          onCancel={cancelPendingIntent}
        />
      )}
    </div>
  );
}
