// The workspace: ribbon · file tree / search panel · reader/editor / graph ·
// cited-chat stub · status bar. This orchestrator owns the open-note state
// (via useOpenNote), the Workspace-local view state (which sidebar panel and
// center view are showing — deliberately NOT in the vault store), and the
// glue that keeps the reader honest when the tree mutates underneath it —
// including a single guard that blocks losing unsaved edits when navigating
// away, and the OS window-close / Cmd-Q path routed through that same guard.
// Tree CRUD lives in FileTree; lifecycle errors flow from the store.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useVault } from "../lib/store";
import type { TreeNode } from "../lib/types";
import { ChatStub } from "./ChatStub";
import { ConfirmDialog } from "./ConfirmDialog";
import { FileTree } from "./FileTree";
import { isPathInside, normSep, remapPath } from "./fileMeta";
import { GraphView } from "./GraphView";
import { NotePane } from "./NotePane";
import { Ribbon, type CenterView, type SidebarPanel } from "./Ribbon";
import { SearchPanel } from "./SearchPanel";
import { StatusBar } from "./StatusBar";
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
  // Bumped whenever ⌘K / the ribbon Search icon wants the search field focused.
  const [searchFocusSignal, bumpSearchFocus] = useReducer((n: number) => n + 1, 0);

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
  /** GraphNode ids are vault-relative paths; join onto the vault root. The
   *  plain join is safe — the backend canonicalizes through ensure_within,
   *  and mockVault keys entries exactly this way. */
  const openFromGraph = useCallback(
    (relPath: string) => {
      if (vaultPath) openNoteAt(`${vaultPath}/${relPath}`);
    },
    [openNoteAt, vaultPath],
  );

  const handleSelect = useCallback(
    (path: string) => {
      if (path === openRef.current.path) return;
      openNoteAt(path);
    },
    [openNoteAt],
  );

  const handleShowFiles = useCallback(() => setSidebarPanel("files"), []);
  const handleShowSearch = useCallback(() => {
    setSidebarPanel("search");
    bumpSearchFocus();
  }, []);
  const handleToggleGraph = useCallback(
    () => setCenterView((v) => (v === "graph" ? "note" : "graph")),
    [],
  );

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

  // ⌘K / Ctrl+K anywhere: open the sidebar search panel and focus its field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSidebarPanel("search");
        bumpSearchFocus();
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, []);

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
          />
        ) : (
          <SearchPanel focusSignal={searchFocusSignal} onOpen={openNoteAt} />
        )}
        {centerView === "graph" ? (
          <GraphView onOpenNote={openFromGraph} />
        ) : (
          <NotePane open={open} onClose={() => guard(() => openRef.current.clear())} />
        )}
        <ChatStub />
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
