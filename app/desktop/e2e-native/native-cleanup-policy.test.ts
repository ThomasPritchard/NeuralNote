import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCloseTabDiscardDialog,
  classifyNativeNotifications,
} from "./native-cleanup-policy.js";

test("allows only the exact expected native harness notifications", () => {
  assert.deepEqual(
    classifyNativeNotifications([
      {
        kind: "error",
        label: "Automatic update check failed. plugin updater not found notification",
      },
      { kind: "error", label: "no vault is open notification" },
      { kind: "success", label: "What's new acknowledged notification" },
    ]),
    [
      "Automatic update check failed. plugin updater not found notification",
      "no vault is open notification",
      "What's new acknowledged notification",
    ],
  );
});

test("fails closed on an unexpected notification without echoing its content", () => {
  const secretBearingLabel = "provider failed with sk-secret notification";
  assert.throws(
    () =>
      classifyNativeNotifications([
        { kind: "error", label: secretBearingLabel },
      ]),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message, "unexpected native notification is present");
      assert.equal((error as Error).message.includes(secretBearingLabel), false);
      return true;
    },
  );
});

test("accepts only close-tab discard copy", () => {
  assert.doesNotThrow(() =>
    assertCloseTabDiscardDialog(
      "Discard unsaved changes? This note has edits that haven't been saved. If you continue, they'll be lost.",
    ),
  );
  assert.throws(
    () =>
      assertCloseTabDiscardDialog(
        "Discard unsaved changes? 2 open notes have unsaved changes. If you continue, they'll be lost.",
      ),
    /non-tab discard intent/u,
  );
});
