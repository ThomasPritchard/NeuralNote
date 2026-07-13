export const MAX_VISIBLE_TOASTS = 3;

export type ToastKind = "success" | "info" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastRecord {
  id: string;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  dedupKey?: string;
}

export interface ToastState {
  toasts: ToastRecord[];
}

type ToastReducerAction =
  | { type: "add"; toast: ToastRecord }
  | { type: "dismiss"; id: string };

export function createToastState(): ToastState {
  return { toasts: [] };
}

export function toastReducer(
  state: ToastState,
  action: ToastReducerAction,
): ToastState {
  if (action.type === "dismiss") {
    return {
      toasts: state.toasts.filter(({ id }) => id !== action.id),
    };
  }

  const { dedupKey } = action.toast;
  const isDuplicate =
    dedupKey !== undefined &&
    state.toasts.some((toast) => toast.dedupKey === dedupKey);

  if (isDuplicate) return state;

  return { toasts: [...state.toasts, action.toast] };
}

export function getVisibleToasts(state: ToastState): ToastRecord[] {
  return state.toasts.slice(0, MAX_VISIBLE_TOASTS);
}

export function getQueuedToasts(state: ToastState): ToastRecord[] {
  return state.toasts.slice(MAX_VISIBLE_TOASTS);
}
