export interface NativeRunOutcome {
  attempt: number;
  exitCode: number;
  readinessObserved: boolean;
  failureKind: "app-or-driver-startup" | "test-or-configuration";
}

export function shouldRetryNativeRun(outcome: NativeRunOutcome): boolean {
  return outcome.attempt === 0
    && outcome.exitCode !== 0
    && !outcome.readinessObserved
    && outcome.failureKind === "app-or-driver-startup";
}

export function shouldCleanupAfterNativeRunner(
  signals: ReadonlyArray<NodeJS.Signals | null>,
): boolean {
  return signals.length > 0 && signals.every((signal) => signal === null);
}

const STARTUP_FAILURE_PATTERNS = [
  /failed to create (?:remote )?session/iu,
  /app(?:lication)? failed to start/iu,
  /could not start application/iu,
  /web\s*driver server.*(?:failed|unavailable|refused)/iu,
  /(?:econnrefused|connection refused).*(?:4445|webdriver)/iu,
  /tauri-driver.*(?:failed|exited|unavailable)/iu,
];

export function classifyNativeFailure(
  output: string,
  runnerSpawnFailed: boolean,
): NativeRunOutcome["failureKind"] {
  if (runnerSpawnFailed || STARTUP_FAILURE_PATTERNS.some((pattern) => pattern.test(output))) {
    return "app-or-driver-startup";
  }
  return "test-or-configuration";
}
