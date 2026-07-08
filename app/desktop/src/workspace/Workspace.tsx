// The workspace: ribbon · file tree / search panel · reader/editor / graph ·
// cited-chat stub · status bar. This orchestrator owns the open-note state
// (via useOpenNote), the Workspace-local view state (which sidebar panel and
// center view are showing — deliberately NOT in the vault store), and the
// glue that keeps the reader honest when the tree mutates underneath it —
// including a single guard that blocks losing unsaved edits when navigating
// away, and the OS window-close / Cmd-Q path routed through that same guard.
// Tree CRUD lives in FileTree; lifecycle errors flow from the store.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AlertTriangle, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import { useVault } from "../lib/store";
import type { TreeNode } from "../lib/types";
import { ChatPane } from "./ChatPane";
import { ConfirmDialog } from "./ConfirmDialog";
import { FileTree } from "./FileTree";
import { isPathInside, normSep, remapPath } from "./fileMeta";
import { GraphView } from "./GraphView";
import { buildNoteIndex, type NoteIndexEntry } from "./linkResolve";
import { NotePane } from "./NotePane";
import { Ribbon, type CenterView, type SidebarPanel } from "./Ribbon";
import { SearchPanel } from "./SearchPanel";
import { SettingsModal } from "./SettingsModal";
import { StatusBar } from "./StatusBar";
import type { CreateKind } from "./TreeRow";
import { useOpenNote } from "./useOpenNote";

export function Workspace() {
  const { vault, tree, refreshTree, close, error, clearError, reportError } =
    useVault();
  const open = useOpenNote();
  // A deferred action awaiting the user's call on discarding unsaved edits.
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  // Workspace-local view state (specs/search-and-graph-view.md §View model).
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("files");
  const [centerView, setCenterView] = useState<CenterView>("note");
  // Whether the cited-recall chat panel is shown. Menu-owned (View → Cited Recall
  // Panel); the Rust side is the source of truth and sends the new value on toggle.
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
  const [aiStatusVersion, bumpAiStatusVersion] = useReducer((n: number) => n + 1, 0);

  // The latest open-note snapshot, readable from the stable callbacks and the OS
  // close handler below without rebuilding them (or re-registering the window
  // listener) on every keystroke. Keeping the handlers referentially stable lets
  // the memoized FileTree / StatusBar skip the per-keystroke re-render.
  const openRef = useRef(open);
  openRef.current = open;

  /** Run `action` now, or behind a discard confirm when there are unsaved edits. */
  const guard = useCallback((action: () => void) => {
    if (openRef.current.dirty) setPendingDiscard(() => action);
    else action();
  }, []);

  /** Force-close the window past the close-request guard. If destroy() rejects the
   *  window is merely left open (safe — no data lost), so log rather than swallow. */
  const closeWindow = useCallback(() => {
    void getCurrentWindow()
      .destroy()
      .catch((err) => console.error("window destroy failed:", err));
  }, []);

  /** Open a note by absolute path (tree, search result, graph "Open in
   *  reader"). The center-view switch lives INSIDE the guarded action so
   *  cancelling the discard dialog keeps the current view. */
  const openNoteAt = useCallback(
    (absPath: string) =>
      guard(() => {
        openRef.current.open(absPath);
        setCenterView("note");
      }),
    [guard],
  );

  const vaultPath = vault?.path;
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
    (path: string) => {
      if (path === openRef.current.path) return;
      openNoteAt(path);
    },
    [openNoteAt],
  );

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
    bumpAiStatusVersion();
  }, []);

  const handleShowFiles = useCallback(() => setSidebarPanel("files"), []);
  const handleShowSearch = useCallback(() => {
    setSidebarPanel("search");
    bumpSearchFocus();
  }, []);
  const handleToggleGraph = useCallback(
    () => setCenterView((v) => (v === "graph" ? "note" : "graph")),
    [],
  );
  const consumeCreate = useCallback(() => setPendingCreate(null), []);

  const handleDeleted = useCallback((node: TreeNode) => {
    // Clearing the reader if the open note (or its containing folder) was deleted.
    const o = openRef.current;
    if (o.path && isPathInside(o.path, node.path)) o.clear();
  }, []);

  const handleRemap = useCallback((oldPath: string, newNode: TreeNode) => {
    const o = openRef.current;
    if (!o.path) return;
    const newActive = remapPath(o.path, oldPath, newNode.path);
    if (newActive === null) return;
    if (o.dirty) {
      // Preserve the buffer; only the path moved, not the content. Recompute the
      // rel-path from the renamed node plus the suffix below the old path, so the
      // breadcrumb is correct for both a direct rename and an ancestor-folder
      // rename (not only when the open note itself was renamed).
      const suffix = normSep(o.path).slice(normSep(oldPath).length);
      o.repath(newActive, `${newNode.relPath}${suffix}`);
    } else {
      o.open(newActive);
    }
  }, []);

  const handleCloseVault = useCallback(
    () => guard(() => void close()),
    [guard, close],
  );

  // Intercept OS window close / Cmd-Q: if the open note has unsaved edits, hold
  // the window open and route through the same discard guard as in-app
  // navigation; on discard, destroy the window for real. Mirrors store.tsx's
  // cancelled-flag teardown so a listen() that resolves after unmount can't leak.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (!openRef.current.dirty) return; // clean buffer — let the window close
        event.preventDefault(); // hold the window open while we ask
        // TODO(close-vs-pending-discard): if a discard dialog is already open for a
        // pending navigation, this overwrites that action, so confirming "Discard"
        // closes the window instead of doing the queued navigation. Consented-loss
        // UX edge only (no silent data loss). Deferred — round-8.
        setPendingDiscard(() => closeWindow); // discard → force-close (see closeWindow)
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
  }, [closeWindow, reportError]);

  // Native menu → vault-scoped actions. The menu owns the accelerators now (⌘K
  // search and ⌘S save moved off the old per-component keydown handlers), so
  // nothing double-fires. Open Vault / Open Recent live in the store (they work
  // before a vault is open); everything here needs the open vault. Read the
  // latest open-note via openRef so the listener stays registered once.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void api
      .onMenu((e) => {
        const o = openRef.current;
        switch (e.action) {
          case "new-note":
            setSidebarPanel("files");
            setPendingCreate("note");
            break;
          case "new-folder":
            setSidebarPanel("files");
            setPendingCreate("folder");
            break;
          case "save":
            if (o.note && o.dirty && !o.saving) void o.save();
            break;
          case "toggle-mode":
            if (o.note && !o.note.binary) {
              o.setMode(o.mode === "edit" ? "read" : "edit");
            }
            break;
          case "close-vault":
            guard(() => void close());
            break;
          case "search":
          case "view-search":
            setSidebarPanel("search");
            bumpSearchFocus();
            break;
          case "view-files":
            setSidebarPanel("files");
            break;
          case "toggle-graph":
            setCenterView((v) => (v === "graph" ? "note" : "graph"));
            break;
          case "toggle-chat":
            if (typeof e.checked === "boolean") setShowChat(e.checked);
            break;
          default:
            break; // open-vault / open-recent are handled in the store
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
  }, [guard, close, reportError]);

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

  if (!vault) return null;

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <Ribbon
          sidebarPanel={sidebarPanel}
          centerView={centerView}
          onShowFiles={handleShowFiles}
          onShowSearch={handleShowSearch}
          onToggleGraph={handleToggleGraph}
          onOpenSettings={handleOpenSettings}
        />
        {sidebarPanel === "files" ? (
          <FileTree
            vaultName={vault.name}
            vaultPath={vault.path}
            tree={tree}
            activePath={open.path}
            activeDirty={open.dirty}
            refreshTree={refreshTree}
            onSelect={handleSelect}
            onDeleted={handleDeleted}
            onRemap={handleRemap}
            onCloseVault={handleCloseVault}
            pendingCreate={pendingCreate}
            onCreateConsumed={consumeCreate}
          />
        ) : (
          <SearchPanel focusSignal={searchFocusSignal} onOpen={openNoteAt} />
        )}
        {centerView === "graph" ? (
          <GraphView onOpenNote={openNoteRel} />
        ) : (
          <NotePane
            open={open}
            onClose={() => guard(() => openRef.current.clear())}
            noteIndex={noteIndex}
            onOpenLink={openNoteRel}
          />
        )}
        {/* Keep ChatPane mounted and toggle it with CSS, never conditionally
            unmount it: unmounting would discard the cited-recall transcript and
            silently abandon an in-flight streamed answer (the Rust `chat` call
            would run against a dead channel). Using `display:contents` lets its
            <aside> sit in the flex row as if unwrapped; `none` drops the subtree
            from layout while React keeps it — and its stream — alive. */}
        <div style={{ display: showChat ? "contents" : "none" }}>
          <ChatPane
            openNoteAt={openNoteAt}
            onOpenSettings={handleOpenSettings}
            refreshSignal={aiStatusVersion}
          />
        </div>
      </div>

      <StatusBar vaultName={vault.name} tree={tree} note={open.note} />

      {error && (
        <div className="fixed right-4 top-4 z-50 flex max-w-sm items-start gap-2 rounded-lg border border-destructive/40 bg-card px-3 py-2.5 text-[12px] text-destructive shadow-xl">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words leading-snug">{error}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={clearError}
            className="shrink-0 rounded p-0.5 hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      <SettingsModal open={settingsOpen} onClose={handleCloseSettings} />

      {pendingDiscard && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="This note has edits that haven't been saved. If you continue, they'll be lost."
          confirmLabel="Discard"
          tone="danger"
          onConfirm={() => {
            const action = pendingDiscard;
            setPendingDiscard(null);
            action();
          }}
          onCancel={() => setPendingDiscard(null)}
        />
      )}
    </div>
  );
}
