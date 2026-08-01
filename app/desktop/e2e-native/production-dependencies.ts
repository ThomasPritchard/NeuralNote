import type { SpawnSyncReturns } from "node:child_process";

const AUTOMATION_DEPENDENCIES = [
  "tauri-plugin-wdio ",
  "tauri-plugin-wdio-webdriver ",
];

export function assertProductionDependencyTree(tree: string): void {
  if (AUTOMATION_DEPENDENCIES.some((dependency) => tree.includes(dependency))) {
    throw new Error("production dependency graph contains native automation");
  }
}

export function assertCargoTreeSucceeded(
  result: SpawnSyncReturns<string>,
): string {
  if (result.error) {
    throw new Error(`Failed to inspect the production dependency graph: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.signal) {
    throw new Error(`Production dependency inspection ended on ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Production dependency inspection failed with exit code ${result.status ?? "unknown"}: ${result.stderr}`,
    );
  }
  return result.stdout;
}
