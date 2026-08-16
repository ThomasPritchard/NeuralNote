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

// A package manifest imported for one field and left whole by the bundler ships
// every dependency and its exact version range to users. The build is minified,
// so the leak reads `,devDependencies:{"@tauri-apps/cli":`^2`,...}` - the key
// unquoted, its value an object literal. Matching the pretty-printed
// `"devDependencies":` instead would never fire on a real bundle.
//
// The preceding `{` or `,` is what separates a manifest from an app string that
// merely names one of these sections, which release notes legitimately do.
const MINIFIED_MANIFEST_SECTION =
  /[{,](dependencies|devDependencies|optionalDependencies|peerDependencies|scripts):\{/g;
// One section alone is not proof: an app could own an object called `scripts`.
// A manifest always arrives with several, so requiring two keeps the rule
// specific without letting a real leak through.
const EMBEDDED_MANIFEST_SECTION_THRESHOLD = 2;

async function* bundleAssets(bundleRoot) {
  const rootStat = await lstat(bundleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("production bundle root must be a real directory");
  }

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
      yield {
        assetPath: path.relative(bundleRoot, pathname),
        source: await readFile(pathname, "utf8"),
      };
    }
  }
}

async function findNativeAutomationMarkers(bundleRoot) {
  const found = new Map();
  for await (const { assetPath, source } of bundleAssets(bundleRoot)) {
    for (const marker of AUTOMATION_MARKERS) {
      if (source.includes(marker) && !found.has(marker)) {
        found.set(marker, assetPath);
      }
    }
  }
  return found;
}

function minifiedManifestSections(source) {
  const sections = new Set();
  for (const [, section] of source.matchAll(MINIFIED_MANIFEST_SECTION)) {
    sections.add(section);
  }
  return [...sections].sort();
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

export async function assertNoEmbeddedPackageManifest(bundleRoot) {
  for await (const { assetPath, source } of bundleAssets(bundleRoot)) {
    const sections = minifiedManifestSections(source);
    if (sections.length >= EMBEDDED_MANIFEST_SECTION_THRESHOLD) {
      throw new Error(
        `production bundle embeds package manifest sections (${sections.join(", ")}) in ${assetPath}`,
      );
    }
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
  const expectation = bundleExpectation(process.argv.slice(3));

  // Both bundles are built from the same sources, so a manifest that leaks into
  // one leaks into the other. Checking both means whichever build a developer
  // runs is the one that catches it.
  await assertNoEmbeddedPackageManifest(bundleRoot);
  console.log("Bundle embeds no package manifest.");

  if (expectation === "native-e2e") {
    await assertNativeAutomationIncluded(bundleRoot);
    console.log("Native E2E bundle includes the WebdriverIO frontend bootstrap.");
  } else {
    await assertNoNativeAutomation(bundleRoot);
    console.log("Production bundle excludes native automation.");
  }
}
