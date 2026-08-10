import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertTauriBuildSucceeded,
  getTauriBuildInvocation,
  nativeE2eBuildEnvironment,
} from "./wdio-build.js";
import { config, nativeSpecsForPhase } from "./wdio.conf.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..", "..", "..");

test("uses WebdriverIO's embedded Tauri provider against the workspace binary", () => {
  const capability = config.capabilities?.[0] as WebdriverIO.Capabilities & {
    browserName: string;
    "tauri:options": { application: string };
  };
  const service = config.services?.[0] as [
    string,
    { appBinaryPath: string; driverProvider: string },
  ];
  const application = path.resolve(
    repositoryRoot,
    "target",
    "debug",
    `desktop${process.platform === "win32" ? ".exe" : ""}`,
  );

  assert.equal(capability.browserName, "tauri");
  assert.equal(capability["tauri:options"].application, application);
  assert.equal(service[0], "@wdio/tauri-service");
  assert.deepEqual(service[1], {
    appBinaryPath: application,
    driverProvider: "embedded",
    embeddedPort: 4445,
    startTimeout: 60_000,
    statusPollTimeout: 5_000,
    captureBackendLogs: false,
    captureFrontendLogs: false,
  });
  assert.equal(config.maxInstances, 1);
  assert.equal(config.specFileRetries, 0);
  assert.equal(config.connectionRetryCount, 0);
  assert.equal(config.logLevel, "error");
  assert.equal(typeof config.before, "function");
  assert.equal(typeof config.afterHook, "function");
  assert.deepEqual(config.specs, [[
    "./specs/00-startup.spec.ts",
    "./specs/10-authority-lifecycle.spec.ts",
    "./specs/20-vault-disk.spec.ts",
    "./specs/30-markdown-source.spec.ts",
    "./specs/35-external-reconciliation.spec.ts",
    "./specs/40-window.spec.ts",
    "./specs/50-workspace-ui.spec.ts",
  ]]);
});

test("runs workspace restoration across two separate native app sessions", () => {
  assert.deepEqual(nativeSpecsForPhase("seed"), [[
    "./specs/60-workspace-restart-seed.spec.ts",
  ]]);
  assert.deepEqual(nativeSpecsForPhase("assert"), [[
    "./specs/61-workspace-restart-assert.spec.ts",
  ]]);
  assert.throws(() => nativeSpecsForPhase("unexpected"), /unknown NEURALNOTE_E2E_RESTART_PHASE/u);
});

test("fails preparation when the Tauri build command fails", () => {
  assert.throws(
    () => assertTauriBuildSucceeded({ status: 23, signal: null }),
    /Tauri build failed with exit code 23/,
  );
});

test("builds one debug-only native-e2e binary with fixed no-shell arguments", () => {
  assert.deepEqual(getTauriBuildInvocation(here), {
    command: process.execPath,
    args: [
      path.resolve(here, "..", "node_modules", "@tauri-apps", "cli", "tauri.js"),
      "build",
      "--debug",
      "--no-bundle",
      "--features",
      "native-e2e",
      "--config",
      path.join(here, "tauri.e2e.conf.json"),
    ],
  });
});

test("enables the WebdriverIO frontend bootstrap only for the native build child", () => {
  const inherited = { HOME: "/Users/example", EXISTING: "kept" };

  assert.deepEqual(nativeE2eBuildEnvironment(inherited), {
    ...inherited,
    VITE_NEURALNOTE_NATIVE_E2E: "1",
  });
  assert.equal(process.env.VITE_NEURALNOTE_NATIVE_E2E, undefined);
});

test("uses an isolated E2E identity and only test capabilities", () => {
  const overlayPath = path.join(here, "tauri.e2e.conf.json");

  assert.equal(existsSync(overlayPath), true, "the E2E Tauri overlay is missing");
  assert.deepEqual(JSON.parse(readFileSync(overlayPath, "utf8")), {
    productName: "NeuralNote E2E",
    identifier: "com.neuralnote.desktop.e2e",
    build: {
      beforeBuildCommand: "npm run build:native-e2e",
    },
    app: {
      withGlobalTauri: true,
      security: {
        capabilities: [
          "default",
          {
            identifier: "native-e2e",
            description: "Test-only WebdriverIO capabilities for the native E2E build.",
            windows: ["main"],
            permissions: [
              "wdio:allow-execute",
              "wdio-webdriver:default",
              "core:window:allow-set-fullscreen",
            ],
          },
        ],
      },
    },
    bundle: {
      createUpdaterArtifacts: false,
      externalBin: [],
      resources: [],
    },
  });
});

test("production config and Cargo defaults exclude native automation", () => {
  const productionConfig = JSON.parse(
    readFileSync(path.join(here, "..", "src-tauri", "tauri.conf.json"), "utf8"),
  ) as { app: { security: { capabilities: string[] }; withGlobalTauri?: boolean } };
  const cargo = readFileSync(path.join(here, "..", "src-tauri", "Cargo.toml"), "utf8");
  const shell = readFileSync(path.join(here, "..", "src-tauri", "src", "lib.rs"), "utf8");
  const buildScript = readFileSync(path.join(here, "..", "src-tauri", "build.rs"), "utf8");

  assert.deepEqual(productionConfig.app.security.capabilities, ["default"]);
  assert.notEqual(productionConfig.app.withGlobalTauri, true);
  assert.match(cargo, /native-e2e = \[[\s\S]*"dep:objc2-app-kit"[\s\S]*"dep:tauri-plugin-wdio"[\s\S]*"dep:tauri-plugin-wdio-webdriver"[\s\S]*\]/);
  // The npm guest JS and the Rust plugin talk a private wire protocol, so a version
  // skew between them is a real breakage risk. Upstream releases all four together
  // but does not guarantee it, so assert the parity here rather than a literal
  // version — that keeps the invariant enforced across bumps instead of turning
  // every upgrade into a find-and-replace that could silently be half-applied.
  const e2eManifest = JSON.parse(
    readFileSync(path.join(here, "package.json"), "utf8"),
  ) as { devDependencies: Record<string, string> };
  const wdioVersion = e2eManifest.devDependencies["@wdio/tauri-plugin"];
  assert.match(wdioVersion, /^\d+\.\d+\.\d+$/, "the npm plugin must be pinned exactly");
  assert.equal(e2eManifest.devDependencies["@wdio/tauri-service"], wdioVersion);
  for (const crate of ["tauri-plugin-wdio", "tauri-plugin-wdio-webdriver"]) {
    assert.match(
      cargo,
      new RegExp(
        `${crate} = \\{ version = "=${wdioVersion.replace(/\./gu, "\\.")}", optional = true \\}`,
        "u",
      ),
      `${crate} must be exact-pinned to the same version as the npm packages (${wdioVersion})`,
    );
  }
  assert.match(buildScript, /env::var\("PROFILE"\)[\s\S]*== "release"/);
  assert.match(buildScript, /rustc-cfg=native_e2e_release_profile/);
  assert.match(buildScript, /rustc-check-cfg=cfg\(native_e2e_release_profile\)/);
  assert.match(shell, /cfg\(all\(feature = "native-e2e", native_e2e_release_profile\)\)/);
  assert.match(shell, /compile_error!\("native-e2e cannot be enabled in a release profile"\)/);
  assert.match(shell, /cfg\(feature = "native-e2e"\)[\s\S]*tauri_plugin_wdio::init\(\)/);
  assert.match(shell, /cfg\(feature = "native-e2e"\)[\s\S]*tauri_plugin_wdio_webdriver::init\(\)/);
});

test("the native capability grants automation only to the main E2E window", () => {
  const overlay = JSON.parse(
    readFileSync(path.join(here, "tauri.e2e.conf.json"), "utf8"),
  ) as { app: { security: { capabilities: Array<string | Record<string, unknown>> } } };
  const capability = overlay.app.security.capabilities[1];

  assert.deepEqual(capability, {
    identifier: "native-e2e",
    description: "Test-only WebdriverIO capabilities for the native E2E build.",
    windows: ["main"],
    permissions: [
      "wdio:allow-execute",
      "wdio-webdriver:default",
      "core:window:allow-set-fullscreen",
    ],
  });
});
