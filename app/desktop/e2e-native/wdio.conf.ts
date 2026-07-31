import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureFailureArtifacts } from "./native-artifacts.js";
import { assertNativeFrontendReady } from "./tauri-bootstrap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const application = path.resolve(
  here,
  "..",
  "..",
  "..",
  "target",
  "debug",
  `desktop${isWindows ? ".exe" : ""}`,
);

const serviceOptions = {
  appBinaryPath: application,
  driverProvider: "embedded" as const,
  embeddedPort: 4445,
  startTimeout: 60_000,
  statusPollTimeout: 5_000,
  // Note bodies and credentials must not enter uploaded logs. The harness writes
  // its own redacted failure metadata instead of forwarding application output.
  captureBackendLogs: false,
  captureFrontendLogs: false,
};

export function nativeSpecsForPhase(
  phase = process.env.NEURALNOTE_E2E_RESTART_PHASE,
): string[][] {
  if (phase === "seed") return [["./specs/60-workspace-restart-seed.spec.ts"]];
  if (phase === "assert") return [["./specs/61-workspace-restart-assert.spec.ts"]];
  if (phase) throw new Error(`unknown NEURALNOTE_E2E_RESTART_PHASE '${phase}'`);
  return [[
    "./specs/00-startup.spec.ts",
    "./specs/10-authority-lifecycle.spec.ts",
    "./specs/20-vault-disk.spec.ts",
    "./specs/30-markdown-source.spec.ts",
    "./specs/35-external-reconciliation.spec.ts",
    "./specs/40-window.spec.ts",
    "./specs/50-workspace-ui.spec.ts",
  ]];
}

export const config: WebdriverIO.Config = {
  // Embedded mode owns one native app process. Grouping keeps every native spec
  // in one worker/session instead of deleting the only WKWebView session between
  // files while still executing the journeys serially in this fixed order.
  specs: nativeSpecsForPhase(),
  maxInstances: 1,
  specFileRetries: 0,
  connectionRetryCount: 0,
  capabilities: [
    {
      browserName: "tauri",
      maxInstances: 1,
      "tauri:options": { application },
    } as WebdriverIO.Capabilities,
  ],
  services: [["@wdio/tauri-service", serviceOptions]],
  reporters: ["spec"],
  framework: "mocha",
  // WebDriver command payloads can include page text. Keep stdout at failures
  // only; the harness writes its own bounded, redacted artifacts.
  logLevel: "error",
  waitforTimeout: 10_000,
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
  before: async () => {
    // Fail with the exact bootstrap fault before invoking the plugin-backed
    // browser.tauri surface. This is a one-shot assertion, not a timing sleep.
    await assertNativeFrontendReady(browser);
    // Select the only E2E window through raw WebDriver. The plugin-backed
    // switch helper first asks for broader list-windows authority we do not
    // need to grant to this harness.
    await browser.switchToWindow("main");
  },
  beforeTest: () => {
    const root = process.env.NEURALNOTE_E2E_ROOT;
    if (!root) throw new Error("NEURALNOTE_E2E_ROOT is required");
    const readiness = path.join(root, "artifacts", "first-test-started");
    if (!existsSync(readiness)) writeFileSync(readiness, "ready\n", { flag: "wx" });
  },
  afterTest: async (test, _context, result) => {
    if (result.passed) return;
    await captureFailureArtifacts(test.title, result.error);
  },
};
