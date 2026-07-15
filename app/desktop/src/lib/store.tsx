// The vault store: lifecycle (welcome → loading → open), the LAZY file tree,
// recent vaults, and a single error channel. This is frozen integration glue —
// the welcome screen and the workspace both consume `useVault()`; neither should
// reach past it to `invoke` for vault lifecycle.
//
// Lazy file tree (issue #40): instead of one eager `read_tree` walk of the whole
// vault, the store loads directories on demand. `loaded` caches each directory's
// immediate children keyed by relPath ("" = root); `expanded` is the set of
// folders the user has opened (persisted per vault, so expansions survive a
// restart). Expanding a folder is what triggers its `list_dir` fetch. This is
// DISPLAY-only: search, the link graph, backlinks, and AI retrieval keep scanning
// the WHOLE vault through their own commands — nothing here ever narrows them to
// the loaded subset, so a file behind an unexpanded folder or a truncation is
// still found and still cited.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "./api";
import { errorMessage } from "./api";
import { loadExpanded, saveExpanded } from "../workspace/treeState";
import type { RecentVault, TreeNode, Vault } from "./types";

export type VaultStatus = "welcome" | "loading" | "open";

/** Load state of one directory's immediate children. `loading` while its
 *  `list_dir` fetch is in flight, `error` when it failed (rendered as a
 *  per-folder row, never a whole-tree failure). */
export type DirStatus = LoadedDir["status"];

/** One directory's cached listing for the lazy tree — a discriminated union so a
 *  status can never carry the wrong payload (an `error` always has its message; a
 *  `loaded` always has `children` + `truncated`; a `loading` carries neither,
 *  which the flatten walk renders as a loading row). `children` are the
 *  directory's immediate entries (folders carry `children: null` until themselves
 *  expanded); `truncated` is how many further entries the per-directory cap
 *  omitted, driving an explicit "N more…" row. */
export type LoadedDir =
  | { status: "loading" }
  | { status: "loaded"; children: TreeNode[]; truncated: number | null }
  | { status: "error"; error: string };

export interface VaultContextValue {
  status: VaultStatus;
  vault: Vault | null;
  /** Per-directory listings, keyed by relPath ("" = root). Read-only to consumers
   *  — mutate only through `listDir` / `toggle` / `refreshDir`. */
  loaded: ReadonlyMap<string, LoadedDir>;
  /** Folder relPaths the user has expanded (persisted per vault). */
  expanded: ReadonlySet<string>;
  recents: RecentVault[];
  error: string | null;
  clearError: () => void;
  /** Surface a message in the shared error channel (for consumers like the
   *  workspace that detect a failure outside the store's own operations). */
  reportError: (message: string) => void;
  refreshRecents: () => Promise<void>;
  /** Open the native folder picker, then open the chosen folder as a vault. */
  openExisting: () => Promise<void>;
  /** Open a known path (e.g. a recent vault). */
  openByPath: (path: string) => Promise<void>;
  /** Open the native folder picker to choose where a new vault will live. */
  pickNewLocation: () => Promise<string | null>;
  /** Create a new vault folder and open it. */
  createVault: (parentDir: string, name: string) => Promise<void>;
  /** Close the current vault and return to the welcome screen. */
  close: () => Promise<void>;
  /** Fetch + cache one directory's children (shows a loading row while in
   *  flight, then a loaded/error listing). Used to populate a folder on expand. */
  listDir: (relPath: string) => Promise<void>;
  /** Expand a folder (fetching it if not yet loaded) or collapse it (keeping its
   *  cached children for an instant re-expand). Persists the expanded set. */
  toggle: (relPath: string) => void;
  /** Re-list one already-loaded directory in place, without a loading flicker —
   *  the CRUD refresh and the external-change watcher use this. */
  refreshDir: (relPath: string) => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [status, setStatus] = useState<VaultStatus>("welcome");
  const [vault, setVault] = useState<Vault | null>(null);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, LoadedDir>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [recents, setRecents] = useState<RecentVault[]>([]);
  const [error, setError] = useState<string | null>(null);
  const quitRequestedRef = useRef(false);

  // Latest-value refs so the stable `toggle` / watcher callbacks can read current
  // `loaded` / `expanded` without being re-created (and re-subscribing) on every
  // directory load. Assigned during render, the standard "current value" pattern.
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // Bumped every time the open vault changes (open/create/close reset `loaded`).
  // A `list_dir` fetch captures the generation at dispatch and drops its write if
  // the vault has since changed — so a slow response from a closed vault can never
  // poison the reopened tree (the same guard `useVaultTree` applies via `cancelled`).
  const generationRef = useRef(0);

  const clearError = useCallback(() => setError(null), []);
  const reportError = useCallback((message: string) => setError(message), []);

  const refreshRecents = useCallback(async () => {
    try {
      setRecents(await api.listRecentVaults());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  // Core per-directory fetch. `showLoading` swaps the folder to a loading row
  // first (fresh expand); leaving it false re-lists in place, keeping the current
  // children visible until the new listing lands (CRUD + watcher refresh, so an
  // external edit never flickers every open folder). A failed listing becomes a
  // per-folder error row — NOT the global error channel — so siblings and the
  // rest of the tree stay usable; the failure is surfaced in the row, not
  // swallowed.
  const fetchDir = useCallback(async (relPath: string, showLoading: boolean) => {
    const generation = generationRef.current;
    if (showLoading) {
      setLoaded((prev) => {
        const next = new Map(prev);
        next.set(relPath, { status: "loading" });
        return next;
      });
    }
    try {
      const listing = await api.listDir(relPath);
      // The vault changed while this was in flight — its result belongs to a
      // vault that is no longer open, so dropping it keeps the new tree clean.
      if (generationRef.current !== generation) return;
      setLoaded((prev) => {
        const next = new Map(prev);
        next.set(relPath, {
          status: "loaded",
          children: listing.entries,
          truncated: listing.truncated,
        });
        return next;
      });
    } catch (e) {
      if (generationRef.current !== generation) return;
      if (!showLoading) {
        // An in-place refresh (CRUD/watcher) failed: the folder is fine on disk
        // and its last-good children are still cached, so collapsing it to a
        // single error row would misrepresent it. Keep the children visible and
        // surface the failure once on the shared channel — never swallowed.
        setError(errorMessage(e));
        return;
      }
      setLoaded((prev) => {
        const next = new Map(prev);
        next.set(relPath, { status: "error", error: errorMessage(e) });
        return next;
      });
    }
  }, []);

  const listDir = useCallback(
    (relPath: string) => fetchDir(relPath, true),
    [fetchDir],
  );

  const refreshDir = useCallback(
    (relPath: string) => fetchDir(relPath, false),
    [fetchDir],
  );

  const toggle = useCallback(
    (relPath: string) => {
      const willExpand = !expandedRef.current.has(relPath);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (willExpand) next.add(relPath);
        else next.delete(relPath);
        return next;
      });
      // Fetch on first expand only; a cached (or in-flight) folder re-reveals
      // instantly. Persistence is handled by the effect below.
      if (willExpand && !loadedRef.current.has(relPath)) void listDir(relPath);
    },
    [listDir],
  );

  // Load the root, then re-open + fetch every persisted-expanded folder, so the
  // user's expansions are restored on open. Root is awaited (first paint waits on
  // it); the persisted subfolders stream in behind (each shows its own loading
  // row). `listDir` swallows per-folder failures into error rows, so this never
  // rejects.
  const openTree = useCallback(
    async (vaultPath: string) => {
      const persisted = loadExpanded(vaultPath);
      generationRef.current += 1; // invalidate any in-flight fetch from a prior vault
      setLoaded(new Map());
      setExpanded(persisted);
      await listDir("");
      void Promise.all([...persisted].map((relPath) => listDir(relPath)));
    },
    [listDir],
  );

  const openByPath = useCallback(
    async (path: string) => {
      setStatus("loading");
      setError(null);
      try {
        const opened = await api.openVault(path);
        setVault(opened);
        await openTree(opened.path);
        setStatus("open");
      } catch (e) {
        setError(errorMessage(e));
        setStatus("welcome");
        void refreshRecents();
      }
    },
    [openTree, refreshRecents],
  );

  const openExisting = useCallback(async () => {
    try {
      const path = await api.pickVaultFolder();
      if (path) await openByPath(path);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [openByPath]);

  const pickNewLocation = useCallback(async () => {
    try {
      return await api.pickNewVaultLocation();
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }, []);

  const createVault = useCallback(
    async (parentDir: string, name: string) => {
      setStatus("loading");
      setError(null);
      try {
        const created = await api.createVault(parentDir, name);
        setVault(created);
        await openTree(created.path);
        setStatus("open");
      } catch (e) {
        setError(errorMessage(e));
        setStatus("welcome");
      }
    },
    [openTree],
  );

  const close = useCallback(async () => {
    try {
      await api.closeVault();
    } catch (e) {
      setError(errorMessage(e));
    }
    setVault(null);
    generationRef.current += 1; // invalidate any in-flight fetch from the closed vault
    setLoaded(new Map());
    setExpanded(new Set());
    setStatus("welcome");
    void refreshRecents();
  }, [refreshRecents]);

  // Refresh every currently-loaded directory in place — the debounced watcher's
  // response to an external change. Bounded by what the user has expanded; reads
  // the live loaded set through the ref so it needn't re-subscribe as folders
  // load.
  const refreshAllLoaded = useCallback(async () => {
    await Promise.all(
      [...loadedRef.current.keys()].map((relPath) => refreshDir(relPath)),
    );
  }, [refreshDir]);

  // Load recent vaults on first mount.
  useEffect(() => {
    void refreshRecents();
  }, [refreshRecents]);

  // Persist the expanded set whenever it changes while a vault is open. Cheap (a
  // short array) and idempotent, so the redundant write right after open is
  // harmless; the welcome/loading guard stops `close`'s reset from clobbering the
  // persisted set with an empty one.
  useEffect(() => {
    if (status !== "open" || !vault) return;
    saveExpanded(vault.path, expanded);
  }, [status, vault, expanded]);

  // While a vault is open, re-list the loaded directories when the vault changes
  // on disk (debounced to coalesce bursts like a git pull or Obsidian sync). This
  // is the backstop for *external* edits; in-app create/rename/move/delete refresh
  // their own parent, so a dead watcher degrades only live external sync, never
  // in-app consistency.
  useEffect(() => {
    if (status !== "open") return;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void api
      .onTreeChanged(() => {
        // This refreshes the file TREE only. Reloading the open READER on an
        // external edit/delete is a separate concern owned by `useNoteTabs`, which
        // holds the tab/draft/conflict state and subscribes to this same event with
        // its own debounced, draft-preserving reconcile (issue #31). Keeping the two
        // subscriptions apart avoids coupling this frozen lifecycle glue to tab state.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void refreshAllLoaded(), 300);
      })
      .then((fn) => {
        // If the effect was already torn down before listen() resolved, unlisten
        // immediately — otherwise the listener leaks and stacks across reopens.
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => {
        // A failed listen() means external edits won't show live — surface it
        // rather than dropping the live-refresh subscription silently.
        setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [status, refreshAllLoaded]);

  // Native menu → vault lifecycle. Open Vault / Open Recent must work on the
  // welcome screen, before any vault is open — so they live here in the always-
  // mounted provider, not in the Workspace (which isn't mounted until a vault
  // opens). Every other menu action is vault-only and handled in the Workspace.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void api
      .onMenu((e) => {
        // Rust prevents native Cmd-Q / Dock Quit and emits this action. With no
        // mounted Workspace there cannot be an unsaved editor draft, so confirm
        // the quit immediately. While open, Workspace owns the draft guard.
        if (e.action === "quit-app") {
          if (status === "open" || quitRequestedRef.current) return;
          quitRequestedRef.current = true;
          void api.quitApp().catch((quitError) => {
            quitRequestedRef.current = false;
            setError(errorMessage(quitError));
          });
          return;
        }
        // Once a vault is open, Workspace owns these actions so it can protect
        // every dirty note tab before switching vaults. The provider remains
        // responsible on the welcome screen where Workspace is not mounted.
        if (status !== "welcome") return;
        if (e.action === "open-vault") void openExisting();
        else if (e.action === "open-recent" && e.path) void openByPath(e.path);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => setError(errorMessage(e)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [status, openExisting, openByPath]);

  // Memoised so the context value is referentially stable across renders that
  // don't change any field — otherwise every consumer re-renders each tick (S6481).
  const value: VaultContextValue = useMemo(
    () => ({
      status,
      vault,
      loaded,
      expanded,
      recents,
      error,
      clearError,
      reportError,
      refreshRecents,
      openExisting,
      openByPath,
      pickNewLocation,
      createVault,
      close,
      listDir,
      toggle,
      refreshDir,
    }),
    [
      status,
      vault,
      loaded,
      expanded,
      recents,
      error,
      clearError,
      reportError,
      refreshRecents,
      openExisting,
      openByPath,
      pickNewLocation,
      createVault,
      close,
      listDir,
      toggle,
      refreshDir,
    ],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used within a VaultProvider");
  return ctx;
}
