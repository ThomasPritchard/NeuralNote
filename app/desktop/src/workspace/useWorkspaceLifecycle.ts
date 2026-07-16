// The workspace's session lifecycle, grouped out of Workspace.tsx: the durable
// ordered tab state (load on open, restore, debounced persist, flush on unmount)
// and the destructive-action guard that must flush that state before anything
// closes. These two concerns share one resource — the workspace state writer —
// so they live in one hook: keeping the writer a LOCAL ref means every effect and
// callback that reads it stays exempt from exhaustive-deps (no ref-in-cleanup
// trap, no dependency-array churn), which a persistence/intent split would force.
//
// The native-menu and window-close subscriptions that TRIGGER these actions stay
// in Workspace.tsx — they wire several concerns together and belong in the
// composing view, next to the menu dispatch.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "../lib/api";
import type { VaultContextValue } from "../lib/store";
import type { ToastController } from "../notifications";
import type { TreeNode } from "../lib/types";
import { parentRelPath } from "./fileMeta";
import type { CenterView } from "./Ribbon";
import { noteTabTriggerId } from "./TitleBar";
import type { NoteTabsController } from "./useNoteTabs";
import {
  describeDiscard,
  persistedWorkspaceState,
  type PendingIntent,
} from "./workspaceIntents";
import { createWorkspaceStateWriter } from "./workspaceStateWriter";

export interface UseWorkspaceLifecycleParams {
  vaultPath: string | undefined;
  noteTabs: NoteTabsController;
  toast: ToastController;
  setCenterView: Dispatch<SetStateAction<CenterView>>;
  close: VaultContextValue["close"];
  openExisting: VaultContextValue["openExisting"];
  openByPath: VaultContextValue["openByPath"];
  refreshDir: VaultContextValue["refreshDir"];
}

export interface WorkspaceLifecycleController {
  pendingIntent: PendingIntent | null;
  requestIntent: (intent: PendingIntent) => void;
  handleDeleteRequest: (node: TreeNode) => void;
  handleCloseVault: () => void;
  discardMessage: string;
  confirmPendingIntent: () => void;
  cancelPendingIntent: () => void;
}

export function useWorkspaceLifecycle({
  vaultPath,
  noteTabs,
  toast,
  setCenterView,
  close,
  openExisting,
  openByPath,
  refreshDir,
}: UseWorkspaceLifecycleParams): WorkspaceLifecycleController {
  const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null);

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
  workspaceWriterRef.current ??= createWorkspaceStateWriter(
    api.saveWorkspaceState,
    (writeError) =>
      toast.error(api.errorMessage(writeError), {
        dedupKey: "workspace-state-save",
      }),
  );

  /** Force-close the window past the close-request guard. If destroy() rejects the
   *  window is merely left open (safe — no data lost), so log rather than swallow. */
  const closeWindow = useCallback(async () => {
    try {
      await getCurrentWindow().destroy();
    } catch (err) {
      console.error("window destroy failed:", err);
    }
  }, []);

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

    // Hoisted out of the recovery-toast action so the reset promise chain sits
    // near the top of the effect rather than nested five callbacks deep.
    const applyReset = () => {
      if (cancelled || activeVaultPathRef.current !== vaultPath) return;
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
    };

    void api
      .loadWorkspaceState()
      .then((restored) => {
        if (cancelled) return;
        if (restored.recoveredFromCorrupt) {
          setWorkspaceStateBlocked(true);
          setWorkspaceStateReady(true);
          recoveryToastId = toast.error(
            restored.recoveryMessage ?? "Workspace tab state could not be restored.",
            {
              dedupKey: "workspace-state-recovery",
              action: {
                label: "Reset tab state",
                onClick: applyReset,
              },
            },
          );
          return;
        }

        const ids: string[] = [];
        let desiredId: string | null = null;
        for (const relativePath of restored.state.openPaths) {
          const id = noteTabsRef.current.open(`${vaultPath}/${relativePath}`, {
            forceNew: true,
          });
          ids.push(id);
          if (relativePath === restored.state.activePath) desiredId = id;
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
  }, [noteTabs, noteTabs.tabs, setCenterView, toast]);

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
            // Re-list just the deleted entry's parent folder (per spec §CRUD).
            await refreshDir(parentRelPath(intent.node.relPath));
            noteTabsRef.current.removeDescendants(intent.node.path);
          } catch (deleteError) {
            toast.error(api.errorMessage(deleteError));
          }
      }
    },
    [close, closeWindow, openByPath, openExisting, refreshDir, toast],
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

  const discardMessage = useMemo(
    () =>
      pendingIntent
        ? describeDiscard(pendingIntent, noteTabs.dirtyTabs.length)
        : "",
    [noteTabs.dirtyTabs.length, pendingIntent],
  );

  const confirmPendingIntent = useCallback(() => {
    const intent = pendingIntentRef.current;
    if (!intent) return;
    pendingIntentRef.current = null;
    setPendingIntent(null);
    void performIntent(intent);
  }, [performIntent]);

  const cancelPendingIntent = useCallback(() => {
    const intent = pendingIntentRef.current;
    const restoreFocus =
      intent?.kind === "close-tab" ? intent.restoreFocus : null;
    pendingIntentRef.current = null;
    setPendingIntent(null);
    queueMicrotask(() => restoreFocus?.focus());
  }, []);

  return {
    pendingIntent,
    requestIntent,
    handleDeleteRequest,
    handleCloseVault,
    discardMessage,
    confirmPendingIntent,
    cancelPendingIntent,
  };
}
