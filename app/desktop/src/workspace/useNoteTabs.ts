import { useCallback, useMemo, useReducer, useRef } from "react";
import * as api from "../lib/api";
import { errorMessage, isConflict } from "../lib/api";
import type { NoteDoc } from "../lib/types";
import { isPathInside, normSep, remapPath } from "./fileMeta";
import type { NoteMode, OpenNote } from "./useOpenNote";

export interface NoteTab {
  id: string;
  path: string;
  note: NoteDoc | null;
  loading: boolean;
  error: string | null;
  mode: NoteMode;
  draft: string;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  conflict: boolean;
  loadRevision: number;
  saveRevision: number;
}

export interface OpenTabOptions {
  /** Command-click semantics: preserve a clean active tab instead of reusing it. */
  forceNew?: boolean;
}

export interface NoteTabsController {
  tabs: NoteTab[];
  activeTabId: string | null;
  activeTab: NoteTab | null;
  /** OpenNote-compatible view over the active tab. */
  active: OpenNote;
  dirtyTabs: NoteTab[];
  open: (path: string, options?: OpenTabOptions) => string;
  activate: (tabId: string) => void;
  close: (tabId: string) => void;
  remap: (
    oldPath: string,
    newPath: string,
    newRelPath?: string,
  ) => void;
  /** Remove tabs at path, or beneath path when it is a folder. */
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
  | {
      type: "load-success";
      id: string;
      requestedPath: string;
      revision: number;
      doc: NoteDoc;
    }
  | { type: "load-error"; id: string; revision: number; message: string }
  | { type: "activate"; id: string }
  | { type: "close"; id: string }
  | { type: "set-mode"; id: string; mode: NoteMode }
  | { type: "set-draft"; id: string; draft: string }
  | { type: "save-start"; id: string; revision: number }
  | {
      type: "save-success";
      id: string;
      revision: number;
      pathAtStart: string;
      doc: NoteDoc;
    }
  | {
      type: "save-error";
      id: string;
      revision: number;
      message: string;
      conflict: boolean;
    }
  | {
      type: "remap";
      oldPath: string;
      newPath: string;
      newRelPath?: string;
    }
  | { type: "remove-descendants"; path: string }
  | { type: "clear" };

const EMPTY_STATE: TabsState = { tabs: [], activeTabId: null };

/** Syntactic identity used only while Rust resolves the canonical path. */
export function normalizeRequestedPath(path: string): string {
  const normalized = normSep(path);
  const absolute = normalized.startsWith("/");
  const drive = normalized.match(/^[A-Za-z]:/)?.[0] ?? "";
  const tail = drive ? normalized.slice(drive.length) : normalized;
  const parts: string[] = [];
  for (const part of tail.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  const prefix = drive ? `${drive}/` : absolute ? "/" : "";
  return `${prefix}${parts.join("/")}` || (absolute ? "/" : ".");
}

function replaceTab(
  state: TabsState,
  id: string,
  update: (tab: NoteTab) => NoteTab,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? update(tab) : tab)),
  };
}

function reconciledLoad(
  state: TabsState,
  action: Extract<Action, { type: "load-success" }>,
): TabsState {
  const target = state.tabs.find((tab) => tab.id === action.id);
  if (!target || target.loadRevision !== action.revision) return state;

  // A rename/move that happened during the read remains authoritative.
  const wasRemapped = normalizeRequestedPath(target.path) !== normalizeRequestedPath(action.requestedPath);
  const path = wasRemapped ? target.path : action.doc.path;
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
  const relPath = wasRemapped
    ? (target.note?.relPath ?? remappedRelPath ?? action.doc.relPath)
    : action.doc.relPath;
  const loadedDoc = { ...action.doc, path, relPath };
  const canonicalKey = normalizeRequestedPath(path);
  const alias = state.tabs.find(
    (tab) => tab.id !== action.id && normalizeRequestedPath(tab.path) === canonicalKey,
  );

  if (alias) {
    const targetIndex = state.tabs.findIndex((tab) => tab.id === target.id);
    const aliasIndex = state.tabs.findIndex((tab) => tab.id === alias.id);
    const survivor = alias.dirty
      ? alias
      : target.dirty
        ? target
        : targetIndex < aliasIndex
          ? target
          : alias;
    const removedId = survivor.id === target.id ? alias.id : target.id;
    const merged: NoteTab = survivor.dirty && survivor.note
      ? { ...survivor, loading: false, error: null }
      : {
          ...survivor,
          path,
          note: loadedDoc,
          loading: false,
          error: null,
          draft: loadedDoc.raw,
          dirty: false,
        };
    return {
      tabs: state.tabs
        .filter((tab) => tab.id !== removedId)
        .map((tab) => (tab.id === survivor.id ? merged : tab)),
      activeTabId: state.activeTabId === removedId ? survivor.id : state.activeTabId,
    };
  }

  return replaceTab(state, action.id, (tab) => ({
    ...(tab.dirty && tab.note
      ? { ...tab, loading: false, error: null }
      : {
          ...tab,
          path,
          note: loadedDoc,
          loading: false,
          error: null,
          draft: loadedDoc.raw,
          dirty: false,
        }),
  }));
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
        loading: true,
        error: null,
        mode: "read",
        draft: "",
        dirty: false,
        saving: false,
        saveError: null,
        conflict: false,
        loadRevision: action.revision,
        // Reusing this stable tab gives it a new async owner. Any save that
        // started for the previous path may still land on disk, but its UI
        // completion must not overwrite the newly loaded note.
        saveRevision: tab.saveRevision + 1,
      }));
    case "load-success":
      return reconciledLoad(state, action);
    case "load-error":
      return replaceTab(state, action.id, (tab) =>
        tab.loadRevision === action.revision
          ? { ...tab, loading: false, error: action.message, note: null, draft: "", dirty: false }
          : tab,
      );
    case "activate":
      return state.tabs.some((tab) => tab.id === action.id)
        ? { ...state, activeTabId: action.id }
        : state;
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      if (state.activeTabId !== action.id) return { ...state, tabs };
      return {
        tabs,
        activeTabId: tabs[index]?.id ?? tabs[index - 1]?.id ?? null,
      };
    }
    case "set-mode":
      return replaceTab(state, action.id, (tab) => ({ ...tab, mode: action.mode }));
    case "set-draft":
      return replaceTab(state, action.id, (tab) => ({
        ...tab,
        draft: action.draft,
        dirty: tab.note !== null && action.draft !== tab.note.raw,
      }));
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
    case "remap":
      return {
        ...state,
        tabs: state.tabs.map((tab) => {
          const path = remapPath(tab.path, action.oldPath, action.newPath);
          if (!path) return tab;
          const suffix = normSep(tab.path).slice(normSep(action.oldPath).length);
          const relPath = action.newRelPath
            ? `${action.newRelPath}${suffix}`
            : tab.note?.relPath;
          return {
            ...tab,
            path,
            note: tab.note ? { ...tab.note, path, relPath: relPath ?? tab.note.relPath } : null,
          };
        }),
      };
    case "remove-descendants": {
      const removed = new Set(
        state.tabs.filter((tab) => isPathInside(tab.path, action.path)).map((tab) => tab.id),
      );
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
    loading: true,
    error: null,
    mode: "read",
    draft: "",
    dirty: false,
    saving: false,
    saveError: null,
    conflict: false,
    loadRevision: 1,
    saveRevision: 0,
  };
}

export function useNoteTabs(): NoteTabsController {
  const [state, reactDispatch] = useReducer(noteTabsReducer, EMPTY_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const nextId = useRef(0);

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
    const existing = stateRef.current.tabs.find(
      (tab) => normalizeRequestedPath(tab.path) === path,
    );
    if (existing) {
      dispatch({ type: "activate", id: existing.id });
      return existing.id;
    }

    const active = stateRef.current.tabs.find(
      (tab) => tab.id === stateRef.current.activeTabId,
    );
    if (active && !active.dirty && !options.forceNew) {
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
  const close = useCallback((id: string) => dispatch({ type: "close", id }), [dispatch]);

  const activeOperation = useCallback((action:
    | { type: "set-mode"; mode: NoteMode }
    | { type: "set-draft"; draft: string }) => {
    const id = stateRef.current.activeTabId;
    if (id) dispatch({ ...action, id } as Action);
  }, [dispatch]);

  const reload = useCallback(() => {
    const tab = stateRef.current.tabs.find((item) => item.id === stateRef.current.activeTabId);
    if (!tab) return;
    const revision = tab.loadRevision + 1;
    dispatch({ type: "load-start", id: tab.id, path: tab.path, revision });
    runLoad(tab.id, tab.path, revision);
  }, [dispatch, runLoad]);

  const persist = useCallback(async (overwrite: boolean) => {
    const tab = stateRef.current.tabs.find((item) => item.id === stateRef.current.activeTabId);
    if (!tab?.note) return;
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
    }
  }, [dispatch]);

  const remap = useCallback((oldPath: string, newPath: string, newRelPath?: string) => {
    dispatch({ type: "remap", oldPath, newPath, newRelPath });
  }, [dispatch]);
  const removeDescendants = useCallback((path: string) => {
    dispatch({ type: "remove-descendants", path });
  }, [dispatch]);
  const clear = useCallback(() => dispatch({ type: "clear" }), [dispatch]);
  const tabsInside = useCallback(
    (path: string) => stateRef.current.tabs.filter((tab) => isPathInside(tab.path, path)),
    [],
  );

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  const active = useMemo<OpenNote>(() => ({
    path: activeTab?.path ?? null,
    note: activeTab?.note ?? null,
    loading: activeTab?.loading ?? false,
    error: activeTab?.error ?? null,
    mode: activeTab?.mode ?? "read",
    draft: activeTab?.draft ?? "",
    dirty: activeTab?.dirty ?? false,
    saving: activeTab?.saving ?? false,
    saveError: activeTab?.saveError ?? null,
    conflict: activeTab?.conflict ?? false,
    open: (path) => { open(path); },
    reload,
    overwrite: () => persist(true),
    repath: (newPath, newRelPath) => {
      if (activeTab) remap(activeTab.path, newPath, newRelPath);
    },
    setMode: (mode) => activeOperation({ type: "set-mode", mode }),
    setDraft: (draft) => activeOperation({ type: "set-draft", draft }),
    save: () => persist(false),
    clear: () => {
      if (activeTab) close(activeTab.id);
    },
  }), [activeOperation, activeTab, close, open, persist, reload, remap]);

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
