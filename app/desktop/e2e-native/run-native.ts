import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  sanitizeNativeRunLog,
} from "./native-artifacts.js";
import { seedNativeFixtures } from "./native-fixtures.js";
import {
  cleanupNativeE2eRoot,
  createNativeE2eRoot,
  nativeE2eEnvironment,
} from "./native-root.js";
import {
  classifyNativeFailure,
  shouldCleanupAfterNativeRunner,
  shouldRetryNativeRun,
} from "./runner-policy.js";
import {
  assertCargoTreeSucceeded,
  assertProductionDependencyTree,
} from "./production-dependencies.js";
import {
  assertTauriBuildSucceeded,
  getTauriBuildInvocation,
  nativeE2eBuildEnvironment,
} from "./wdio-build.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactOutput = path.join(here, "artifacts");

rmSync(artifactOutput, { recursive: true, force: true });

const repositoryRoot = path.resolve(here, "..", "..", "..");
const productionTree = spawnSync(
  "cargo",
  ["tree", "-p", "desktop", "--edges", "normal", "--locked"],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
  },
);
assertProductionDependencyTree(assertCargoTreeSucceeded(productionTree));

const build = getTauriBuildInvocation(here);
const buildResult = spawnSync(build.command, build.args, {
  cwd: path.resolve(here, ".."),
  // Only the build child receives this flag. The ordinary app build and the
  // subsequent driver process cannot accidentally acquire test bootstrap code.
  env: nativeE2eBuildEnvironment(process.env),
  stdio: "inherit",
  shell: false,
});
assertTauriBuildSucceeded(buildResult);

const wdio = path.join(here, "node_modules", "@wdio", "cli", "bin", "wdio.js");
let finalExitCode = 1;

function resetWorkspaceStateForRestart(vaultsRoot: string): void {
  const stateDirectory = path.join(vaultsRoot, "Native Fixture", ".neuralnote");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDirectory, "workspace-state.json"),
    `${JSON.stringify({ openPaths: [], activePath: null })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

for (let attempt = 0; attempt < 2; attempt += 1) {
  const layout = createNativeE2eRoot();
  seedNativeFixtures(layout);
  const outputs: string[] = [];
  let exitCode = 0;
  let runnerSpawnFailed = false;
  const runnerSignals: Array<NodeJS.Signals | null> = [];
  for (const phase of ["main", "seed", "assert"] as const) {
    if (phase === "seed") resetWorkspaceStateForRestart(layout.vaults);
    const result = spawnSync(process.execPath, [wdio, "run", "./wdio.conf.ts"], {
      cwd: here,
      env: {
        ...nativeE2eEnvironment(layout),
        NEURALNOTE_E2E_RESTART_PHASE: phase === "main" ? "" : phase,
      },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
    runnerSignals.push(result.signal);
    const phaseExitCode = result.status ?? 1;
    const runnerFailure = result.error
      ? `\nNative runner process failed during ${phase}: ${result.error.message}\n`
      : "";
    outputs.push(`${result.stdout ?? ""}${result.stderr ?? ""}${runnerFailure}`);
    runnerSpawnFailed ||= result.error !== undefined;
    if (phaseExitCode !== 0) {
      exitCode = phaseExitCode;
      break;
    }
  }
  finalExitCode = exitCode;
  const combinedOutput = outputs.join("\n");
  const sanitizedOutput = sanitizeNativeRunLog(combinedOutput, layout.root);
  process.stdout.write(sanitizedOutput);
  writeFileSync(
    path.join(layout.artifacts, `native-run-attempt-${attempt + 1}.log`),
    sanitizedOutput,
    { encoding: "utf8", mode: 0o600 },
  );

  const readinessObserved = existsSync(layout.readiness);
  const failureKind = classifyNativeFailure(combinedOutput, runnerSpawnFailed);
  const retry = shouldRetryNativeRun({ attempt, exitCode, readinessObserved, failureKind });
  if (exitCode !== 0 && !retry) {
    mkdirSync(artifactOutput, { recursive: true, mode: 0o700 });
    cpSync(layout.artifacts, path.join(artifactOutput, `attempt-${attempt + 1}`), {
      recursive: true,
    });
  }

  // The official embedded service terminates the application before a normal
  // WDIO return. A signalled child does not prove that lifecycle completed, so
  // retain the marked root instead of risking cleanup beneath a live app.
  if (shouldCleanupAfterNativeRunner(runnerSignals)) {
    cleanupNativeE2eRoot(layout, { appExited: true });
  } else {
    process.stderr.write(
      "Native E2E runner ended by signal; marked root retained because app exit is unconfirmed.\n",
    );
  }

  if (exitCode === 0 || !retry) break;
  process.stderr.write("Native E2E infrastructure failed before readiness; retrying once.\n");
}

process.exitCode = finalExitCode;
