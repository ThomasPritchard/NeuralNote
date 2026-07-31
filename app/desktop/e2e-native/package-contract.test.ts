import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  devDependencies: Record<string, string>;
  overrides: Record<string, string>;
};

test("pins the Tauri integration and its compatible native utility runtime", () => {
  assert.equal(manifest.devDependencies["@wdio/tauri-plugin"], "1.2.0");
  assert.equal(manifest.devDependencies["@wdio/tauri-service"], "1.2.0");
  assert.equal(manifest.overrides["@wdio/native-utils"], "2.5.0");
  assert.equal(manifest.overrides.diff, "8.0.3");
});

test("builds once and runs the main, restart-seed, and restart-assert sessions serially", () => {
  const runner = readFileSync(new URL("./run-native.ts", import.meta.url), "utf8");

  assert.match(runner, /for \(const phase of \["main", "seed", "assert"\] as const\)/u);
  assert.equal((runner.match(/getTauriBuildInvocation\(/gu) ?? []).length, 1);
  assert.match(runner, /NEURALNOTE_E2E_RESTART_PHASE: phase === "main" \? "" : phase/u);
  assert.match(runner, /runnerSignals\.push\(result\.signal\)/u);
  assert.match(
    runner,
    /if \(shouldCleanupAfterNativeRunner\(runnerSignals\)\) \{\s*cleanupNativeE2eRoot/u,
  );
});

test("wires stateful native UI journeys through fixture reset", () => {
  const nativeHelpers = readFileSync(
    new URL("./specs/native-helpers.ts", import.meta.url),
    "utf8",
  );
  const markdownSuite = readFileSync(
    new URL("./specs/30-markdown-source.spec.ts", import.meta.url),
    "utf8",
  );
  const reconciliationSuite = readFileSync(
    new URL("./specs/35-external-reconciliation.spec.ts", import.meta.url),
    "utf8",
  );
  const workspaceSuite = readFileSync(
    new URL("./specs/50-workspace-ui.spec.ts", import.meta.url),
    "utf8",
  );

  assert.match(nativeHelpers, /export async function dismissNativeNotifications/u);
  assert.match(nativeHelpers, /export async function closeOpenNotesDiscardingDrafts/u);
  assert.match(nativeHelpers, /export async function resetFixtureWorkspace/u);
  assert.match(markdownSuite, /await resetFixtureWorkspace\(\);\s*writeFileSync/u);
  assert.match(
    reconciliationSuite,
    /await resetFixtureWorkspace\(\);\s*const source = restoreStartSource\(\)/u,
  );
  assert.match(workspaceSuite, /await resetFixtureWorkspace\(\);/u);
});

test("the macOS save probe dispatches one fixed AppKit Command-S event", () => {
  const nativeE2e = readFileSync(
    new URL("../src-tauri/src/native_e2e.rs", import.meta.url),
    "utf8",
  );
  const shell = readFileSync(
    new URL("../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  const cargo = readFileSync(
    new URL("../src-tauri/Cargo.toml", import.meta.url),
    "utf8",
  );
  const frontendBridge = readFileSync(
    new URL("../src/nativeE2eBridge.ts", import.meta.url),
    "utf8",
  );
  const nativeHelpers = readFileSync(
    new URL("./specs/native-helpers.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    nativeE2e,
    /async fn native_e2e_post_save_accelerator\(\s*app: tauri::AppHandle,?\s*\) -> Result<\(\), String>/u,
  );
  assert.match(nativeE2e, /app\.run_on_main_thread/u);
  assert.match(nativeE2e, /tokio::sync::oneshot::channel/u);
  assert.match(nativeE2e, /NSApplication::sharedApplication/u);
  assert.match(nativeE2e, /NSEventType::KeyDown/u);
  assert.match(nativeE2e, /NSEventModifierFlags::Command/u);
  assert.match(nativeE2e, /NSString::from_str\("s"\)/u);
  assert.match(nativeE2e, /keyWindow/u);
  assert.match(nativeE2e, /windowNumber/u);
  assert.match(nativeE2e, /sendEvent/u);
  assert.doesNotMatch(nativeE2e, /postEvent_atStart/u);
  assert.doesNotMatch(nativeE2e, /MENU_ACTION|menu:\/\/action|\.emit\(|write_note|saveVia/u);
  assert.doesNotMatch(frontendBridge, /saveViaNativeMenuAction|action: "save"/u);
  assert.doesNotMatch(nativeHelpers, /saveViaNativeMenuAction/u);
  assert.doesNotMatch(nativeHelpers, /browser\.keys|Key\.Ctrl/u);
  assert.match(
    shell,
    /#\[cfg\(all\(feature = "native-e2e", target_os = "macos"\)\)\][\s\S]*native_e2e::native_e2e_post_save_accelerator/u,
  );
  assert.match(cargo, /native-e2e = \[[^\]]*"dep:objc2-app-kit"[^\]]*\]/u);
});
