import path from "node:path";

interface BuildResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
}

export function getTauriBuildInvocation(
  e2eDirectory: string,
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      path.resolve(e2eDirectory, "..", "node_modules", "@tauri-apps", "cli", "tauri.js"),
      "build",
      "--debug",
      "--no-bundle",
      "--config",
      path.join(e2eDirectory, "tauri.e2e.conf.json"),
    ],
  };
}

export function assertTauriBuildSucceeded(result: BuildResult): void {
  if (result.error) {
    throw new Error(`Failed to start the Tauri build: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.signal) {
    throw new Error(`Tauri build terminated by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`Tauri build failed with exit code ${result.status ?? "unknown"}`);
  }
}
