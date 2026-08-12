import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createToastState,
  getVisibleToasts,
  toastReducer,
  type ToastAction,
  type ToastKind,
  type ToastRecord,
} from "./toast-store";

export interface ToastOptions {
  action?: ToastAction;
  dedupKey?: string;
}

export interface ToastInput extends ToastOptions {
  kind: ToastKind;
  message: string;
}

export interface ToastController {
  notify: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  success: (message: string, options?: ToastOptions) => string;
  info: (message: string, options?: ToastOptions) => string;
  warning: (message: string, options?: ToastOptions) => string;
  error: (message: string, options?: ToastOptions) => string;
}

const ToastContext = createContext<ToastController | null>(null);

export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [state, dispatch] = useReducer(toastReducer, undefined, createToastState);
  const nextId = useRef(0);

  const notify = useCallback((input: ToastInput) => {
    nextId.current += 1;
    const id = `toast-${nextId.current}`;
    dispatch({ type: "add", toast: { id, ...input } });
    return id;
  }, []);

  const dismiss = useCallback((id: string) => {
    dispatch({ type: "dismiss", id });
  }, []);

  const controller = useMemo<ToastController>(() => {
    const notifyKind =
      (kind: ToastKind) => (message: string, options: ToastOptions = {}) =>
        notify({ kind, message, ...options });

    return {
      notify,
      dismiss,
      success: notifyKind("success"),
      info: notifyKind("info"),
      warning: notifyKind("warning"),
      error: notifyKind("error"),
    };
  }, [dismiss, notify]);

  const visibleToasts = getVisibleToasts(state);

  return (
    <ToastContext.Provider value={controller}>
      {/* The app and the notification dock share ONE column, as siblings.
       *
       *  The stack used to be `position: fixed` in the window's top-right
       *  corner — which is the chat pane's corner. Every notification therefore
       *  landed on the pane's header, and because an error never expires
       *  (`getToastDuration`), one unacknowledged error covered the pane's
       *  "Neural Assistant" title and the top of the conversation for the life
       *  of the session (issue #117).
       *
       *  Stacking the two in one column makes clearing the panes STRUCTURAL
       *  rather than an inset that happens to miss: the dock cannot reach a
       *  pane header, or the composer at the other end of that pane, because it
       *  is not inside the same box as either. Any offset — top, bottom, or
       *  corner — only chooses which pane the stack covers instead.
       *
       *  What the column costs is that the two now compete for the same pixels:
       *  the content row has no floor and the dock does not shrink, so the well
       *  below carries a ceiling of its own. */}
      <div className="flex h-full w-full flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        <ToastViewport toasts={visibleToasts} onDismiss={dismiss} />
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastController {
  const controller = useContext(ToastContext);
  if (!controller) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return controller;
}

function ToastViewport({
  toasts,
  onDismiss,
}: Readonly<{
  toasts: ToastRecord[];
  onDismiss: (id: string) => void;
}>) {
  const documentHidden = useDocumentHidden();
  const announcedToastIds = useRef(new Set<string>());
  const [politeAnnouncement, setPoliteAnnouncement] = useState("");

  useEffect(() => {
    const newlyVisible: string[] = [];
    for (const toast of toasts) {
      if (announcedToastIds.current.has(toast.id)) continue;
      announcedToastIds.current.add(toast.id);
      if (toast.kind !== "error") newlyVisible.push(toast.message);
    }
    if (newlyVisible.length > 0) setPoliteAnnouncement(newlyVisible.join(". "));
  }, [toasts]);

  return (
    // Zero height until something is raised, so an idle window looks exactly as
    // it did: the live region is `sr-only` (out of flow) and the well below it
    // is not rendered at all while the stack is empty. The region itself stays
    // MOUNTED across that — a live region recreated with its message already
    // inside it is not reliably announced. Moving it inside the branch below
    // reds the empty-stack case in `ToastViewport.browser.test.tsx`, which is
    // the only test that looks before a notification has been raised.
    //
    // `role="region"` because a bare `div` is `role="generic"` and browsers drop
    // an `aria-label` on one. In flow rather than floating over the app, the
    // dock is a real landmark, so the label now survives to name it.
    <div role="region" aria-label="Notifications" className="shrink-0">
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {politeAnnouncement}
      </div>
      {toasts.length > 0 && (
        // A sunken well at the window's bottom edge. `bg-surface-sunken` is the
        // app's recessed ground — everywhere else it lines a rounded box inside
        // a panel, and this is its one full-bleed use — so the notifications
        // stay the raised cards they already were, standing in it, and the
        // hairline separates the well from the status bar it opens beneath.
        //
        // The ceiling is what keeps the borrowed space a loan. The dock does not
        // shrink and the content row above has no floor, so an uncapped well
        // simply keeps taking: three real save failures, each carrying the
        // backend's whole error chain and its absolute paths, measure 859px —
        // more than the entire 600px window `tauri.conf.json` allows as its
        // minimum, leaving the workspace nothing. Two fifths of the window is
        // the most the dock may hold; past that it scrolls, so no notification
        // is lost to the cap.
        <div className="max-h-[40vh] overflow-y-auto border-t border-border bg-surface-sunken px-4 py-3">
          <ol className="ml-auto flex w-full max-w-96 flex-col gap-2">
            {toasts.map((toast) => (
              <ToastItem
                key={toast.id}
                toast={toast}
                documentHidden={documentHidden}
                onDismiss={onDismiss}
              />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function ToastItem({
  toast,
  documentHidden,
  onDismiss,
}: Readonly<{
  toast: ToastRecord;
  documentHidden: boolean;
  onDismiss: (id: string) => void;
}>) {
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);
  const duration = getToastDuration(toast);

  useDismissTimer(duration, hovered || focusWithin || documentHidden, dismiss);

  return (
    <li
      role={toast.kind === "error" ? "alert" : undefined}
      aria-label={`${toast.message} notification`}
      data-testid="toast"
      data-toast-kind={toast.kind}
      className={`rounded-lg border p-3 text-sm text-foreground shadow-lg ${TOAST_KIND_STYLES[toast.kind]}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusWithin(false);
        }
      }}
    >
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1">{toast.message}</p>
        <button
          type="button"
          aria-label="Dismiss notification"
          className="min-h-6 min-w-6 rounded text-muted-foreground hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={dismiss}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {toast.action && (
        <button
          type="button"
          className="mt-2 min-h-6 rounded font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={toast.action.onClick}
        >
          {toast.action.label}
        </button>
      )}
    </li>
  );
}

const TOAST_DURATIONS: Record<Exclude<ToastKind, "error">, number> = {
  success: 4_000,
  info: 6_000,
  warning: 10_000,
};

const TOAST_KIND_STYLES: Record<ToastKind, string> = {
  success: "border-primary/40 bg-surface-raised",
  info: "border-border bg-surface-raised",
  warning: "border-warning/40 bg-warning/10",
  error: "border-destructive/40 bg-destructive/10",
};

function getToastDuration(toast: ToastRecord): number | null {
  if (toast.kind === "error" || toast.action) return null;
  return TOAST_DURATIONS[toast.kind];
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);

  useEffect(() => {
    const updateVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  return hidden;
}

function useDismissTimer(
  duration: number | null,
  paused: boolean,
  onElapsed: () => void,
) {
  const remaining = useRef(duration);

  useEffect(() => {
    const remainingDuration = remaining.current;
    if (duration === null || paused || remainingDuration === null) return;

    const startedAt = Date.now();
    const timeout = globalThis.setTimeout(onElapsed, remainingDuration);

    return () => {
      globalThis.clearTimeout(timeout);
      const elapsed = Date.now() - startedAt;
      remaining.current = Math.max(0, remainingDuration - elapsed);
    };
  }, [duration, onElapsed, paused]);
}
