import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const NATIVE_E2E_MARKER = ".neuralnote-native-e2e-root-v1.json";
const ROOT_PREFIX = "neuralnote-native-e2e-";

export interface NativeE2eLayout {
  root: string;
  marker: string;
  config: string;
  vaults: string;
  artifacts: string;
  readiness: string;
  sessionId: string;
}

interface CleanupOptions {
  appExited: boolean;
}

export function createNativeE2eRoot(parent = os.tmpdir()): NativeE2eLayout {
  const resolvedParent = realpathSync(parent);
  const root = mkdtempSync(path.join(resolvedParent, ROOT_PREFIX));
  const sessionId = randomUUID();
  const marker = path.join(root, NATIVE_E2E_MARKER);
  const config = path.join(root, "config");
  const vaults = path.join(root, "vaults");
  const artifacts = path.join(root, "artifacts");

  chmodSync(root, 0o700);
  writeFileSync(
    marker,
    `${JSON.stringify({ schemaVersion: 1, sessionId })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  for (const directory of [config, vaults, artifacts]) {
    mkdirSync(directory, { mode: 0o700 });
  }

  return {
    root,
    marker,
    config,
    vaults,
    artifacts,
    readiness: path.join(artifacts, "first-test-started"),
    sessionId,
  };
}

export function nativeE2eEnvironment(
  layout: NativeE2eLayout,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...inherited, NEURALNOTE_E2E_ROOT: layout.root };
}

export function cleanupNativeE2eRoot(
  layout: NativeE2eLayout,
  options: CleanupOptions,
): void {
  if (!options.appExited) {
    throw new Error("refusing native E2E cleanup: application exit has not been observed");
  }
  assertOwnedLayout(layout);
  rmSync(layout.root, { recursive: true, force: false });
}

function assertOwnedLayout(layout: NativeE2eLayout): void {
  const rootStat = lstatSync(layout.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("refusing native E2E cleanup: root is not a real directory");
  }
  if (!path.basename(layout.root).startsWith(ROOT_PREFIX)) {
    throw new Error("refusing native E2E cleanup: root name is not owned by the harness");
  }
  if (realpathSync(layout.root) !== path.resolve(layout.root)) {
    throw new Error("refusing native E2E cleanup: root path does not resolve to itself");
  }
  if (path.dirname(realpathSync(layout.root)) !== realpathSync(os.tmpdir())) {
    throw new Error(
      "refusing native E2E cleanup: root is not a direct child of the process temp directory",
    );
  }

  const markerStat = lstatSync(layout.marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error("refusing native E2E cleanup: ownership marker is not a regular file");
  }

  let marker: { schemaVersion?: unknown; sessionId?: unknown };
  try {
    marker = JSON.parse(readFileSync(layout.marker, "utf8")) as typeof marker;
  } catch (error) {
    throw new Error("refusing native E2E cleanup: ownership marker is invalid", {
      cause: error,
    });
  }
  if (marker.schemaVersion !== 1 || marker.sessionId !== layout.sessionId) {
    throw new Error("refusing native E2E cleanup: ownership marker does not match");
  }
}
