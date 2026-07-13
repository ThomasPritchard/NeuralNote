import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertTauriBuildSucceeded, getTauriBuildInvocation } from "./wdio-build.js";
import { config } from "./wdio.conf.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("uses the workspace Cargo target for the native application", () => {
  const capability = config.capabilities?.[0] as WebdriverIO.Capabilities & {
    "tauri:options": { application: string };
  };

  assert.equal(
    "browserName" in capability,
    false,
    "tauri-driver rejects browserName because it is not part of its advertised capabilities",
  );
  assert.equal(
    capability["tauri:options"].application,
    path.resolve(here, "..", "..", "..", "target", "debug", `desktop${process.platform === "win32" ? ".exe" : ""}`),
  );
});

test("fails preparation when the Tauri build command fails", () => {
  assert.throws(
    () => assertTauriBuildSucceeded({ status: 23, signal: null }),
    /Tauri build failed with exit code 23/,
  );
});

test("uses Node and fixed Tauri CLI arguments instead of a Windows cmd shim", () => {
  assert.deepEqual(getTauriBuildInvocation(here), {
    command: process.execPath,
    args: [
      path.resolve(here, "..", "node_modules", "@tauri-apps", "cli", "tauri.js"),
      "build",
      "--debug",
      "--no-bundle",
      "--config",
      path.join(here, "tauri.e2e.conf.json"),
    ],
  });
});

test("provides an E2E Tauri overlay that removes unrelated sidecars", () => {
  const overlayPath = path.join(here, "tauri.e2e.conf.json");

  assert.equal(existsSync(overlayPath), true, "the E2E Tauri overlay is missing");
  assert.deepEqual(JSON.parse(readFileSync(overlayPath, "utf8")), {
    bundle: {
      externalBin: [],
      resources: [],
    },
  });
});
