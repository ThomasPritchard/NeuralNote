// The workspace: ribbon · file tree / search panel · reader/editor / graph ·
// cited-chat stub · status bar. This orchestrator owns the multi-note tab state,
// the Workspace-local view state (which sidebar panel and
// center view are showing — deliberately NOT in the vault store), and the
// glue that keeps tabs honest when the tree mutates underneath them. Navigation
// preserves dirty tabs; destructive tab, vault, and window actions share one
// explicit unsaved-edit guard.
// Tree CRUD lives in FileTree; lifecycle errors flow from the store.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import { useVault } from "../lib/store";
import { useToast } from "../notifications";
import type { TreeNode, WorkspaceState } from "../lib/types";
import { ChatPane } from "./ChatPane";
import { ConfirmDialog } from "./ConfirmDialog";
import { FileTree } from "./FileTree";
import { normSep } from "./fileMeta";
import { GraphView } from "./GraphView";
import { buildNoteIndex, type NoteIndexEntry } from "./linkResolve";
import { NotePane } from "./NotePane";
import { Ribbon, type CenterView, type SidebarPanel } from "./Ribbon";
import { SearchPanel } from "./SearchPanel";
import { SettingsModal, type SettingsSection } from "./SettingsModal";
import { StatusBar } from "./StatusBar";
import { TemplateInsertDialog } from "./TemplateInsertDialog";
import {
  GRAPH_PANEL_ID,
  GRAPH_TAB_ID,
  noteTabPanelId,
  noteTabTriggerId,
  TitleBar,
  type TitleBarTabSummary,
} from "./TitleBar";
import type { CreateKind } from "./TreeRow";
import { useNoteTabs, type NoteTab } from "./useNoteTabs";
import { createWorkspaceStateWriter } from "./workspaceStateWriter";

type PendingIntent =
  | { kind: "close-tab"; tabId: string; restoreFocus: HTMLElement | null }
  | { kind: "close-vault" }
  | { kind: "close-window" }
  | { kind: "quit-app" }
  | { kind: "open-vault" }
  | { kind: "open-recent"; path: string }
  | { kind: "delete-entry"; node: TreeNode; dirtyCount: number };

function tabRelativePath(vaultPath: string, tab: NoteTab): string | null {
  if (tab.note?.relPath) return tab.note.relPath;
  const root = `${normSep(vaultPath).replace(/\/$/, "")}/`;
  const path = normSep(tab.path);
  return path.startsWith(root) ? path.slice(root.length) : null;
}

function persistedWorkspaceState(
  vaultPath: string,
  tabs: readonly NoteTab[],
  activeTabId: string | null,
): WorkspaceState {
  const paths = new Map<string, string>();
  for (const tab of tabs) {
    const relative = tabRelativePath(vaultPath, tab);
    if (relative) paths.set(tab.id, relative);
  }
  return {
    openPaths: [...paths.values()],
    activePath: activeTabId ? (paths.get(activeTabId) ?? null) : null,
  };
}

export function Workspace() {
  const {
    vault,
    tree,
    refreshTree,
    close,
    openExisting,
    openByPath,
    error,
    clearError,
    reportError,
  } = useVault();
  const toast = useToast();
  const noteTabs = useNoteTabs();
  const open = noteTabs.active;
  const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null);
  // Workspace-local view state (specs/search-and-graph-view.md §View model).
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("files");
  const [centerView, setCenterView] = useState<CenterView>("note");
  // React owns sidebar visibility outright: the native "Toggle Sidebar" menu item
  // is a plain MenuItem with no checkmark, so there's no state-sync obligation back
  // to Rust (unlike the chat toggle's CheckMenuItem, synced via setChatVisible).
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Whether the cited-recall chat panel is shown. The webview owns this state now;
  // an effect below pushes each change to Rust, which keeps a copy only to paint the
  // View-menu checkmark (mirrors the editing → setMenuEditing pattern).
  const [showChat, setShowChat] = useState(true);
  // A menu-requested "new note/folder" awaiting the FileTree to open its inline
  // create row; cleared once consumed so it can't re-fire on a sidebar remount.
  const [pendingCreate, setPendingCreate] = useState<CreateKind | null>(null);
  // Bumped whenever ⌘K / the ribbon Search icon wants the search field focused.
  const [searchFocusSignal, bumpSearchFocus] = useReducer((n: number) => n + 1, 0);
  // Settings modal state, plus a version bumped when it closes so the chat
  // pane re-reads the AI status (a provider configured in Settings must reach
  // the pane without remounting it and wiping the transcript).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [templateInsertOpen, setTemplateInsertOpen] = useState(false);
  const [templates, setTemplates] = useState<Awaited<ReturnType<typeof api.listTemplates>>>([]);
  const [aiStatusVersion, bumpAiStatusVersion] = useReducer((n: number) => n + 1, 0);

  // Stable callbacks read the latest collection without re-registering native
  // listeners on every editor keystroke.
  const noteTabsRef = useRef(noteTabs);
  noteTabsRef.current = noteTabs;
  const pendingIntentRef = useRef(pendingIntent);
  pendingIntentRef.current = pendingIntent;
  const quitInFlightRef = useRef(false);
  const [workspaceStateReady, setWorkspaceStateReady] = useState(false);
  const [workspaceStateBlocked, setWorkspaceStateBlocked] = useState(false);
  const activeVaultPathRef = useRef<string | null>(null);
  const restorePlanRef = useRef<{
    ids: string[];
    desiredId: string | null;
  } | null>(null);
  const workspaceWriterRef = useRef<ReturnType<
    typeof createWorkspaceStateWriter
  > | null>(null);
  if (workspaceWriterRef.current === null) {
    workspaceWriterRef.current = createWorkspaceStateWriter(
      api.saveWorkspaceState,
      (writeError) =>
        toast.error(api.errorMessage(writeError), {
          dedupKey: "workspace-state-save",
        }),
    );
  }

  /** Force-close the window past the close-request guard. If destroy() rejects the
   *  window is merely left open (safe — no data lost), so log rather than swallow. */
  const closeWindow = useCallback(async () => {
    try {
      await getCurrentWindow().destroy();
    } catch (err) {
      console.error("window destroy failed:", err);
    }
  }, []);

  /** Open a note by absolute path. Dirty active tabs are preserved by the tab
   *  controller, so navigation itself is never destructive and never prompts. */
  const openNoteAt = useCallback(
    (absPath: string, forceNew = false) => {
      noteTabsRef.current.open(absPath, { forceNew });
      setCenterView("note");
    },
    [],
  );

  const vaultPath = vault?.path;

  useEffect(() => {
    if (!vaultPath) {
      activeVaultPathRef.current = null;
      return;
    }
    if (
      activeVaultPathRef.current !== null &&
      activeVaultPathRef.current !== vaultPath
    ) {
      noteTabsRef.current.clear();
    }
    activeVaultPathRef.current = vaultPath;
    let cancelled = false;
    let recoveryToastId: string | null = null;
    setWorkspaceStateReady(false);
    setWorkspaceStateBlocked(false);
    restorePlanRef.current = null;

    void api
      .loadWorkspaceState()
      .then((loaded) => {
        if (cancelled) return;
        if (loaded.recoveredFromCorrupt) {
          setWorkspaceStateBlocked(true);
          setWorkspaceStateReady(true);
          recoveryToastId = toast.error(
            loaded.recoveryMessage ?? "Workspace tab state could not be restored.",
            {
              dedupKey: "workspace-state-recovery",
              action: {
                label: "Reset tab state",
                onClick: () => {
                  if (
                    cancelled ||
                    activeVaultPathRef.current !== vaultPath
                  ) {
                    return;
                  }
                  void api
                    .resetWorkspaceState()
                    .then(() => {
                      if (cancelled) return;
                      setWorkspaceStateBlocked(false);
                      workspaceWriterRef.current?.schedule(
                        persistedWorkspaceState(
                          vaultPath,
                          noteTabsRef.current.tabs,
                          noteTabsRef.current.activeTabId,
                        ),
                      );
                    })
                    .catch((resetError) =>
                      toast.error(api.errorMessage(resetError), {
                        dedupKey: "workspace-state-reset",
                      }),
                    );
                },
              },
            },
          );
          return;
        }

        const ids: string[] = [];
        let desiredId: string | null = null;
        for (const relativePath of loaded.state.openPaths) {
          const id = noteTabsRef.current.open(`${vaultPath}/${relativePath}`, {
            forceNew: true,
          });
          ids.push(id);
          if (relativePath === loaded.state.activePath) desiredId = id;
        }
        if (ids.length === 0) {
          setWorkspaceStateReady(true);
        } else {
          restorePlanRef.current = { ids, desiredId };
        }
      })
      .catch((loadError) => {
        if (cancelled) return;
        setWorkspaceStateBlocked(true);
        setWorkspaceStateReady(true);
        toast.error(api.errorMessage(loadError), {
          dedupKey: "workspace-state-load",
        });
      });

    return () => {
      cancelled = true;
      if (recoveryToastId) toast.dismiss(recoveryToastId);
    };
  }, [toast, vaultPath]);

  useEffect(() => {
    const plan = restorePlanRef.current;
    if (!plan) return;
    const tracked = noteTabs.tabs.filter((tab) => plan.ids.includes(tab.id));
    if (tracked.some((tab) => tab.loading)) return;

    const restored = tracked.filter((tab) => tab.note !== null && tab.error === null);
    const failed = tracked.filter((tab) => tab.note === null || tab.error !== null);
    for (const tab of failed) noteTabs.close(tab.id);
    const desired = restored.find((tab) => tab.id === plan.desiredId);
    const fallback = desired ?? restored[0] ?? null;
    if (fallback) {
      noteTabs.activate(fallback.id);
      setCenterView("note");
    }
    if (failed.length > 0) {
      toast.warning(
        `${failed.length} saved ${failed.length === 1 ? "tab was" : "tabs were"} skipped because the note could not be opened.`,
        { dedupKey: "workspace-state-missing-notes" },
      );
    }
    restorePlanRef.current = null;
    setWorkspaceStateReady(true);
  }, [noteTabs, noteTabs.tabs, toast]);

  useEffect(() => {
    if (!vaultPath || !workspaceStateReady || workspaceStateBlocked) return;
    workspaceWriterRef.current?.schedule(
      persistedWorkspaceState(vaultPath, noteTabs.tabs, noteTabs.activeTabId),
    );
  }, [noteTabs.activeTabId, noteTabs.tabs, vaultPath, workspaceStateBlocked, workspaceStateReady]);

  useEffect(
    () => () => {
      void workspaceWriterRef.current?.flush();
    },
    [],
  );

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

  /** Wikilink/markdown-link resolution index over the loaded tree, shared by
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
      children: tree,
    });
  }, [vault, tree]);

  const handleSelect = useCallback(
    (path: string, forceNew: boolean) => {
      if (!forceNew && path === noteTabsRef.current.active.path) return;
      openNoteAt(path, forceNew);
    },
    [openNoteAt],
  );

  const handleOpenSettings = useCallback((section: SettingsSection = "general") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    if (!error) return;
    toast.error(error, { dedupKey: `vault-error:${error}` });
    clearError();
  }, [clearError, error, toast]);

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
    } catch (error) {
      toast.error(api.errorMessage(error));
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
          await refreshTree();
          setTemplateInsertOpen(false);
          openNoteAt(created.path);
        } catch (error) {
          reportError(api.errorMessage(error));
        }
      })();
    },
    [openNoteAt, refreshTree, reportError],
  );
  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
    bumpAiStatusVersion();
  }, []);

  /** Show a sidebar panel. Both force the sidebar open: selecting a panel that
   *  stays hidden is a silent no-op, and every caller — the ribbon icons, the
   *  View menu, ⌘K — means "show me this", not "pre-select it for later". */
  const handleShowFiles = useCallback(() => {
    setSidebarOpen(true);
    setSidebarPanel("files");
  }, []);
  const handleShowSearch = useCallback(() => {
    setSidebarOpen(true);
    setSidebarPanel("search");
    bumpSearchFocus();
  }, []);
  const handleToggleGraph = useCallback(
    () => setCenterView((v) => (v === "graph" ? "note" : "graph")),
    [],
  );
  const consumeCreate = useCallback(() => setPendingCreate(null), []);

  /** Arm an inline create in the FileTree: force the sidebar open on the Files
   *  panel — its create row lives ONLY there, so a collapsed or Search sidebar
   *  would swallow the action — then set pendingCreate. Shared by the New
   *  Note/Folder menu items and the titlebar vault menu (four call sites). */
  const startCreate = useCallback((kind: CreateKind) => {
    setSidebarOpen(true);
    setSidebarPanel("files");
    setPendingCreate(kind);
  }, []);

  const handleRemap = useCallback((oldPath: string, newNode: TreeNode) => {
    noteTabsRef.current.remap(oldPath, newNode.path, newNode.relPath);
  }, []);

  const performIntent = useCallback(
    async (intent: PendingIntent) => {
      switch (intent.kind) {
        case "close-tab": {
          const tabs = noteTabsRef.current.tabs;
          const closingIndex = tabs.findIndex((tab) => tab.id === intent.tabId);
          const wasActive = noteTabsRef.current.activeTabId === intent.tabId;
          const focusTabId = wasActive
            ? (tabs[closingIndex + 1]?.id ?? tabs[closingIndex - 1]?.id ?? null)
            : noteTabsRef.current.activeTabId;
          noteTabsRef.current.close(intent.tabId);
          queueMicrotask(() => {
            const target = focusTabId
              ? document.getElementById(noteTabTriggerId(focusTabId))
              : document.getElementById("nn-empty-note-panel");
            target?.focus();
          });
          return;
        }
        case "close-vault":
          await workspaceWriterRef.current?.flush();
          await close();
          return;
        case "close-window":
          await workspaceWriterRef.current?.flush();
          await closeWindow();
          return;
        case "quit-app":
          if (quitInFlightRef.current) return;
          quitInFlightRef.current = true;
          try {
            await workspaceWriterRef.current?.flush();
            await api.quitApp();
          } catch (quitError) {
            quitInFlightRef.current = false;
            toast.error(api.errorMessage(quitError), {
              dedupKey: "quit-app-failed",
            });
          }
          return;
        case "open-vault":
          await workspaceWriterRef.current?.flush();
          await openExisting();
          return;
        case "open-recent":
          await workspaceWriterRef.current?.flush();
          await openByPath(intent.path);
          return;
        case "delete-entry":
          try {
            await api.deleteEntry(intent.node.path);
            await refreshTree();
            noteTabsRef.current.removeDescendants(intent.node.path);
          } catch (deleteError) {
            toast.error(api.errorMessage(deleteError));
          }
      }
    },
    [close, closeWindow, openByPath, openExisting, refreshTree, toast],
  );

  const requestIntent = useCallback(
    (intent: PendingIntent) => {
      if (pendingIntentRef.current) return;
      const mustConfirm =
        intent.kind === "delete-entry" ||
        (intent.kind === "close-tab"
          ? Boolean(
              noteTabsRef.current.tabs.find((tab) => tab.id === intent.tabId)
                ?.dirty,
            )
          : noteTabsRef.current.dirtyTabs.length > 0);
      if (mustConfirm) {
        pendingIntentRef.current = intent;
        setPendingIntent(intent);
      } else {
        void performIntent(intent);
      }
    },
    [performIntent],
  );

  const handleDeleteRequest = useCallback(
    (node: TreeNode) => {
      const dirtyCount = noteTabsRef.current
        .tabsInside(node.path)
        .filter((tab) => tab.dirty).length;
      requestIntent({ kind: "delete-entry", node, dirtyCount });
    },
    [requestIntent],
  );

  const handleCloseVault = useCallback(
    () => requestIntent({ kind: "close-vault" }),
    [requestIntent],
  );

  // Intercept OS window close / Cmd-Q: hold the window long enough to flush the
  // ordered workspace state, and route dirty tabs through the same discard guard
  // as other destructive actions. Mirrors store.tsx's
  // cancelled-flag teardown so a listen() that resolves after unmount can't leak.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        // Always hold the native close briefly so the newest ordered tab state can
        // flush before destroy. Dirty tabs route through the same explicit warning.
        event.preventDefault();
        requestIntent({ kind: "close-window" });
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        // If the guard can't install, an OS close would silently discard unsaved
        // edits — surface it to the user (not just the console) so they know the
        // unsaved-changes protection is off and can save manually.
        console.error("failed to install unsaved-edit close guard:", err);
        reportError(
          "Couldn't enable the unsaved-changes guard — save manually before closing the window.",
        );
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reportError, requestIntent]);

  // Native menu → vault-scoped actions. While Workspace is mounted it also owns
  // Open Vault / Open Recent so every dirty tab can guard the vault switch.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void api
      .onMenu((e) => {
        const o = noteTabsRef.current.active;
        switch (e.action) {
          // New Note/Folder + the view-switch actions all force the sidebar open
          // (via startCreate / handleShow*): their effect is invisible while it's
          // collapsed, so a menu-driven create/search would otherwise silently no-op.
          case "new-note":
            startCreate("note");
            break;
          case "new-folder":
            startCreate("folder");
            break;
          case "save":
            if (o.note && o.dirty && !o.saving) void o.save();
            break;
          case "toggle-mode":
            if (o.note && !o.note.binary) {
              o.setMode(o.mode === "edit" ? "read" : "edit");
            }
            break;
          case "close-tab": {
            const tabId = noteTabsRef.current.activeTabId;
            if (tabId) {
              requestIntent({
                kind: "close-tab",
                tabId,
                restoreFocus: document.activeElement as HTMLElement | null,
              });
            }
            break;
          }
          case "close-window":
            requestIntent({ kind: "close-window" });
            break;
          case "quit-app":
            requestIntent({ kind: "quit-app" });
            break;
          case "close-vault":
            requestIntent({ kind: "close-vault" });
            break;
          case "open-vault":
            requestIntent({ kind: "open-vault" });
            break;
          case "open-recent":
            if (e.path) requestIntent({ kind: "open-recent", path: e.path });
            break;
          case "search":
          case "view-search":
            handleShowSearch();
            break;
          case "view-files":
            handleShowFiles();
            break;
          case "toggle-graph":
            setCenterView((v) => (v === "graph" ? "note" : "graph"));
            break;
          case "toggle-chat":
            // The webview owns showChat; the CheckMenuItem just requests a flip
            // (no `checked` payload). The effect below pushes the new value to Rust.
            setShowChat((v) => !v);
            break;
          case "toggle-sidebar":
            setSidebarOpen((v) => !v);
            break;
          default:
            break;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      // A failed listen leaves every vault-scoped menu item dead — Save most of
      // all, which now lives ONLY on the menu. The store's own onMenu subscription
      // covers just Open Vault/Recent and has already resolved by the time this
      // one runs (it's mounted from app start), so it can't surface this for us.
      // Surface it here so a silently-dead Save can never masquerade as working.
      .catch((err) => {
        console.error("failed to subscribe to menu actions:", err);
        reportError(
          "Menu actions are unavailable — use the on-screen controls, and save with the Save button.",
        );
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reportError, requestIntent, startCreate, handleShowFiles, handleShowSearch]);

  // Keep the native Format menu honest: those items act on the editor's textarea,
  // which is mounted only when a text note is open in edit mode. Push that fact to
  // Rust so it enables Format only then. Best-effort — the enabled state is
  // cosmetic, and Rust skips the rebuild when the flag is unchanged.
  const editing = !!open.note && !open.note.binary && open.mode === "edit";
  useEffect(() => {
    void api
      .setMenuEditing(editing)
      .catch((err) => console.error("failed to sync editor state to the menu:", err));
  }, [editing]);

  // The webview owns showChat; push each change to Rust so the View-menu checkmark
  // stays in agreement (mirrors the editing effect above). Best-effort — cosmetic.
  useEffect(() => {
    void api.setChatVisible(showChat).catch((err) =>
      console.error("failed to sync chat visibility to the menu:", err));
  }, [showChat]);

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

  const discardMessage = useMemo(() => {
    if (!pendingIntent) return "";
    if (pendingIntent.kind === "delete-entry") {
      const dirtyWarning =
        pendingIntent.dirtyCount > 0
          ? ` ${pendingIntent.dirtyCount} open ${pendingIntent.dirtyCount === 1 ? "tab has" : "tabs have"} unsaved changes that will be lost.`
          : "";
      return `“${pendingIntent.node.name}” will be moved to the Trash.${dirtyWarning}`;
    }
    if (pendingIntent.kind === "close-tab") {
      return "This note has edits that haven't been saved. If you continue, they'll be lost.";
    }
    const count = noteTabs.dirtyTabs.length;
    return `${count} open ${count === 1 ? "note has" : "notes have"} unsaved changes. If you continue, they'll be lost.`;
  }, [noteTabs.dirtyTabs.length, pendingIntent]);

  if (!vault) return null;

  return (
    <div className="nn-app-shell flex h-full w-full flex-col bg-background text-foreground">
      <TitleBar
        vaultName={vault.name}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        chatOpen={showChat}
        onToggleChat={() => setShowChat((v) => !v)}
        onOpenSettings={handleOpenSettings}
        tabs={titlebarTabs}
        activeTabId={noteTabs.activeTabId}
        activeView={centerView === "graph" ? "graph" : "note"}
        onActivateTab={handleActivateTab}
        onCloseTab={handleCloseTab}
        onCloseGraph={handleCloseGraph}
        onNewNote={() => startCreate("note")}
        onNewFolder={() => startCreate("folder")}
        onRefresh={() => void refreshTree()}
        onCloseVault={handleCloseVault}
      />
      <div
        id="nn-main-content"
        tabIndex={-1}
        data-testid="workspace-panes"
        className="nn-workspace-panes flex min-h-0 flex-1 overflow-hidden outline-none"
      >
        <Ribbon
          sidebarPanel={sidebarPanel}
          centerView={centerView}
          onShowFiles={handleShowFiles}
          onShowSearch={handleShowSearch}
          onInsertTemplate={() => void handleInsertTemplate()}
          onToggleGraph={handleToggleGraph}
        />
        {/* Collapse the sidebar by UNMOUNTING it (not display:none): FileTree
            already unmounts on the Files↔Search swap, and its folder folds
            persist to localStorage, so there's no live in-memory state to lose.
            Contrast ChatPane below, which is deliberately kept mounted because it
            owns a live streamed IPC Channel that unmounting would kill. */}
        {sidebarOpen &&
          (sidebarPanel === "files" ? (
            <FileTree
              vaultPath={vault.path}
              tree={tree}
              activePath={open.path}
              refreshTree={refreshTree}
              onSelect={handleSelect}
              onDeleteRequest={handleDeleteRequest}
              onRemap={handleRemap}
              pendingCreate={pendingCreate}
              onCreateConsumed={consumeCreate}
            />
          ) : (
            <SearchPanel focusSignal={searchFocusSignal} onOpen={openNoteAt} />
          ))}
        {centerView === "graph" ? (
          <div
            id={GRAPH_PANEL_ID}
            role="tabpanel"
            aria-labelledby={GRAPH_TAB_ID}
            tabIndex={0}
            className="flex min-w-0 flex-1"
          >
            <GraphView onOpenNote={openNoteRel} />
          </div>
        ) : (
          <div
            id={
              noteTabs.activeTabId
                ? noteTabPanelId(noteTabs.activeTabId)
                : "nn-empty-note-panel"
            }
            role={noteTabs.activeTabId ? "tabpanel" : undefined}
            aria-labelledby={
              noteTabs.activeTabId
                ? noteTabTriggerId(noteTabs.activeTabId)
                : undefined
            }
            tabIndex={noteTabs.activeTabId ? 0 : -1}
            className="flex min-w-0 flex-1"
          >
            <NotePane
              open={open}
              noteIndex={noteIndex}
              onOpenLink={openNoteRel}
              reportError={reportError}
            />
          </div>
        )}
        {/* Keep ChatPane mounted and toggle it with CSS, never conditionally
            unmount it: unmounting would discard the cited-recall transcript and
            silently abandon an in-flight streamed answer (the Rust `chat` call
            would run against a dead channel). Using `display:contents` lets its
            <aside> sit in the flex row as if unwrapped; `none` drops the subtree
            from layout while React keeps it — and its stream — alive. */}
        <div className="nn-chat-slot" data-visible={showChat} hidden={!showChat}>
          <ChatPane
            openNoteAt={openNoteAt}
            onOpenSettings={() => handleOpenSettings("ai")}
            refreshSignal={aiStatusVersion}
          />
        </div>
      </div>

      <StatusBar vaultName={vault.name} tree={tree} note={open.note} />

      <SettingsModal
        open={settingsOpen}
        onClose={handleCloseSettings}
        initialSection={settingsSection}
      />
      <TemplateInsertDialog
        open={templateInsertOpen}
        templates={templates}
        vaultPath={vault.path}
        tree={tree}
        onCreate={handleCreateFromTemplate}
        onClose={() => setTemplateInsertOpen(false)}
      />

      {pendingIntent && (
        <ConfirmDialog
          title={
            pendingIntent.kind === "delete-entry"
              ? `Delete ${pendingIntent.node.kind === "folder" ? "folder" : "note"}?`
              : "Discard unsaved changes?"
          }
          message={discardMessage}
          confirmLabel={
            pendingIntent.kind === "delete-entry" ? "Move to Trash" : "Discard"
          }
          tone="danger"
          onConfirm={() => {
            const intent = pendingIntent;
            pendingIntentRef.current = null;
            setPendingIntent(null);
            void performIntent(intent);
          }}
          onCancel={() => {
            const restoreFocus =
              pendingIntent.kind === "close-tab"
                ? pendingIntent.restoreFocus
                : null;
            pendingIntentRef.current = null;
            setPendingIntent(null);
            queueMicrotask(() => restoreFocus?.focus());
          }}
        />
      )}
    </div>
  );
}
