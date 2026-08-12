import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const EDITOR_SELECTORS = [
  ".cm-content",
  "textarea",
  "input",
  "[contenteditable='true']",
];
const MAX_ERROR_MESSAGE_LENGTH = 300;
const TRUNCATION_SUFFIX = "...";
const UNREADABLE_ERROR_MESSAGE = "<unreadable error>";
const UNREADABLE_ERROR_TYPE = "<unreadable error type>";
const PRIVATE_PREFIX = "/private";
const CREDENTIAL_PATTERN =
  /\b(api[_-]?key|authorization|password|secret|token)"?\s*[:=]\s*(?:bearer\s+)?"?[^\s,;"']*/gi;
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

/**
 * Node's complete `AssertionError.operator` vocabulary, strict and legacy.
 *
 * A hard allowlist, not a shape test: an operator is only ever emitted because
 * it is one of these, so it cannot carry note content whatever a thrown value
 * claims. An unrecognised operator is dropped rather than echoed.
 */
const ASSERTION_OPERATORS = new Set([
  "==",
  "!=",
  "deepEqual",
  "notDeepEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
  "equal",
  "notEqual",
  "strictEqual",
  "notStrictEqual",
  "match",
  "doesNotMatch",
  "throws",
  "doesNotThrow",
  "rejects",
  "doesNotReject",
  "ifError",
  "fail",
]);

/**
 * The shape every Node error code takes — errno (`ENOENT`) and Node's own
 * (`ERR_ASSERTION`) alike.
 *
 * The vocabulary is open-ended, so this admits by shape rather than by list.
 * Prose cannot survive it: no lowercase, no whitespace, no punctuation beyond
 * `_`, and a hard length bound. A code failing the shape is dropped, never
 * echoed.
 */
const ERROR_CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,31}$/u;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Both spellings of the harness root, longest first.
 *
 * `createNativeE2eRoot` realpaths its parent, so on macOS the root it hands out
 * is `/private/var/...` while the OS — and anything reading `os.tmpdir()` —
 * still emits the `/var/...` symlink form. Redacting only the resolved spelling
 * lets the other one through. Longest first so the resolved form wins the
 * alternation and leaves `<E2E_ROOT>` rather than `/private<E2E_ROOT>`.
 */
function rootAliases(root: string): readonly string[] {
  if (root.startsWith(`${PRIVATE_PREFIX}/`)) {
    return [root, root.slice(PRIVATE_PREFIX.length)];
  }
  if (root.startsWith("/")) {
    return [`${PRIVATE_PREFIX}${root}`, root];
  }
  return [root];
}

export function redactArtifactText(value: string, root: string): string {
  const rootPattern = rootAliases(root).map(escapeForRegExp).join("|");
  return value
    .replace(new RegExp(rootPattern, "g"), "<E2E_ROOT>")
    .replace(CREDENTIAL_PATTERN, "$1=<REDACTED>");
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

/**
 * Read the message of any thrown value without throwing again. A hostile or
 * absent `toString` must never stop the failure artifact from being written.
 */
function readThrownMessage(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return UNREADABLE_ERROR_MESSAGE;
  }
}

/**
 * Read the class name of any thrown value without throwing again.
 *
 * `name` is an ordinary property an error can redefine as a throwing accessor,
 * so it needs the same guard as `message`. Reading it unguarded threw straight
 * out of `failureMetadata` and, because that call is inlined into the artifact
 * write, suppressed the artifact entirely.
 */
function readThrownType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  try {
    return String(error.name);
  } catch {
    return UNREADABLE_ERROR_TYPE;
  }
}

function readThrownProperty(error: unknown, property: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    return (error as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function admittedErrorCode(error: unknown): string | undefined {
  const code = readThrownProperty(error, "code");
  return typeof code === "string" && ERROR_CODE_SHAPE.test(code) ? code : undefined;
}

function admittedErrorOperator(error: unknown): string | undefined {
  const operator = readThrownProperty(error, "operator");
  return typeof operator === "string" && ASSERTION_OPERATORS.has(operator)
    ? operator
    : undefined;
}

/**
 * Reduce a thrown value to one bounded, redacted line.
 *
 * Only the first line survives: matcher libraries put their expected/received
 * values on later lines, and those values can be complete note bodies. A wait
 * expiry, a missing element and a harness `throw` are each decided by that line
 * alone; an assertion failure is not, which is what `failureMetadata`'s
 * `errorCode` and `errorOperator` exist to narrow.
 *
 * Redaction runs before the length cap so a truncated tail cannot strand half
 * of an absolute path or a credential beyond the substitution's reach.
 *
 * A bare carriage return breaks the line too. Nothing observed so far puts a
 * real CR in a message: the mixed-ending fixture in
 * `specs/30-markdown-source.spec.ts` does hold bare CRs, but Node escapes them
 * to a literal backslash-r when it inspects a string, so an assertion diff
 * quoting that fixture is still one physical line. The split is defence in
 * depth against a producer that emits a raw CR.
 *
 * `MAX_ERROR_MESSAGE_LENGTH` bounds the returned string, suffix included, so a
 * truncated line is exactly that many characters rather than three over.
 */
function redactedErrorLine(error: unknown, root: string): string {
  const [firstLine = ""] = readThrownMessage(error).split(/\r\n|[\r\n]/);
  const redacted = redactArtifactText(firstLine.trim(), root);
  if (redacted.length <= MAX_ERROR_MESSAGE_LENGTH) return redacted;
  const kept = MAX_ERROR_MESSAGE_LENGTH - TRUNCATION_SUFFIX.length;
  return `${redacted.slice(0, kept)}${TRUNCATION_SUFFIX}`;
}

/**
 * Describe one failure in the smallest set of fields that can tell its cause
 * apart from another's.
 *
 * `errorType` and the first message line are not enough on their own: every
 * `assert.equal` in `specs/` reduces to the same banner line, and that is the
 * suite's largest failure class. `errorCode` and `errorOperator` do not name
 * the failing site either — they narrow the class, separating an assertion
 * failure from an `ENOENT` or a wait expiry, and one assertion kind from
 * another. Both are admitted only from a closed vocabulary or from a shape
 * prose cannot take, so neither can carry note content.
 */
export function failureMetadata(title: string, error: unknown, root: string) {
  const errorCode = admittedErrorCode(error);
  const errorOperator = admittedErrorOperator(error);
  return {
    schemaVersion: 3,
    title,
    errorType: readThrownType(error),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorOperator === undefined ? {} : { errorOperator }),
    redactedErrorMessage: redactedErrorLine(error, root),
    fixture: "synthetic-native-e2e-v1",
    // True by call-site discipline, not by construction: nothing here proves
    // the surviving first line is content-free. Today every value interpolated
    // into a harness message is a hardcoded fixture literal, but in-repo paths
    // exist that could put content-derived text on line 1, and no check would
    // go red if one started to. #101 tracks replacing the discipline with
    // enforcement.
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
    `${JSON.stringify(failureMetadata(title, error, root), null, 2)}\n`,
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
