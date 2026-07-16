import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import * as api from "../lib/api";
import { errorMessage, isConflict, isNotFound } from "../lib/api";
import { isPathInside } from "./fileMeta";
import {
  EMPTY_STATE,
  loadingTab,
  noteTabsReducer,
  normalizeRequestedPath,
  type Action,
  type NoteTab,
} from "./noteTabsReducer";
import {
  clearSourceEditorSessions,
  destroySourceEditorSession,
} from "./sourceEditorSession";
import type { OpenNote } from "./useOpenNote";

export type { NoteTab } from "./noteTabsReducer";

export interface OpenTabOptions {
  forceNew?: boolean;
}

export interface NoteTabsController {
  tabs: NoteTab[];
  activeTabId: string | null;
  activeTab: NoteTab | null;
  active: OpenNote;
  dirtyTabs: NoteTab[];
  open: (path: string, options?: OpenTabOptions) => string;
  activate: (tabId: string) => void;
  close: (tabId: string) => void;
  remap: (oldPath: string, newPath: string, newRelPath?: string) => void;
  removeDescendants: (path: string) => void;
  tabsInside: (path: string) => NoteTab[];
  clear: () => void;
}

/** Debounce window for coalescing a burst of external-change events (a git pull
 *  or Obsidian sync fires many at once) before reconciling the open notes. */
const EXTERNAL_RELOAD_DEBOUNCE_MS = 300;

export function useNoteTabs(): NoteTabsController {
  const [state, reactDispatch] = useReducer(noteTabsReducer, EMPTY_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const nextId = useRef(0);
  const savingTabIds = useRef(new Set<string>());

  const dispatch = useCallback((action: Action) => {
    stateRef.current = noteTabsReducer(stateRef.current, action);
    reactDispatch(action);
  }, []);

  const runLoad = useCallback((id: string, target: string, revision: number) => {
    void api.readNote(target).then(
      (doc) => dispatch({ type: "load-success", id, requestedPath: target, revision, doc }),
      (error: unknown) => dispatch({ type: "load-error", id, revision, message: errorMessage(error) }),
    );
  }, [dispatch]);

  const open = useCallback((target: string, options: OpenTabOptions = {}) => {
    const path = normalizeRequestedPath(target);
    const existing = stateRef.current.tabs.find((tab) => normalizeRequestedPath(tab.path) === path);
    if (existing) {
      dispatch({ type: "activate", id: existing.id });
      return existing.id;
    }

    const active = stateRef.current.tabs.find((tab) => tab.id === stateRef.current.activeTabId);
    if (active && !active.dirty && !options.forceNew) {
      destroySourceEditorSession(active.id);
      const revision = active.loadRevision + 1;
      dispatch({ type: "load-start", id: active.id, path, revision });
      dispatch({ type: "activate", id: active.id });
      runLoad(active.id, path, revision);
      return active.id;
    }

    const id = `note-tab-${++nextId.current}`;
    dispatch({ type: "add-loading", tab: loadingTab(id, path) });
    runLoad(id, path, 1);
    return id;
  }, [dispatch, runLoad]);

  const activate = useCallback((id: string) => dispatch({ type: "activate", id }), [dispatch]);
  const close = useCallback((id: string) => {
    destroySourceEditorSession(id);
    dispatch({ type: "close", id });
  }, [dispatch]);

  const reload = useCallback(() => {
    const tab = stateRef.current.tabs.find((item) => item.id === stateRef.current.activeTabId);
    if (!tab) return;
    destroySourceEditorSession(tab.id);
    const revision = tab.loadRevision + 1;
    dispatch({ type: "load-start", id: tab.id, path: tab.path, revision });
    runLoad(tab.id, tab.path, revision);
  }, [dispatch, runLoad]);

  // Reconcile one open tab against its file on disk after an external change.
  // A save-in-flight tab is skipped (its own write is reconciled by save-success,
  // never treated as an external edit); an unchanged hash is skipped (this is how
  // a completed in-app save avoids a spurious reload). A genuine change reloads a
  // clean tab or, to protect unsaved work, raises a conflict on a dirty one; a
  // vanished file is surfaced as an external deletion.
  const reconcileOpenTab = useCallback(async (id: string) => {
    const tab = stateRef.current.tabs.find((item) => item.id === id);
    if (
      !tab ||
      !tab.note ||
      tab.loading ||
      tab.saving ||
      savingTabIds.current.has(id)
    ) {
      return;
    }
    const knownHash = tab.note.contentHash;
    const path = tab.path;
    try {
      const disk = await api.readNote(path);
      // The tab may have closed, been remapped, or begun saving during the read.
      const current = stateRef.current.tabs.find((item) => item.id === id);
      if (!current || current.saving || savingTabIds.current.has(id)) return;
      if (current.path !== path) return;
      if (disk.contentHash === knownHash) return;
      if (!current.dirty) destroySourceEditorSession(id);
      dispatch({ type: "external-update", id, doc: disk });
    } catch (error) {
      if (isNotFound(error)) {
        dispatch({ type: "external-delete", id });
        return;
      }
      // A transient read failure during external churn (e.g. mid-rename) leaves
      // the last-known-good note on screen; the user's next save hits the real
      // conflict/not-found backstop. Logged, not surfaced on every sync burst —
      // the store's tree watcher owns the shared user-facing error channel.
      console.error("external note reconcile failed:", error);
    }
  }, [dispatch]);

  const persist = useCallback(async (overwrite: boolean) => {
    const tab = stateRef.current.tabs.find((item) => item.id === stateRef.current.activeTabId);
    if (!tab?.note || tab.saving || savingTabIds.current.has(tab.id)) return;
    if (tab.preservationError) {
      const revision = tab.saveRevision + 1;
      dispatch({ type: "save-start", id: tab.id, revision });
      dispatch({
        type: "save-error",
        id: tab.id,
        revision,
        message: tab.preservationError,
        conflict: false,
      });
      return;
    }
    savingTabIds.current.add(tab.id);
    const revision = tab.saveRevision + 1;
    const pathAtStart = tab.path;
    const draftAtStart = tab.draft;
    dispatch({ type: "save-start", id: tab.id, revision });
    try {
      const saved = await api.writeNote(
        pathAtStart,
        draftAtStart,
        overwrite ? null : tab.note.contentHash,
      );
      dispatch({ type: "save-success", id: tab.id, revision, pathAtStart, doc: saved });
    } catch (error) {
      dispatch({
        type: "save-error",
        id: tab.id,
        revision,
        message: errorMessage(error),
        conflict: isConflict(error),
      });
    } finally {
      savingTabIds.current.delete(tab.id);
    }
  }, [dispatch]);

  const remap = useCallback((oldPath: string, newPath: string, newRelPath?: string) => {
    dispatch({ type: "remap", oldPath, newPath, newRelPath });
  }, [dispatch]);
  const removeDescendants = useCallback((path: string) => {
    for (const tab of stateRef.current.tabs) {
      if (isPathInside(tab.path, path)) destroySourceEditorSession(tab.id);
    }
    dispatch({ type: "remove-descendants", path });
  }, [dispatch]);
  const clear = useCallback(() => {
    clearSourceEditorSessions();
    dispatch({ type: "clear" });
  }, [dispatch]);
  const tabsInside = useCallback(
    (path: string) => stateRef.current.tabs.filter((tab) => isPathInside(tab.path, path)),
    [],
  );

  // Keep open notes fresh when the vault changes on disk (external edits from
  // Obsidian, a git pull, a sync). Debounced to coalesce bursts and to avoid a
  // self-write loop: an in-app save fires the watcher too, but the saved tab is
  // either still saving or already matches disk, so it never spuriously reloads.
  // Subscribed once (stable deps); the live tab set is read through `stateRef`.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconcileAll = () => {
      for (const tab of stateRef.current.tabs) void reconcileOpenTab(tab.id);
    };
    void api
      .onTreeChanged(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(reconcileAll, EXTERNAL_RELOAD_DEBOUNCE_MS);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((error) => {
        // Degrades only live reader reloads; the store's tree watcher subscribes
        // to the same event and owns the user-facing surface, so log rather than
        // double-report the failure.
        console.error("failed to subscribe to external note reloads:", error);
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [reconcileOpenTab]);

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  const owningTabId = activeTab?.id ?? null;
  const active = useMemo<OpenNote>(() => ({
    sessionKey: activeTab?.id ?? null,
    sessionHash: activeTab?.sessionHash ?? null,
    path: activeTab?.path ?? null,
    note: activeTab?.note ?? null,
    loading: activeTab?.loading ?? false,
    error: activeTab?.error ?? null,
    draft: activeTab?.draft ?? "",
    dirty: activeTab?.dirty ?? false,
    saving: activeTab?.saving ?? false,
    saveError: activeTab?.saveError ?? null,
    preservationError: activeTab?.preservationError ?? null,
    conflict: activeTab?.conflict ?? false,
    externalDeleted: activeTab?.externalDeleted ?? false,
    open: (path) => { open(path); },
    reload,
    overwrite: () => persist(true),
    repath: (newPath, newRelPath) => {
      if (activeTab) remap(activeTab.path, newPath, newRelPath);
    },
    setDraft: (draft) => {
      if (owningTabId) dispatch({ type: "set-draft", id: owningTabId, draft });
    },
    setPreservationError: (message) => {
      if (owningTabId) dispatch({ type: "set-preservation-error", id: owningTabId, message });
    },
    save: () => persist(false),
    clear: () => {
      if (activeTab) close(activeTab.id);
    },
  }), [activeTab, close, dispatch, open, owningTabId, persist, reload, remap]);

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab,
    active,
    dirtyTabs: state.tabs.filter((tab) => tab.dirty),
    open,
    activate,
    close,
    remap,
    removeDescendants,
    tabsInside,
    clear,
  };
}
