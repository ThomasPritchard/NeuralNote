import { describe, expect, it } from "vitest";
import {
  NotificationProvider,
  ToastProvider,
  useNotifications,
  useToast,
} from ".";

describe("notification public API", () => {
  it("exports provider and hook names for app-level wiring", () => {
    expect(NotificationProvider).toBe(ToastProvider);
    expect(useNotifications).toBe(useToast);
  });
});
