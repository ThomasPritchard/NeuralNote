import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyNativeFailure,
  shouldCleanupAfterNativeRunner,
  shouldRetryNativeRun,
} from "./runner-policy.js";

test("retries once only when infrastructure fails before the first test starts", () => {
  assert.equal(
    shouldRetryNativeRun({
      attempt: 0,
      exitCode: 1,
      readinessObserved: false,
      failureKind: "app-or-driver-startup",
    }),
    true,
  );
  assert.equal(
    shouldRetryNativeRun({
      attempt: 1,
      exitCode: 1,
      readinessObserved: false,
      failureKind: "app-or-driver-startup",
    }),
    false,
  );
});

test("never retries a failure after the readiness sentinel", () => {
  assert.equal(
    shouldRetryNativeRun({
      attempt: 0,
      exitCode: 1,
      readinessObserved: true,
      failureKind: "app-or-driver-startup",
    }),
    false,
  );
  assert.equal(
    shouldRetryNativeRun({
      attempt: 0,
      exitCode: 0,
      readinessObserved: false,
      failureKind: "test-or-configuration",
    }),
    false,
  );
});

test("does not retry syntax, import, or configuration failures before readiness", () => {
  const kind = classifyNativeFailure(
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './broken-spec.js'",
    false,
  );
  assert.equal(kind, "test-or-configuration");
  assert.equal(
    shouldRetryNativeRun({ attempt: 0, exitCode: 1, readinessObserved: false, failureKind: kind }),
    false,
  );
});

test("classifies only explicit app, driver, or runner startup failures as retryable", () => {
  assert.equal(classifyNativeFailure("Failed to create remote session", false), "app-or-driver-startup");
  assert.equal(classifyNativeFailure("", true), "app-or-driver-startup");
  assert.equal(classifyNativeFailure("AssertionError: expected source", false), "test-or-configuration");
});

test("cleans the marked root only after normal runner returns", () => {
  assert.equal(shouldCleanupAfterNativeRunner([]), false);
  assert.equal(shouldCleanupAfterNativeRunner([null, null, null]), true);
  assert.equal(shouldCleanupAfterNativeRunner([null, "SIGTERM"]), false);
  assert.equal(shouldCleanupAfterNativeRunner(["SIGABRT"]), false);
});
