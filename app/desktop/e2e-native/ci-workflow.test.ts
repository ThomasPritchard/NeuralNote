import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

declare const lineFeedNormalised: unique symbol;

/**
 * Workflow source whose line endings are guaranteed to be `\n`.
 *
 * Only `readWorkflow` can produce one, so a future `readFileSync` call site
 * cannot feed a CRLF checkout into `jobBody` without failing
 * `npm --prefix app/desktop/e2e-native run typecheck`. That is the gate that
 * covers this file: `app/desktop`'s own `npm run typecheck` compiles
 * `include: ["src"]` and never sees it.
 */
type LineFeedSource = string & { readonly [lineFeedNormalised]: true };

/**
 * Reads a workflow file and normalises its line endings to `\n`.
 *
 * No `.gitattributes` covers `.github/workflows`. The repository's only one
 * sits under `fixtures/note-test-vault/` and applies to that directory alone,
 * so `git check-attr text -- .github/workflows/ci.yml` reports `unspecified`
 * and Windows runners check these files out with CRLF. Normalising once here -
 * rather than at each call site - keeps every `\n`-bearing lookup below
 * platform-independent.
 *
 * @param filePath Absolute path to the workflow file.
 * @returns The file's contents with CRLF line endings converted to `\n`.
 */
function readWorkflow(filePath: string): LineFeedSource {
  return readFileSync(filePath, "utf8").replace(/\r\n/gu, "\n") as LineFeedSource;
}

const workflow = readWorkflow(path.resolve(repoRoot, ".github", "workflows", "e2e.yml"));
const ciWorkflow = readWorkflow(path.resolve(repoRoot, ".github", "workflows", "ci.yml"));

function jobBody(source: LineFeedSource, start: string, end?: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing workflow job ${start.trim()}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing workflow job ${end?.trim()}`);
  return source.slice(from, to);
}

test("resolves job bodies from a CRLF checkout", (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "neuralnote-crlf-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const crlfWorkflow = path.join(scratch, "ci.yml");
  writeFileSync(
    crlfWorkflow,
    [
      "jobs:",
      "  frontend:",
      "    runs-on: ubuntu-latest",
      "  rust:",
      "    runs-on: macos-latest",
      "",
    ].join("\r\n"),
  );

  const frontend = jobBody(readWorkflow(crlfWorkflow), "  frontend:\n", "  rust:\n");

  assert.match(frontend, /runs-on: ubuntu-latest/u);
  assert.doesNotMatch(frontend, /runs-on: macos-latest/u);
});

test("gates relevant pull requests on 15-minute Ubuntu and macOS native lanes", () => {
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /platform: ubuntu-latest/);
  assert.match(workflow, /platform: macos-latest/);
  assert.match(workflow, /name: Native Tauri \(\$\{\{ matrix\.label \}\}\)/);
  assert.match(workflow, /xvfb-run --auto-servernum/);
});

test("keeps Windows informational and uploads only redacted harness artifacts", () => {
  assert.match(workflow, /windows-informational:/);
  assert.match(workflow, /if: github\.event_name != 'pull_request'/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /path: app\/desktop\/e2e-native\/artifacts\//);
  assert.doesNotMatch(workflow, /tauri-driver|msedgedriver|webkit2gtk-driver/);
});

test("runs Node 24 hardening within 15 minutes without duplicating it in the matrix", () => {
  assert.match(ciWorkflow, /^  frontend-hardening:/mu);
  const matrix = jobBody(ciWorkflow, "  frontend:\n", "  frontend-hardening:\n");
  const hardening = jobBody(ciWorkflow, "  frontend-hardening:\n", "  browser:\n");

  assert.doesNotMatch(
    matrix,
    /test:e2e|test:markdown-contract|npm run coverage|npm run build|npm run audit:all/u,
  );
  assert.match(hardening, /timeout-minutes: 15/u);
  assert.match(hardening, /node-version: 24/u);
  for (const command of [
    "npm run test:e2e",
    "npm run test:markdown-contract",
    "npm run coverage",
    "npm run build",
    "npm run audit:all",
  ]) {
    assert.equal(hardening.includes(command), true, `missing hardening command: ${command}`);
  }
});

test("executes feature-gated native Rust unit tests in debug CI", () => {
  const rust = jobBody(ciWorkflow, "  rust:\n");
  assert.match(rust, /cargo test -p desktop --features native-e2e --locked/u);
});
