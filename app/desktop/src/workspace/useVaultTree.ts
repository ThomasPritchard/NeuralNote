// The FULL vault tree, for the frontend consumers that still need the whole
// vault after the store's file tree went lazy (issue #40). The store now exposes
// only the per-directory `loaded` subset the sidebar displays; but wikilink
// (`[[`) autocomplete resolution, the StatusBar counts, and the template-dialog
// folder picker all need every note and folder — a link into an unexpanded folder
// must still resolve (moat-adjacent). This hook owns that whole-tree fetch through
// the still-recursive `read_tree` command, keeping the display lazy while those
// consumers keep the full vault.
//
// It stays in lockstep with the vault on disk the same way the store does: an
// immediate read on open, then a debounced re-read on every external change
// (Obsidian sync, git pull). The teardown mirrors the store's watcher exactly, so
// a late-resolving subscription can never leak across a vault reopen.

import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { TreeNode } from "../lib/types";

/** Coalesce a burst of on-disk changes (a git pull, an Obsidian sync) into one
 *  re-read, matching the store watcher's window. */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * The whole vault tree, kept live with the open vault.
 *
 * @param vaultPath the open vault's path, or `undefined` when none is open.
 *   Serves only as the effect key/gate — `read_tree` reads whichever vault the
 *   Rust core has open; changing this re-fetches for the new vault.
 * @param onError invoked with a display message when a read (or the subscription)
 *   fails, so the failure is surfaced rather than swallowed.
 * @returns `tree` — the full `TreeNode[]` (`[]` when no vault is open and until
 *   the first read lands) — and `refresh`, an imperative re-read for the manual
 *   Refresh action (the watcher already covers external edits; this is the
 *   user-initiated path that must not depend on a live subscription).
 */
export function useVaultTree(
  vaultPath: string | undefined,
  onError?: (message: string) => void,
): { tree: TreeNode[]; refresh: () => void } {
  const [tree, setTree] = useState<TreeNode[]>([]);
  // Holds the live effect's `load` so the stable `refresh` handle can re-read the
  // CURRENT vault without re-subscribing the watcher. Cleared on teardown, so a
  // refresh fired during a reopen window no-ops rather than reading a stale vault.
  const loadRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!vaultPath) {
      setTree([]);
      loadRef.current = undefined;
      return;
    }

    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const result = await api.readTree();
        if (!cancelled) setTree(result);
      } catch (e) {
        // A read that lands after teardown belongs to an abandoned vault — its
        // error would be stale, so the guard drops it. While the hook is live
        // (`cancelled` false), the failure is always surfaced, never swallowed.
        if (!cancelled) onError?.(errorMessage(e));
      }
    };
    loadRef.current = () => void load();

    void load();

    void api
      .onTreeChanged(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
      })
      .then((fn) => {
        // If the effect was already torn down before listen() resolved, unlisten
        // immediately — otherwise the listener leaks and stacks across reopens.
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => {
        // A failed subscription means external edits won't show live — surface it
        // rather than dropping the live-refresh silently.
        if (!cancelled) onError?.(errorMessage(e));
      });

    return () => {
      cancelled = true;
      loadRef.current = undefined;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [vaultPath, onError]);

  // Stable across renders; delegates to whichever effect run is live.
  const refresh = useCallback(() => loadRef.current?.(), []);

  return { tree, refresh };
}
