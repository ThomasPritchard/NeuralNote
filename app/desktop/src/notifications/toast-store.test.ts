import { describe, expect, it } from "vitest";
import {
  createToastState,
  getQueuedToasts,
  getVisibleToasts,
  toastReducer,
  type ToastRecord,
} from "./toast-store";

function toast(id: string, dedupKey?: string): ToastRecord {
  return {
    id,
    kind: "info",
    message: `Message ${id}`,
    dedupKey,
  };
}

describe("toastReducer", () => {
  it("shows at most three toasts and queues the rest in insertion order", () => {
    const state = ["one", "two", "three", "four"].reduce(
      (current, id) => toastReducer(current, { type: "add", toast: toast(id) }),
      createToastState(),
    );

    expect(getVisibleToasts(state).map(({ id }) => id)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(getQueuedToasts(state).map(({ id }) => id)).toEqual(["four"]);
  });

  it("promotes the oldest queued toast when a visible toast is dismissed", () => {
    const populated = ["one", "two", "three", "four"].reduce(
      (current, id) => toastReducer(current, { type: "add", toast: toast(id) }),
      createToastState(),
    );

    const state = toastReducer(populated, { type: "dismiss", id: "two" });

    expect(getVisibleToasts(state).map(({ id }) => id)).toEqual([
      "one",
      "three",
      "four",
    ]);
    expect(getQueuedToasts(state)).toEqual([]);
  });

  it("ignores a toast whose deduplication key is already visible or queued", () => {
    const initial = [
      toast("one", "save-result"),
      toast("two"),
      toast("three"),
      toast("queued", "update-result"),
    ].reduce(
      (current, nextToast) =>
        toastReducer(current, { type: "add", toast: nextToast }),
      createToastState(),
    );

    const afterVisibleDuplicate = toastReducer(initial, {
      type: "add",
      toast: toast("duplicate-visible", "save-result"),
    });
    const afterQueuedDuplicate = toastReducer(afterVisibleDuplicate, {
      type: "add",
      toast: toast("duplicate-queued", "update-result"),
    });

    expect(afterQueuedDuplicate).toBe(initial);
  });
});
