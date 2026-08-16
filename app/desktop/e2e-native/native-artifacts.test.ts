import assert from "node:assert/strict";
import test from "node:test";

import {
  failureMetadata,
  redactArtifactText,
  sanitizeNativeRunLog,
} from "./native-artifacts.js";

const FIXTURE_ROOT = "/tmp/neuralnote-native-e2e-private";

test("redacts the temporary root and credential-shaped values", () => {
  const source = [
    `opened ${FIXTURE_ROOT}/vaults/Private/Note.md`,
    "api_key=sk-live-example",
    "password: hunter2",
    "TOKEN=secret-token",
  ].join("\n");

  const redacted = redactArtifactText(source, FIXTURE_ROOT);

  assert.equal(redacted.includes(FIXTURE_ROOT), false);
  assert.equal(redacted.includes("sk-live-example"), false);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("secret-token"), false);
  assert.match(redacted, /<E2E_ROOT>/);
});

test("uploaded native logs omit WebDriver payloads and assertion values", () => {
  const source = [
    "2026-07-31T10:26:02.594Z INFO tauri-service:launcher: Using embedded WebDriver provider",
    "[0-0] 2026-07-31T10:26:05.199Z INFO webdriver: DATA {\"content\":\"PRIVATE NOTE BODY\"}",
    "AssertionError: expected 'PRIVATE NOTE BODY' to equal 'OTHER PRIVATE BODY'",
    "Spec Files: 6 passed, 1 failed, 7 total",
  ].join("\n");

  const sanitized = sanitizeNativeRunLog(source, FIXTURE_ROOT);

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

  const sanitized = sanitizeNativeRunLog(source, FIXTURE_ROOT);

  assert.equal(sanitized.includes("PRIVATE NOTE BODY"), false);
  assert.equal(sanitized, "[0-0] FAILED in tauri - file:///specs/30-markdown-source.spec.ts\n");
});

test("lifecycle status accepts only the fixed native spec allowlist", () => {
  const source = [
    "[0-0] FAILED in tauri - file:///specs/private-token.md",
    "[0-0] PASSED in tauri - file:///specs/61-workspace-restart-assert.spec.ts",
  ].join("\n");

  assert.equal(
    sanitizeNativeRunLog(source, FIXTURE_ROOT),
    "[0-0] PASSED in tauri - file:///specs/61-workspace-restart-assert.spec.ts\n",
  );
});

test("failure metadata records the error type and a redacted message", () => {
  const metadata = failureMetadata(
    "keeps a dirty draft",
    new Error('element ("[data-testid=\'editor\']") still not displayed after 60000ms'),
    FIXTURE_ROOT,
  );

  assert.deepEqual(metadata, {
    schemaVersion: 3,
    title: "keeps a dirty draft",
    errorType: "Error",
    redactedErrorMessage:
      'element ("[data-testid=\'editor\']") still not displayed after 60000ms',
    fixture: "synthetic-native-e2e-v1",
    editorContentRedacted: true,
  });
});

test("failure metadata replaces the E2E root inside the error message", () => {
  const metadata = failureMetadata(
    "opens the seeded vault",
    new Error(`ENOENT: no such file or directory, open '${FIXTURE_ROOT}/vaults/Note.md'`),
    FIXTURE_ROOT,
  );

  assert.equal(metadata.redactedErrorMessage.includes(FIXTURE_ROOT), false);
  assert.match(metadata.redactedErrorMessage, /<E2E_ROOT>\/vaults\/Note\.md/);
});

test("failure metadata redacts credential-shaped values inside the error message", () => {
  const metadata = failureMetadata(
    "configures the provider",
    new Error("rejected: api_key=sk-live-example token: ghp-example password=hunter2"),
    FIXTURE_ROOT,
  );

  assert.equal(metadata.redactedErrorMessage.includes("sk-live-example"), false);
  assert.equal(metadata.redactedErrorMessage.includes("ghp-example"), false);
  assert.equal(metadata.redactedErrorMessage.includes("hunter2"), false);
  assert.match(metadata.redactedErrorMessage, /<REDACTED>/);
});

test("failure metadata keeps assertion diff values out of the error message", () => {
  const metadata = failureMetadata(
    "changes one local span",
    new Error(
      'Expect $(`.cm-content`) to have text\n\nExpected: "PRIVATE NOTE BODY"\nReceived: "OTHER PRIVATE BODY"',
    ),
    FIXTURE_ROOT,
  );

  assert.equal(metadata.redactedErrorMessage, "Expect $(`.cm-content`) to have text");
  assert.equal(metadata.redactedErrorMessage.includes("PRIVATE NOTE BODY"), false);
});

test("failure metadata treats a bare carriage return as a line break", () => {
  const metadata = failureMetadata(
    "reconciles the CRLF fixture",
    new Error('Expect $(`.cm-content`) to have text\rExpected: "PRIVATE NOTE BODY"'),
    FIXTURE_ROOT,
  );

  assert.equal(metadata.redactedErrorMessage, "Expect $(`.cm-content`) to have text");
});

test("failure metadata never serializes a stack", () => {
  const error = new Error("boom");
  error.stack = "Error: boom\n    at Object.<anonymous> (/Users/someone/secret/path.ts:1:1)";

  const metadata = failureMetadata("throws from the harness", error, FIXTURE_ROOT);

  assert.equal(metadata.redactedErrorMessage, "boom");
  assert.equal(Object.keys(metadata).includes("stack"), false);
});

test("failure metadata survives a non-Error throw", () => {
  assert.equal(
    failureMetadata("throws a string", "boom", FIXTURE_ROOT).redactedErrorMessage,
    "boom",
  );
  assert.equal(
    failureMetadata("throws an object", { code: 7 }, FIXTURE_ROOT).redactedErrorMessage,
    "[object Object]",
  );
  assert.equal(
    failureMetadata("throws null", null, FIXTURE_ROOT).redactedErrorMessage,
    "null",
  );
  assert.equal(
    failureMetadata("throws undefined", undefined, FIXTURE_ROOT).redactedErrorMessage,
    "undefined",
  );
});

test("failure metadata survives a throw that cannot be stringified", () => {
  const hostile = {
    toString() {
      throw new Error("no string for you");
    },
  };

  const metadata = failureMetadata("throws a hostile value", hostile, FIXTURE_ROOT);

  assert.equal(metadata.redactedErrorMessage, "<unreadable error>");
  assert.equal(metadata.editorContentRedacted, true);
});

test("failure metadata survives an error whose name cannot be read", () => {
  // `Object.defineProperty` rather than a subclass: TypeScript rejects an
  // accessor that overrides `Error`'s `name` data property (TS2611), and the
  // hostile behaviour under test is identical either way.
  const hostile = new Error("boom");
  Object.defineProperty(hostile, "name", {
    get() {
      throw new Error("no name for you");
    },
  });

  const metadata = failureMetadata("throws a hostile error", hostile, FIXTURE_ROOT);

  assert.equal(metadata.errorType, "<unreadable error type>");
  assert.equal(metadata.redactedErrorMessage, "boom");
});

test("failure metadata records the assertion code and operator the first line drops", () => {
  let thrown: unknown;
  try {
    assert.equal("PRIVATE NOTE BODY", "OTHER PRIVATE BODY");
  } catch (error) {
    thrown = error;
  }

  const metadata = failureMetadata("changes one local span", thrown, FIXTURE_ROOT);

  assert.equal(metadata.redactedErrorMessage, "Expected values to be strictly equal:");
  assert.equal(metadata.errorCode, "ERR_ASSERTION");
  assert.equal(metadata.errorOperator, "strictEqual");
});

test("failure metadata refuses a code or operator that is not shaped like one", () => {
  const tagged = Object.assign(new Error("rejected"), {
    code: "PRIVATE NOTE BODY",
    operator: "PRIVATE NOTE BODY",
  });

  const metadata = failureMetadata("throws a tagged error", tagged, FIXTURE_ROOT);

  assert.equal(Object.keys(metadata).includes("errorCode"), false);
  assert.equal(Object.keys(metadata).includes("errorOperator"), false);
});

test("failure metadata reads the code and operator without rethrowing", () => {
  const hostile = new Error("boom");
  for (const property of ["code", "operator"]) {
    Object.defineProperty(hostile, property, {
      get() {
        throw new Error(`no ${property} for you`);
      },
    });
  }

  const metadata = failureMetadata("throws a hostile error", hostile, FIXTURE_ROOT);

  assert.equal(metadata.redactedErrorMessage, "boom");
  assert.equal(Object.keys(metadata).includes("errorCode"), false);
});

test("failure metadata redacts before capping, so truncation cannot strand a partial root", () => {
  // Capping first would slice through the root, leaving `/tmp/neuralnote-n`
  // behind - a fragment the substitution can no longer match.
  const message = `${"x".repeat(280)}${FIXTURE_ROOT}/vaults/Note.md`;

  const metadata = failureMetadata("floods then leaks", new Error(message), FIXTURE_ROOT);

  assert.match(metadata.redactedErrorMessage, /<E2E_ROOT>/);
  assert.equal(metadata.redactedErrorMessage.includes("/tmp/"), false);
});

test("failure metadata keeps a message at the cap untouched", () => {
  const atCap = "x".repeat(300);

  const metadata = failureMetadata("fits the message", new Error(atCap), FIXTURE_ROOT);

  assert.equal(metadata.redactedErrorMessage, atCap);
});

test("failure metadata truncates one character past the cap to exactly the cap", () => {
  const metadata = failureMetadata("floods the message", new Error("x".repeat(301)), FIXTURE_ROOT);

  assert.equal(metadata.redactedErrorMessage, `${"x".repeat(297)}...`);
  assert.equal(metadata.redactedErrorMessage.length, 300);
});

test("redacts both the realpathed root and its unresolved macOS form", () => {
  // `createNativeE2eRoot` realpaths the temp parent, so the harness root is
  // `/private/var/...` while the OS and anything reading `os.tmpdir()` still
  // emit the `/var/...` symlink form.
  const resolvedRoot = "/private/var/folders/ab/T/neuralnote-native-e2e-7f3a";
  const source = [
    `opened ${resolvedRoot}/vaults/Private/Note.md`,
    "watch failed at /var/folders/ab/T/neuralnote-native-e2e-7f3a/vaults/Private/Note.md",
  ].join("\n");

  const redacted = redactArtifactText(source, resolvedRoot);

  assert.equal(
    redacted,
    "opened <E2E_ROOT>/vaults/Private/Note.md\nwatch failed at <E2E_ROOT>/vaults/Private/Note.md",
  );
});

test("redacts a JSON-quoted credential value", () => {
  const redacted = redactArtifactText(
    'native invoke set_provider failed: {"token":"ghp-SECRET-VALUE"}',
    FIXTURE_ROOT,
  );

  assert.equal(redacted.includes("ghp-SECRET-VALUE"), false);
  assert.match(redacted, /<REDACTED>/);
});

test("redacts a bearer authorization header value", () => {
  const redacted = redactArtifactText(
    "request rejected: Authorization: Bearer sk-live-SECRET",
    FIXTURE_ROOT,
  );

  assert.equal(redacted.includes("sk-live-SECRET"), false);
  assert.match(redacted, /<REDACTED>/);
});

// The adversarial corpus DoD §2 requires for hand-rolled detection. Every case
// below leaked before the value class stopped excluding quote characters: the
// scan halted at the quote and emitted `<REDACTED>` FOLLOWED BY the secret,
// which is worse than no redaction because it reads as done.
//
// Asserted one string per case rather than in a loop so a regression names the
// shape that broke rather than an index.
for (const [shape, line] of [
  ["single-quoted", "native invoke failed: token='sk-live-SECRET'"],
  ["single-quoted api_key", "config rejected: api_key='sk-live-SECRET'"],
  ["single-quoted with colon", "auth: password: 'sk-live-SECRET'"],
  ["apostrophe inside the value", "token=sk-live'SECRET"],
  ["JSON single-quoted", "state: {'token': 'sk-live-SECRET'}"],
  ["JSON without a trailing comma", 'state: {"secret":"sk-live-SECRET"}'],
  ["bearer, single-quoted", "header: Authorization: Bearer 'sk-live-SECRET'"],
] as const) {
  test(`redacts a credential value: ${shape}`, () => {
    const redacted = redactArtifactText(line, FIXTURE_ROOT);

    assert.equal(
      redacted.includes("sk-live-SECRET"),
      false,
      `${shape}: the secret survived redaction as ${JSON.stringify(redacted)}`,
    );
    assert.match(redacted, /<REDACTED>/);
  });
}

test("redacting a credential does not consume the next field", () => {
  // The value class over-consumes on purpose, but it must still stop at a
  // separator: a redactor that ate the rest of the line would destroy the
  // diagnosis the artifact exists to carry.
  const redacted = redactArtifactText(
    "native invoke failed: token='sk-live-SECRET', spec=30-markdown-source.spec.ts",
    FIXTURE_ROOT,
  );

  assert.equal(redacted.includes("sk-live-SECRET"), false);
  assert.match(redacted, /30-markdown-source\.spec\.ts/);
});
