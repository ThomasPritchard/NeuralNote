#!/usr/bin/env node
import { lstat, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const AUTOMATION_MARKERS = [
  "wdioTauri",
  "__wdio_spy__",
  "WDIO Tauri Plugin",
  "plugin:wdio|execute",
  "NEURALNOTE_NATIVE_E2E_BRIDGE_V1",
];
const SCANNED_EXTENSIONS = new Set([".cjs", ".html", ".js", ".mjs"]);
const MAX_SCANNED_FILE_BYTES = 64 * 1024 * 1024;

async function findNativeAutomationMarkers(bundleRoot) {
  const rootStat = await lstat(bundleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("production bundle root must be a real directory");
  }

  const found = new Map();
  const pending = [bundleRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const pathname = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`production bundle contains a symlink: ${path.relative(bundleRoot, pathname)}`);
      }
      if (entry.isDirectory()) {
        pending.push(pathname);
        continue;
      }
      if (!entry.isFile() || !SCANNED_EXTENSIONS.has(path.extname(entry.name))) continue;

      const fileStat = await lstat(pathname);
      if (fileStat.size > MAX_SCANNED_FILE_BYTES) {
        throw new Error(`production bundle chunk is too large to inspect: ${path.relative(bundleRoot, pathname)}`);
      }
      const source = await readFile(pathname, "utf8");
      for (const marker of AUTOMATION_MARKERS) {
        if (source.includes(marker) && !found.has(marker)) {
          found.set(marker, path.relative(bundleRoot, pathname));
        }
      }
    }
  }
  return found;
}

export async function assertNoNativeAutomation(bundleRoot) {
  const found = await findNativeAutomationMarkers(bundleRoot);
  const first = found.entries().next().value;
  if (first) {
    const [marker, pathname] = first;
    throw new Error(
      `production bundle contains native automation marker "${marker}" in ${pathname}`,
    );
  }
}

export async function assertNativeAutomationIncluded(bundleRoot) {
  const found = await findNativeAutomationMarkers(bundleRoot);
  if (!found.has("wdioTauri")) {
    throw new Error("native E2E bundle does not contain the WebdriverIO frontend bootstrap");
  }
  if (!found.has("NEURALNOTE_NATIVE_E2E_BRIDGE_V1")) {
    throw new Error("native E2E bundle does not contain the editor bridge");
  }
}

export function bundleExpectation(args) {
  if (args.length === 0) return "production";
  if (args.length === 1 && args[0] === "--expect-native-automation") {
    return "native-e2e";
  }
  throw new Error(`unknown bundle assertion mode: ${args.join(" ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundleRoot = path.resolve(process.argv[2] ?? "dist");
  if (bundleExpectation(process.argv.slice(3)) === "native-e2e") {
    await assertNativeAutomationIncluded(bundleRoot);
    console.log("Native E2E bundle includes the WebdriverIO frontend bootstrap.");
  } else {
    await assertNoNativeAutomation(bundleRoot);
    console.log("Production bundle excludes native automation.");
  }
}
