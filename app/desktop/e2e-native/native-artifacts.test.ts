import assert from "node:assert/strict";
import test from "node:test";

import {
  failureMetadata,
  redactArtifactText,
  sanitizeNativeRunLog,
} from "./native-artifacts.js";

test("redacts the temporary root and credential-shaped values", () => {
  const root = "/tmp/neuralnote-native-e2e-private";
  const source = [
    `opened ${root}/vaults/Private/Note.md`,
    "api_key=sk-live-example",
    "password: hunter2",
    "TOKEN=secret-token",
  ].join("\n");

  const redacted = redactArtifactText(source, root);

  assert.equal(redacted.includes(root), false);
  assert.equal(redacted.includes("sk-live-example"), false);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("secret-token"), false);
  assert.match(redacted, /<E2E_ROOT>/);
});

test("uploaded native logs omit WebDriver payloads and assertion values", () => {
  const root = "/tmp/neuralnote-native-e2e-private";
  const source = [
    "2026-07-31T10:26:02.594Z INFO tauri-service:launcher: Using embedded WebDriver provider",
    "[0-0] 2026-07-31T10:26:05.199Z INFO webdriver: DATA {\"content\":\"PRIVATE NOTE BODY\"}",
    "AssertionError: expected 'PRIVATE NOTE BODY' to equal 'OTHER PRIVATE BODY'",
    "Spec Files: 6 passed, 1 failed, 7 total",
  ].join("\n");

  const sanitized = sanitizeNativeRunLog(source, root);

  assert.equal(sanitized.includes("Using embedded WebDriver provider"), false);
  assert.match(sanitized, /Spec Files: 6 passed, 1 failed, 0 skipped, 7 total/);
  assert.equal(sanitized.includes("PRIVATE NOTE BODY"), false);
  assert.equal(sanitized.includes("OTHER PRIVATE BODY"), false);
  assert.equal(sanitized.includes("webdriver: DATA"), false);
});

test("lifecycle-looking prefixes cannot smuggle note content into native logs", () => {
  const source = [
    "Spec Files: PRIVATE NOTE BODY",
    "2026-07-31T10:26:02.594Z ERROR @wdio/cli:launcher: PRIVATE NOTE BODY",
    "[0-0] FAILED in tauri - file:///specs/30-markdown-source.spec.ts",
    "PRIVATE NOTE BODY",
  ].join("\n");

  const sanitized = sanitizeNativeRunLog(source, "/tmp/neuralnote-native-e2e-private");

  assert.equal(sanitized.includes("PRIVATE NOTE BODY"), false);
  assert.equal(sanitized, "[0-0] FAILED in tauri - file:///specs/30-markdown-source.spec.ts\n");
});

test("lifecycle status accepts only the fixed native spec allowlist", () => {
  const source = [
    "[0-0] FAILED in tauri - file:///specs/private-token.md",
    "[0-0] PASSED in tauri - file:///specs/61-workspace-restart-assert.spec.ts",
  ].join("\n");

  assert.equal(
    sanitizeNativeRunLog(source, "/tmp/neuralnote-native-e2e-private"),
    "[0-0] PASSED in tauri - file:///specs/61-workspace-restart-assert.spec.ts\n",
  );
});

test("failure metadata records an error type without serializing its message or stack", () => {
  const metadata = failureMetadata(
    "keeps a dirty draft",
    new Error("PRIVATE NOTE BODY at /tmp/neuralnote-native-e2e-private/vaults/Note.md"),
  );

  assert.deepEqual(metadata, {
    schemaVersion: 1,
    title: "keeps a dirty draft",
    errorType: "Error",
    fixture: "synthetic-native-e2e-v1",
    editorContentRedacted: true,
  });
});
