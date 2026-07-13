// @ts-nocheck — CI-only scaffold. Its deps (webdriverio, @types/node, mocha) are
// installed by `npm install` inside this folder in CI, not in the parent app, so
// type-checking is suppressed here to keep the main editor clean. wdio runs it
// transpile-only anyway. See README.md.
// Native WebDriver config: drives the REAL NeuralNote window via tauri-driver
// (which proxies to the platform WebView driver — WebKitWebDriver on Linux,
// Edge WebView2 driver on Windows). This is the genuine native end-to-end tier
// that the jsdom + mockIPC suite (src/e2e/) cannot be: it runs the actual Rust
// backend behind the actual webview.
//
// IMPORTANT: tauri-driver supports Linux and Windows only — there is NO macOS
// WebView2/WKWebView WebDriver. This config therefore runs in CI (see
// .github/workflows/e2e.yml), never on a Mac. See README.md.
//
// Mirrors the official Tauri WebdriverIO example:
// https://v2.tauri.app/develop/tests/webdriver/example/webdriverio

import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertTauriBuildSucceeded, getTauriBuildInvocation } from "./wdio-build.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";

// The compiled debug binary. `mainBinaryName` is unset in tauri.conf.json, so the
// CLI keeps the Cargo crate name (`desktop`) — NOT the productName ("NeuralNote").
// If a `mainBinaryName` is ever added to the Tauri config, update this to match.
const BINARY_NAME = "desktop";
const application = path.resolve(
  here,
  "..",
  "..",
  "..",
  "target",
  "debug",
  `${BINARY_NAME}${exe}`,
);

const tauriDriverBin = path.resolve(
  os.homedir(),
  ".cargo",
  "bin",
  `tauri-driver${exe}`,
);

// Track the tauri-driver child so we can tear it down deterministically.
let tauriDriver: ChildProcess | undefined;
let exiting = false;

export const config: WebdriverIO.Config = {
  host: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      // `wry` is the Tauri webview engine name tauri-driver expects.
      browserName: "wry",
      "tauri:options": { application },
    } as WebdriverIO.Capabilities,
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },

  // Build the debug binary the WebDriver sessions expect to exist. Runs from the
  // desktop app root; `--no-bundle` skips installer packaging (we only need the
  // raw binary), `--debug` keeps it fast and unsigned. The E2E config removes
  // local-AI sidecars and resources that this smoke test does not exercise.
  onPrepare: () => {
    const invocation = getTauriBuildInvocation(here);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: path.resolve(here, ".."),
      stdio: "inherit",
      shell: false,
    });

    assertTauriBuildSucceeded(result);
  },

  // Start tauri-driver before each session so it can proxy WebDriver requests.
  beforeSession: () => {
    tauriDriver = spawn(tauriDriverBin, [], {
      stdio: [null, process.stdout, process.stderr],
    });
    tauriDriver.on("error", (error) => {
      console.error("tauri-driver error:", error);
      process.exit(1);
    });
    tauriDriver.on("exit", (code) => {
      if (!exiting) {
        console.error("tauri-driver exited unexpectedly with code:", code);
        process.exit(1);
      }
    });
  },

  // afterSession may not run if the session never started, so we also clean up on
  // process shutdown (registered below).
  afterSession: () => {
    closeTauriDriver();
  },
};

function closeTauriDriver(): void {
  exiting = true;
  tauriDriver?.kill();
}

for (const signal of ["exit", "SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(signal, () => {
    closeTauriDriver();
  });
}
