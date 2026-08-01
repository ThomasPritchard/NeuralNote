import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const EDITOR_SELECTORS = [
  ".cm-content",
  "textarea",
  "input",
  "[contenteditable='true']",
];
const NATIVE_SPEC_ALLOWLIST = new Set([
  "00-startup.spec.ts",
  "10-authority-lifecycle.spec.ts",
  "20-vault-disk.spec.ts",
  "30-markdown-source.spec.ts",
  "35-external-reconciliation.spec.ts",
  "40-window.spec.ts",
  "50-workspace-ui.spec.ts",
  "60-workspace-restart-seed.spec.ts",
  "61-workspace-restart-assert.spec.ts",
]);

export function redactArtifactText(value: string, root: string): string {
  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value
    .replace(new RegExp(escapedRoot, "g"), "<E2E_ROOT>")
    .replace(
      /\b(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      "$1=<REDACTED>",
    );
}

function safeNativeLifecycleLine(line: string): string | null {
  const execution = /^Execution of (\d+) workers\b/u.exec(line);
  if (execution) return `Execution of ${execution[1]} workers`;

  const specFiles = /^Spec Files:\s+(?:(\d+) passed,?\s*)?(?:(\d+) failed,?\s*)?(?:(\d+) skipped,?\s*)?(\d+) total\b/u.exec(line);
  if (specFiles) {
    const [, passed = "0", failed = "0", skipped = "0", total] = specFiles;
    return `Spec Files: ${passed} passed, ${failed} failed, ${skipped} skipped, ${total} total`;
  }

  const status = /^\[([a-z0-9-]+)\] (RUNNING|PASSED|FAILED) in ([a-z0-9._-]+) - file:\/\/\/specs\/([a-z0-9._/-]+)(?: \((\d+) retries\))?$/iu.exec(line);
  if (!status) return null;
  const [, worker, disposition, runtime, spec, retries] = status;
  if (!NATIVE_SPEC_ALLOWLIST.has(spec)) return null;
  return `[${worker}] ${disposition.toUpperCase()} in ${runtime} - file:///specs/${spec}${retries ? ` (${retries} retries)` : ""}`;
}

/**
 * Keep only runner lifecycle/status lines in the uploaded log. Raw WebDriver
 * command data and assertion diffs can contain complete note bodies, so
 * token/path substitution alone is not a sufficient upload boundary.
 */
export function sanitizeNativeRunLog(value: string, root: string): string {
  const safeLines = value
    .split(/\r?\n/)
    .map(safeNativeLifecycleLine)
    .filter((line): line is string => line !== null);
  return `${redactArtifactText(safeLines.join("\n"), root)}\n`;
}

export function failureMetadata(title: string, error: unknown) {
  return {
    schemaVersion: 1,
    title,
    errorType: error instanceof Error ? error.name : typeof error,
    fixture: "synthetic-native-e2e-v1",
    editorContentRedacted: true,
  } as const;
}

export async function captureFailureArtifacts(
  title: string,
  error: unknown,
): Promise<void> {
  const root = process.env.NEURALNOTE_E2E_ROOT;
  if (!root) return;
  const directory = path.join(root, "artifacts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const slug = title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "test";

  writeFileSync(
    path.join(directory, `${slug}.json`),
    `${JSON.stringify(failureMetadata(title, error), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  let redactedSource: unknown;
  try {
    redactedSource = await browser.execute((selectors) => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      for (const selector of selectors) {
        for (const element of clone.querySelectorAll(selector)) {
          element.textContent = "[REDACTED TEST CONTENT]";
          element.removeAttribute("value");
        }
      }
      return clone.outerHTML;
    }, EDITOR_SELECTORS);
  } catch {
    // A startup crash or destroyed window cannot provide page source or a
    // screenshot. The redacted metadata above must still survive the failure.
    return;
  }
  writeFileSync(
    path.join(directory, `${slug}.html`),
    redactArtifactText(String(redactedSource), root),
    { encoding: "utf8", mode: 0o600 },
  );

  await browser.execute((selectors) => {
    for (const selector of selectors) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        element.dataset.nativeE2eVisibility = element.style.visibility;
        element.style.visibility = "hidden";
      }
    }
  }, EDITOR_SELECTORS);
  try {
    await browser.saveScreenshot(path.join(directory, `${slug}.png`));
  } finally {
    await browser.execute((selectors) => {
      for (const selector of selectors) {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          element.style.visibility = element.dataset.nativeE2eVisibility ?? "";
          delete element.dataset.nativeE2eVisibility;
        }
      }
    }, EDITOR_SELECTORS);
  }
}
