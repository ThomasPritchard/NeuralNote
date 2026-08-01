import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNativeAutomationIncluded,
  assertNoNativeAutomation,
  bundleExpectation,
} from "./assert-production-bundle.mjs";

test("production checking is the default regardless of the frontend build environment", () => {
  assert.equal(bundleExpectation([]), "production");
  assert.equal(bundleExpectation(["--expect-native-automation"]), "native-e2e");
  assert.throws(
    () => bundleExpectation(["--unexpected-mode"]),
    /unknown bundle assertion mode/,
  );
});

test("accepts a production bundle without native automation markers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-production-bundle-safe-"));
  try {
    await writeFile(path.join(root, "index.js"), "console.log('NeuralNote');\n", "utf8");
    await assert.doesNotReject(assertNoNativeAutomation(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects native automation code in any emitted JavaScript chunk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-production-bundle-wdio-"));
  try {
    const assets = path.join(root, "assets");
    await mkdir(assets);
    await writeFile(
      path.join(assets, "automation.js"),
      "window.wdioTauri = { execute() {} };\n",
      "utf8",
    );
    await assert.rejects(
      assertNoNativeAutomation(root),
      /production bundle contains native automation marker "wdioTauri"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires the pinned frontend bootstrap in a native E2E bundle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-native-e2e-bundle-"));
  try {
    await writeFile(path.join(root, "index.js"), "console.log('NeuralNote');\n", "utf8");
    await assert.rejects(
      assertNativeAutomationIncluded(root),
      /native E2E bundle does not contain the WebdriverIO frontend bootstrap/,
    );
    await writeFile(path.join(root, "wdio.js"), "window.wdioTauri = {};\n", "utf8");
    await assert.rejects(
      assertNativeAutomationIncluded(root),
      /native E2E bundle does not contain the editor bridge/,
    );
    await writeFile(
      path.join(root, "editor-bridge.js"),
      "window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1 = {};\n",
      "utf8",
    );
    await assert.doesNotReject(assertNativeAutomationIncluded(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects the native editor bridge in a production bundle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-production-bundle-editor-bridge-"));
  try {
    await writeFile(
      path.join(root, "editor-bridge.js"),
      "window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1 = {};\n",
      "utf8",
    );
    await assert.rejects(
      assertNoNativeAutomation(root),
      /production bundle contains native automation marker "NEURALNOTE_NATIVE_E2E_BRIDGE_V1"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
