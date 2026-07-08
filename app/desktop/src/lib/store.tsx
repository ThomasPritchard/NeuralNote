// The vault store: lifecycle (welcome → loading → open), the file tree, recent
// vaults, and a single error channel. This is frozen integration glue — the
// welcome screen and the workspace both consume `useVault()`; neither should
// reach past it to `invoke` for vault lifecycle. (Note read/write is done
// directly via `api` in the workspace, with `refreshTree()` to resync.)

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "./api";
import { errorMessage } from "./api";
import type { RecentVault, TreeNode, Vault } from "./types";

export type VaultStatus = "welcome" | "loading" | "open";

export interface VaultContextValue {
  status: VaultStatus;
  vault: Vault | null;
  tree: TreeNode[];
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
  /** Re-read the file tree from disk. */
  refreshTree: () => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("welcome");
  const [vault, setVault] = useState<Vault | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [recents, setRecents] = useState<RecentVault[]>([]);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);
  const reportError = useCallback((message: string) => setError(message), []);

  const refreshRecents = useCallback(async () => {
    try {
      setRecents(await api.listRecentVaults());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      setTree(await api.readTree());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const openByPath = useCallback(
    async (path: string) => {
      setStatus("loading");
      setError(null);
      try {
        const opened = await api.openVault(path);
        setVault(opened);
        setTree(await api.readTree());
        setStatus("open");
      } catch (e) {
        setError(errorMessage(e));
        setStatus("welcome");
        void refreshRecents();
      }
    },
    [refreshRecents],
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
        setTree(await api.readTree());
        setStatus("open");
      } catch (e) {
        setError(errorMessage(e));
        setStatus("welcome");
      }
    },
    [],
  );

  const close = useCallback(async () => {
    try {
      await api.closeVault();
    } catch (e) {
      setError(errorMessage(e));
    }
    setVault(null);
    setTree([]);
    setStatus("welcome");
    void refreshRecents();
  }, [refreshRecents]);

  // Load recent vaults on first mount.
  useEffect(() => {
    void refreshRecents();
  }, [refreshRecents]);

  // While a vault is open, re-read the tree when it changes on disk (debounced to
  // coalesce bursts like a git pull or Obsidian sync). This is the backstop for
  // *external* edits; in-app create/rename/move/delete refresh themselves, so a
  // dead watcher degrades only live external sync, never in-app consistency.
  useEffect(() => {
    if (status !== "open") return;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void api
      .onTreeChanged(() => {
        // TODO(reader-stale-on-external-edit): this refreshes the tree only, so the
        // open reader can show stale content after an external edit/delete. Not a
        // loss — a save then hits the content-hash Conflict (or NotFound) backstop.
        // Deferred — round-10; fix by also reloading the open note when its file
        // changes on disk (debounced, draft-preserving).
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void refreshTree(), 300);
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
  }, [status, refreshTree]);

  // Native menu → vault lifecycle. Open Vault / Open Recent must work on the
  // welcome screen, before any vault is open — so they live here in the always-
  // mounted provider, not in the Workspace (which isn't mounted until a vault
  // opens). Every other menu action is vault-only and handled in the Workspace.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void api
      .onMenu((e) => {
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
  }, [openExisting, openByPath]);

  // Memoised so the context value is referentially stable across renders that
  // don't change any field — otherwise every consumer re-renders each tick (S6481).
  const value: VaultContextValue = useMemo(
    () => ({
      status,
      vault,
      tree,
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
      refreshTree,
    }),
    [
      status,
      vault,
      tree,
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
      refreshTree,
    ],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used within a VaultProvider");
  return ctx;
}
