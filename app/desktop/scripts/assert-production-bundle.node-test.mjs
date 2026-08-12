import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNativeAutomationIncluded,
  assertNoEmbeddedPackageManifest,
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

// A default `import packageJson from "../../package.json"` used for one field is
// tree-shaken by Rollup and NOT by Rolldown, so moving to Vite 8 silently shipped
// every dependency and its exact version range. The bundle is minified, so the
// leak reads `devDependencies:{"@tauri-apps/cli":`^2`,...}` - unquoted key, backtick
// values. A check written against the pretty-printed `"devDependencies":` would
// never have fired.
test("rejects a package manifest embedded in an emitted chunk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-production-bundle-manifest-"));
  try {
    const assets = path.join(root, "assets");
    await mkdir(assets);
    await writeFile(
      path.join(assets, "index-7GTV7Wtb.js"),
      "const e={name:`neuralnote`,private:!0,scripts:{dev:`vite`}," +
        "devDependencies:{vite:`^8.2.0`,typescript:`7.0.2`}};\n",
      "utf8",
    );
    await assert.rejects(
      assertNoEmbeddedPackageManifest(root),
      /production bundle embeds package manifest sections \(devDependencies, scripts\) in .*index-7GTV7Wtb\.js/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The words themselves are legitimate app content: a release note can describe this
// very fix. Only a real object literal is rejected, and only when two of the
// manifest's sections appear together, so no single string can trip the rule.
test("accepts app strings that merely name a manifest section", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-production-bundle-manifest-prose-"));
  try {
    await writeFile(
      path.join(root, "index.js"),
      "const n=[`The production bundle no longer embeds devDependencies from package.json.`," +
        "`Run scripts: build, then test.`,`dependencies:{ is what the leak looked like`];\n" +
        "const g={dependencies:{}},h={userScripts:{},subDependencies:{}};\n",
      "utf8",
    );
    await assert.doesNotReject(assertNoEmbeddedPackageManifest(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The section pattern is one module-level global regex shared by every asset and
// every call. A global regex remembers where it stopped, so an implementation that
// abandons a scan part-way - the obvious one stops as soon as it has enough
// sections to report - leaves that position behind and starts the NEXT scan in the
// middle of the file. The leak is then behind the read head and the build goes
// green over a leaking bundle, which is the exact failure this check exists to
// prevent. Scanning the same leaking bundle twice is what makes it visible.
test("reports an embedded manifest on every scan, not just the first", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-production-bundle-manifest-restate-"));
  try {
    await writeFile(
      path.join(root, "index.js"),
      "const e={scripts:{dev:`vite`},devDependencies:{vite:`^8.2.0`}};\n",
      "utf8",
    );
    for (const run of [1, 2]) {
      await assert.rejects(
        assertNoEmbeddedPackageManifest(root),
        /production bundle embeds package manifest sections \(devDependencies, scripts\)/,
        `scan ${run} missed the embedded manifest`,
      );
    }
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
