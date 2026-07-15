import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import * as api from "../lib/api";
import { errorMessage, isConflict, isNotFound } from "../lib/api";
import type { NoteDoc } from "../lib/types";
import { isPathInside, normSep, remapPath } from "./fileMeta";
import {
  clearSourceEditorSessions,
  destroySourceEditorSession,
} from "./sourceEditorSession";
import type { OpenNote } from "./useOpenNote";

export interface NoteTab {
  id: string;
  path: string;
  note: NoteDoc | null;
  sessionHash: string | null;
  loading: boolean;
  error: string | null;
  draft: string;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  preservationError: string | null;
  conflict: boolean;
  /** True when the note's file was removed on disk while the tab is open (an
   *  external deletion, or a rename that moved it out from under the tab). The
   *  note + draft are kept — never dropped — so the user can re-save to recover;
   *  the reader surfaces the deletion so the open note is never silently stale. */
  externalDeleted: boolean;
  loadRevision: number;
  saveRevision: number;
}

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

interface TabsState {
  tabs: NoteTab[];
  activeTabId: string | null;
}

type Action =
  | { type: "add-loading"; tab: NoteTab }
  | { type: "load-start"; id: string; path: string; revision: number }
  | { type: "load-success"; id: string; requestedPath: string; revision: number; doc: NoteDoc }
  | { type: "load-error"; id: string; revision: number; message: string }
  | { type: "activate"; id: string }
  | { type: "close"; id: string }
  | { type: "set-draft"; id: string; draft: string }
  | { type: "set-preservation-error"; id: string; message: string | null }
  | { type: "save-start"; id: string; revision: number }
  | { type: "save-success"; id: string; revision: number; pathAtStart: string; doc: NoteDoc }
  | { type: "save-error"; id: string; revision: number; message: string; conflict: boolean }
  | { type: "external-update"; id: string; doc: NoteDoc }
  | { type: "external-delete"; id: string }
  | { type: "remap"; oldPath: string; newPath: string; newRelPath?: string }
  | { type: "remove-descendants"; path: string }
  | { type: "clear" };

/** Debounce window for coalescing a burst of external-change events (a git pull
 *  or Obsidian sync fires many at once) before reconciling the open notes. */
const EXTERNAL_RELOAD_DEBOUNCE_MS = 300;

const EMPTY_STATE: TabsState = { tabs: [], activeTabId: null };

export function normalizeRequestedPath(path: string): string {
  const normalized = normSep(path);
  const absolute = normalized.startsWith("/");
  const drive = /^[A-Za-z]:/.exec(normalized)?.[0] ?? "";
  const tail = drive ? normalized.slice(drive.length) : normalized;
  const parts: string[] = [];
  for (const part of tail.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  const rootPrefix = absolute ? "/" : "";
  const prefix = drive ? `${drive}/` : rootPrefix;
  return `${prefix}${parts.join("/")}` || (absolute ? "/" : ".");
}

function replaceTab(state: TabsState, id: string, update: (tab: NoteTab) => NoteTab): TabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? update(tab) : tab)) };
}

/** Apply a freshly loaded document to a tab, unless the tab has unsaved edits —
 *  in which case only the loading flags clear so the draft is never clobbered. */
function applyLoad(tab: NoteTab, path: string, loadedDoc: NoteDoc): NoteTab {
  if (tab.dirty && tab.note) return { ...tab, loading: false, error: null };
  return {
    ...tab,
    path,
    note: loadedDoc,
    sessionHash: loadedDoc.contentHash,
    loading: false,
    error: null,
    draft: loadedDoc.raw,
    dirty: false,
    preservationError: null,
    externalDeleted: false,
  };
}

/** The relPath to record for a loaded doc. When the tab was remapped underneath
 *  the in-flight read, preserve the tab's own relPath (falling back to one derived
 *  from the request's vault prefix); otherwise trust the loaded doc. */
function resolveLoadedRelPath(
  action: Extract<Action, { type: "load-success" }>,
  target: NoteTab,
  wasRemapped: boolean,
): string {
  if (!wasRemapped) return action.doc.relPath;
  const requestedPath = normSep(action.requestedPath);
  const requestedRelPath = normSep(action.doc.relPath).replace(/^\/+/, "");
  const vaultPrefix = requestedPath.endsWith(requestedRelPath)
    ? requestedPath.slice(0, -requestedRelPath.length)
    : null;
  const remappedPath = normSep(target.path);
  const remappedRelPath =
    vaultPrefix !== null && remappedPath.startsWith(vaultPrefix)
      ? remappedPath.slice(vaultPrefix.length).replace(/^\/+/, "")
      : null;
  return target.note?.relPath ?? remappedRelPath ?? action.doc.relPath;
}

/** When a load resolves onto a path already held by another tab, pick which tab
 *  survives the merge: a dirty tab always wins; otherwise the earlier tab. */
function pickSurvivor(
  target: NoteTab,
  alias: NoteTab,
  targetIndex: number,
  aliasIndex: number,
): NoteTab {
  if (alias.dirty) return alias;
  if (target.dirty) return target;
  return targetIndex < aliasIndex ? target : alias;
}

/** Collapse the target and its alias into a single surviving tab, dropping the
 *  other and re-pointing the active tab if it was the one removed. */
function mergeAliasedTabs(
  state: TabsState,
  target: NoteTab,
  alias: NoteTab,
  path: string,
  loadedDoc: NoteDoc,
): TabsState {
  const targetIndex = state.tabs.findIndex((tab) => tab.id === target.id);
  const aliasIndex = state.tabs.findIndex((tab) => tab.id === alias.id);
  const survivor = pickSurvivor(target, alias, targetIndex, aliasIndex);
  const removedId = survivor.id === target.id ? alias.id : target.id;
  const merged = applyLoad(survivor, path, loadedDoc);
  return {
    tabs: state.tabs
      .filter((tab) => tab.id !== removedId)
      .map((tab) => (tab.id === survivor.id ? merged : tab)),
    activeTabId: state.activeTabId === removedId ? survivor.id : state.activeTabId,
  };
}

function reconciledLoad(
  state: TabsState,
  action: Extract<Action, { type: "load-success" }>,
): TabsState {
  const target = state.tabs.find((tab) => tab.id === action.id);
  if (!target) return state;
  if (target.loadRevision !== action.revision) return state;

  const wasRemapped =
    normalizeRequestedPath(target.path) !==
    normalizeRequestedPath(action.requestedPath);
  const path = wasRemapped ? target.path : action.doc.path;
  const relPath = resolveLoadedRelPath(action, target, wasRemapped);
  const loadedDoc = { ...action.doc, path, relPath };
  const alias = state.tabs.find(
    (tab) =>
      tab.id !== action.id &&
      normalizeRequestedPath(tab.path) === normalizeRequestedPath(path),
  );

  if (alias) return mergeAliasedTabs(state, target, alias, path, loadedDoc);
  return replaceTab(state, action.id, (tab) => applyLoad(tab, path, loadedDoc));
}

export function noteTabsReducer(state: TabsState, action: Action): TabsState {
  switch (action.type) {
    case "add-loading":
      return { tabs: [...state.tabs, action.tab], activeTabId: action.tab.id };
    case "load-start":
      return replaceTab(state, action.id, (tab) => ({
        ...tab,
        path: action.path,
        note: null,
        sessionHash: null,
        loading: true,
        error: null,
        draft: "",
        dirty: false,
        saving: false,
        saveError: null,
        preservationError: null,
        conflict: false,
        externalDeleted: false,
        loadRevision: action.revision,
        saveRevision: tab.saveRevision + 1,
      }));
    case "load-success":
      return reconciledLoad(state, action);
    case "load-error":
      return replaceTab(state, action.id, (tab) =>
        tab.loadRevision === action.revision
          ? { ...tab, loading: false, error: action.message, note: null, sessionHash: null, draft: "", dirty: false }
          : tab,
      );
    case "activate":
      return state.tabs.some((tab) => tab.id === action.id) ? { ...state, activeTabId: action.id } : state;
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      return state.activeTabId === action.id
        ? { tabs, activeTabId: tabs[index]?.id ?? tabs[index - 1]?.id ?? null }
        : { ...state, tabs };
    }
    case "set-draft":
      return replaceTab(state, action.id, (tab) => ({
        ...tab,
        draft: action.draft,
        dirty: tab.note !== null && action.draft !== tab.note.raw,
      }));
    case "set-preservation-error":
      return replaceTab(state, action.id, (tab) => ({ ...tab, preservationError: action.message }));
    case "save-start":
      return replaceTab(state, action.id, (tab) => ({
        ...tab,
        saving: true,
        saveError: null,
        saveRevision: action.revision,
      }));
    case "save-success":
      return replaceTab(state, action.id, (tab) => {
        if (tab.saveRevision !== action.revision) return tab;
        const wasRemapped = normalizeRequestedPath(tab.path) !== normalizeRequestedPath(action.pathAtStart);
        const savedDoc = {
          ...action.doc,
          path: tab.path,
          relPath: wasRemapped ? (tab.note?.relPath ?? action.doc.relPath) : action.doc.relPath,
        };
        return {
          ...tab,
          note: savedDoc,
          saving: false,
          saveError: null,
          conflict: false,
          externalDeleted: false,
          dirty: tab.draft !== savedDoc.raw,
        };
      });
    case "save-error":
      return replaceTab(state, action.id, (tab) =>
        tab.saveRevision === action.revision
          ? {
              ...tab,
              saving: false,
              saveError: action.conflict ? null : action.message,
              conflict: action.conflict,
            }
          : tab,
      );
    case "external-update":
      return replaceTab(state, action.id, (tab) => {
        if (!tab.note) return tab;
        if (tab.dirty) {
          // Unsaved edits are present: never clobber the draft. Raise the same
          // conflict the save path raises so the user resolves it explicitly
          // (reload to take disk, or overwrite to keep the draft).
          return { ...tab, conflict: true, externalDeleted: false };
        }
        // Clean tab: adopt the on-disk version. Keep the tab's own path/relPath —
        // the file's identity is unchanged (we read the tab's current path).
        const reloaded = { ...action.doc, path: tab.path, relPath: tab.note.relPath };
        return {
          ...tab,
          note: reloaded,
          sessionHash: reloaded.contentHash,
          draft: reloaded.raw,
          dirty: false,
          conflict: false,
          externalDeleted: false,
          error: null,
        };
      });
    case "external-delete":
      return replaceTab(state, action.id, (tab) =>
        tab.note ? { ...tab, externalDeleted: true } : tab,
      );
    case "remap":
      return {
        ...state,
        tabs: state.tabs.map((tab) => {
          const path = remapPath(tab.path, action.oldPath, action.newPath);
          if (!path) return tab;
          const suffix = normSep(tab.path).slice(normSep(action.oldPath).length);
          const relPath = action.newRelPath ? `${action.newRelPath}${suffix}` : tab.note?.relPath;
          return {
            ...tab,
            path,
            note: tab.note ? { ...tab.note, path, relPath: relPath ?? tab.note.relPath } : null,
          };
        }),
      };
    case "remove-descendants": {
      const removed = new Set(state.tabs.filter((tab) => isPathInside(tab.path, action.path)).map((tab) => tab.id));
      if (removed.size === 0) return state;
      const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
      const tabs = state.tabs.filter((tab) => !removed.has(tab.id));
      if (!state.activeTabId || !removed.has(state.activeTabId)) return { ...state, tabs };
      const right = state.tabs.slice(activeIndex + 1).find((tab) => !removed.has(tab.id));
      const left = state.tabs.slice(0, activeIndex).reverse().find((tab) => !removed.has(tab.id));
      return { tabs, activeTabId: right?.id ?? left?.id ?? null };
    }
    case "clear":
      return EMPTY_STATE;
  }
}

function loadingTab(id: string, path: string): NoteTab {
  return {
    id,
    path,
    note: null,
    sessionHash: null,
    loading: true,
    error: null,
    draft: "",
    dirty: false,
    saving: false,
    saveError: null,
    preservationError: null,
    conflict: false,
    externalDeleted: false,
    loadRevision: 1,
    saveRevision: 0,
  };
}

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
