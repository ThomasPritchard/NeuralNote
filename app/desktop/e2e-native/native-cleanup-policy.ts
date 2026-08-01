export interface NativeNotificationDescriptor {
  kind: string;
  label: string;
}

const EXPECTED_NATIVE_NOTIFICATIONS = new Map([
  [
    "Automatic update check failed. plugin updater not found notification",
    "error",
  ],
  ["no vault is open notification", "error"],
  ["What's new acknowledged notification", "success"],
]);

const CLOSE_TAB_DISCARD_COPY =
  "This note has edits that haven't been saved. If you continue, they'll be lost.";

export function classifyNativeNotifications(
  notifications: readonly NativeNotificationDescriptor[],
): string[] {
  const unexpected = notifications.some(
    ({ kind, label }) => EXPECTED_NATIVE_NOTIFICATIONS.get(label) !== kind,
  );
  if (unexpected) {
    // Never echo a notification: native errors can contain fixture paths or
    // credential-shaped provider diagnostics, and failure artifacts are redacted.
    throw new Error("unexpected native notification is present");
  }
  return notifications.map(({ label }) => label);
}

export function assertCloseTabDiscardDialog(dialogText: string): void {
  if (!dialogText.includes(CLOSE_TAB_DISCARD_COPY)) {
    throw new Error("native E2E tab cleanup encountered a non-tab discard intent");
  }
}
