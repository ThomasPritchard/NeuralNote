// The workspace's native menu + window integration, grouped out of Workspace.tsx.
// Owns the four subscriptions/effects that tie the webview to the OS chrome:
//   · onCloseRequested — hold the OS close / Cmd-Q so tab state flushes first
//   · onMenu           — dispatch every vault-scoped menu action across concerns
//   · setMenuEditing   — mirror editability to the menu's Format items
//   · setChatVisible   — mirror chat visibility to the View-menu checkmark
// These dispatch ACROSS the layout / lifecycle / tab concerns, so they take the
// relevant handlers as params rather than owning that state. Kept together (and
// out of the composing view) because they're one integration surface, and last
// in the effect order exactly as they were inline.

import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import type { CenterView } from "./Ribbon";
import type { CreateKind } from "./TreeRow";
import type { NoteTabsController } from "./useNoteTabs";
import type { PendingIntent } from "./workspaceIntents";

export interface UseWorkspaceMenuParams {
  noteTabs: NoteTabsController;
  requestIntent: (intent: PendingIntent) => void;
  reportError: (message: string) => void;
  startCreate: (kind: CreateKind) => void;
  selectFiles: () => void;
  selectSearch: () => void;
  toggleNavigation: () => void;
  setCenterView: Dispatch<SetStateAction<CenterView>>;
  setShowChat: Dispatch<SetStateAction<boolean>>;
  /** Whether a compatible text note is open — drives the Format menu enablement. */
  editing: boolean;
  /** Whether the chat panel is open — mirrored to the View-menu checkmark. */
  showChat: boolean;
}

export function useWorkspaceMenu({
  noteTabs,
  requestIntent,
  reportError,
  startCreate,
  selectFiles,
  selectSearch,
  toggleNavigation,
  setCenterView,
  setShowChat,
  editing,
  showChat,
}: UseWorkspaceMenuParams): void {
  // Stable callbacks read the latest tabs without re-registering native listeners
  // on every editor keystroke.
  const noteTabsRef = useRef(noteTabs);
  noteTabsRef.current = noteTabs;

  // Intercept OS window close / Cmd-Q: hold the window long enough to flush the
  // ordered workspace state, and route dirty tabs through the same discard guard
  // as other destructive actions. Mirrors store.tsx's
  // cancelled-flag teardown so a listen() that resolves after unmount can't leak.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        // Always hold the native close briefly so the newest ordered tab state can
        // flush before destroy. Dirty tabs route through the same explicit warning.
        event.preventDefault();
        requestIntent({ kind: "close-window" });
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
  }, [reportError, requestIntent]);

  // Native menu → vault-scoped actions. While Workspace is mounted it also owns
  // Open Vault / Open Recent so every dirty tab can guard the vault switch.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void api
      .onMenu((e) => {
        const o = noteTabsRef.current.active;
        switch (e.action) {
          case "new-note":
            startCreate("note");
            break;
          case "new-folder":
            startCreate("folder");
            break;
          case "save":
            if (o.note && o.dirty && !o.saving) void o.save();
            break;
          case "close-tab": {
            const tabId = noteTabsRef.current.activeTabId;
            if (tabId) {
              requestIntent({
                kind: "close-tab",
                tabId,
                restoreFocus: document.activeElement as HTMLElement | null,
              });
            }
            break;
          }
          case "close-window":
            requestIntent({ kind: "close-window" });
            break;
          case "quit-app":
            requestIntent({ kind: "quit-app" });
            break;
          case "close-vault":
            requestIntent({ kind: "close-vault" });
            break;
          case "open-vault":
            requestIntent({ kind: "open-vault" });
            break;
          case "open-recent":
            if (e.path) requestIntent({ kind: "open-recent", path: e.path });
            break;
          case "search":
          case "view-search":
            selectSearch();
            break;
          case "view-files":
            selectFiles();
            break;
          case "toggle-graph":
            setCenterView((v) => (v === "graph" ? "note" : "graph"));
            break;
          case "toggle-chat":
            // The webview owns showChat; the CheckMenuItem just requests a flip
            // (no `checked` payload). The effect below pushes the new value to Rust.
            setShowChat((v) => !v);
            break;
          case "toggle-sidebar":
            toggleNavigation();
            break;
          case "format-bold":
          case "format-italic":
          case "format-h1":
          case "format-h2":
          case "format-h3":
          case "format-link":
            // Formatting actions are owned by the focused note editor's own menu
            // subscription (markdownFormat.ts); they are intentional no-ops here.
            break;
          default: {
            // MenuAction is generated from Rust's CUSTOM_ACTIONS (#19), so this is
            // exhaustive: a NEW native action that no consumer handles fails the
            // build here instead of silently becoming a dead menu item. The runtime
            // warn is belt-and-braces if an untyped id ever reaches the webview.
            const unhandled: never = e.action;
            console.warn("unhandled menu action:", unhandled);
            break;
          }
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
  }, [
    reportError,
    requestIntent,
    startCreate,
    selectFiles,
    selectSearch,
    toggleNavigation,
    setCenterView,
    setShowChat,
  ]);

  // Every compatible text note is directly editable. Keep Format enabled while
  // a text note is open; the focused rich/raw editor still owns the command.
  useEffect(() => {
    void api
      .setMenuEditing(editing)
      .catch((err) => console.error("failed to sync editor state to the menu:", err));
  }, [editing]);

  // The webview owns showChat; push each change to Rust so the View-menu checkmark
  // stays in agreement (mirrors the editing effect above). Best-effort — cosmetic.
  useEffect(() => {
    void api.setChatVisible(showChat).catch((err) =>
      console.error("failed to sync chat visibility to the menu:", err));
  }, [showChat]);
}
