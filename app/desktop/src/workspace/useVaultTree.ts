// Full-vault index for wikilinks, counts, and folder pickers; the sidebar loads
// directories lazily. Failed reads keep the last tree but mark it unverified.

import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { TreeNode } from "../lib/types";

const REFRESH_DEBOUNCE_MS = 300;

/** `ready` includes an empty vault; `loading` and `failed` cannot establish counts. */
export type VaultTreeStatus = "loading" | "ready" | "failed";

/** `vaultPath` keys the effect; readTree reads the vault currently open in Rust. */
export function useVaultTree(
  vaultPath: string | undefined,
  onError?: (message: string) => void,
): { tree: TreeNode[]; status: VaultTreeStatus; refresh: () => void } {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [status, setStatus] = useState<VaultTreeStatus>(
    vaultPath ? "loading" : "ready",
  );
  // Stable refresh delegates to the live effect and becomes inert on teardown.
  const loadRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!vaultPath) {
      setTree([]);
      setStatus("ready");
      loadRef.current = undefined;
      return;
    }

    let cancelled = false;
    let generation = 0;
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      const requestGeneration = ++generation;
      try {
        const result = await api.readTree();
        if (!cancelled && requestGeneration === generation) {
          setTree(result);
          setStatus("ready");
        }
      } catch (e) {
        // Only the newest request owns state and errors. Keep the last good
        // tree on failure; clearing it would misrepresent failure as emptiness.
        if (!cancelled && requestGeneration === generation) {
          setStatus("failed");
          onError?.(errorMessage(e));
        }
      }
    };
    loadRef.current = () => void load();

    setStatus("loading");
    void load();

    void api
      .onTreeChanged(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
      })
      .then((fn) => {
        // A subscription resolving after teardown must not leak into a reopen.
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => {
        if (!cancelled) onError?.(errorMessage(e));
      });

    return () => {
      cancelled = true;
      loadRef.current = undefined;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [vaultPath, onError]);

  const refresh = useCallback(() => loadRef.current?.(), []);

  return { tree, status, refresh };
}
