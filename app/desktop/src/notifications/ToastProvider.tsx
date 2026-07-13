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

export function ToastProvider({ children }: { children: ReactNode }) {
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
      {children}
      <ToastViewport toasts={visibleToasts} onDismiss={dismiss} />
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
}: {
  toasts: ToastRecord[];
  onDismiss: (id: string) => void;
}) {
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
    <div
      aria-label="Notifications"
      className="pointer-events-none fixed right-4 top-[calc(var(--titlebar-height,2rem)+1rem)] z-50 w-[min(24rem,calc(100vw-2rem))]"
    >
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {politeAnnouncement}
      </div>
      <ol className="flex flex-col gap-2">
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
  );
}

function ToastItem({
  toast,
  documentHidden,
  onDismiss,
}: {
  toast: ToastRecord;
  documentHidden: boolean;
  onDismiss: (id: string) => void;
}) {
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
      className={`pointer-events-auto rounded-lg border p-3 text-sm text-foreground shadow-lg ${TOAST_KIND_STYLES[toast.kind]}`}
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
    const timeout = window.setTimeout(onElapsed, remainingDuration);

    return () => {
      window.clearTimeout(timeout);
      const elapsed = Date.now() - startedAt;
      remaining.current = Math.max(0, remainingDuration - elapsed);
    };
  }, [duration, onElapsed, paused]);
}
