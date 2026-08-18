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

const weeklyOrManual =
  /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/u;

test("schedules a weekly informational pass and keeps manual dispatch", () => {
  for (const source of [ciWorkflow, workflow]) {
    assert.match(source, /\n  workflow_dispatch:\n/u);
    assert.match(source, /\n  schedule:\n    - cron: "17 6 \* \* 1"\n/u);
  }
});

test("gates pull requests on the required Ubuntu native lane only", () => {
  const required = jobBody(workflow, "  required-native:\n", "  macos-informational:\n");
  assert.match(workflow, /pull_request:/u);
  assert.match(required, /timeout-minutes: 30/u);
  assert.match(required, /ubuntu-latest/u);
  assert.match(required, /xvfb-run --auto-servernum/u);
  assert.doesNotMatch(required, /macos-latest/u);
  assert.doesNotMatch(required, weeklyOrManual);
});

test("parks native macOS on the weekly and manual informational lane", () => {
  const macos = jobBody(workflow, "  macos-informational:\n", "  windows-informational:\n");
  assert.match(macos, weeklyOrManual);
  assert.match(macos, /macos-latest/u);
  assert.match(macos, /continue-on-error: true/u);
  assert.match(macos, /path: app\/desktop\/e2e-native\/artifacts\//u);
});

test("parks Windows native on the weekly and manual informational lane", () => {
  const windows = jobBody(workflow, "  windows-informational:\n");
  assert.match(windows, weeklyOrManual);
  assert.match(windows, /timeout-minutes: 15/u);
  assert.match(windows, /continue-on-error: true/u);
  assert.match(windows, /path: app\/desktop\/e2e-native\/artifacts\//u);
  assert.doesNotMatch(workflow, /tauri-driver|msedgedriver|webkit2gtk-driver/u);
});

test("parks WebKit on the weekly and manual informational lane", () => {
  const browser = jobBody(ciWorkflow, "  browser:\n", "  browser-webkit:\n");
  const webkit = jobBody(ciWorkflow, "  browser-webkit:\n", "  rust:\n");
  assert.match(browser, /name: Browser \/ chromium \/ ubuntu-latest/u);
  assert.match(browser, /test:browser:chromium/u);
  assert.doesNotMatch(browser, /webkit/u);
  assert.match(webkit, weeklyOrManual);
  assert.match(webkit, /test:browser:webkit/u);
  assert.match(webkit, /continue-on-error: true/u);
});

test("prints verbose Gitleaks findings", () => {
  const secrets = jobBody(ciWorkflow, "  secrets:\n", "  frontend:\n");
  assert.match(
    secrets,
    /gitleaks" git \. --log-opts=--all --redact --no-banner -v/u,
  );
});

test("runs Node 24 coverage, build, and audit without duplicating journeys", () => {
  assert.match(ciWorkflow, /^  frontend-hardening:/mu);
  const matrix = jobBody(ciWorkflow, "  frontend:\n", "  frontend-hardening:\n");
  const hardening = jobBody(ciWorkflow, "  frontend-hardening:\n", "  browser:\n");

  assert.doesNotMatch(
    matrix,
    /test:e2e|test:markdown-contract|npm run coverage|npm run build|npm run audit:all/u,
  );
  assert.match(hardening, /timeout-minutes: 15/u);
  assert.match(hardening, /node-version: 24/u);
  assert.match(
    hardening,
    /name: Frontend \/ Node 24 \/ coverage, build, and audit/u,
  );
  assert.doesNotMatch(hardening, /npm run test:e2e|npm run test:markdown-contract/u);
  for (const command of ["npm run coverage", "npm run build", "npm run audit:all"]) {
    assert.equal(hardening.includes(command), true, `missing hardening command: ${command}`);
  }
});

test("executes feature-gated native Rust unit tests in debug CI", () => {
  const rust = jobBody(ciWorkflow, "  rust:\n", "  rust-macos:\n");
  assert.match(rust, /cargo test -p desktop --features native-e2e --locked/u);
});

test("compiles and tests the workspace on macOS so cfg\\(macos\\) cannot merge unchecked", () => {
  const macos = jobBody(ciWorkflow, "  rust-macos:\n");
  assert.match(macos, /name: Rust \/ macOS compile and test/u);
  assert.match(macos, /runs-on: macos-latest/u);
  assert.match(macos, /cargo test --workspace --locked/u);
  assert.match(macos, /TAURI_CONFIG:.*externalBin/u);
  assert.doesNotMatch(macos, /continue-on-error/u);
});

test("documents the published required check names", () => {
  const contributing = readFileSync(path.resolve(repoRoot, "CONTRIBUTING.md"), "utf8");
  for (const name of [
    "Secrets / Gitleaks",
    "Frontend / Node 22 / lint, types, and tests",
    "Frontend / Node 24 / lint, types, and tests",
    "Frontend / Node 24 / coverage, build, and audit",
    "Rust / test, lint, format, and bindings",
    "Rust / macOS compile and test",
    "Browser / chromium / ubuntu-latest",
  ]) {
    assert.match(contributing, new RegExp(name.replace(/[\\/]/gu, "\\$&"), "u"), name);
  }
  assert.doesNotMatch(contributing, /Frontend \/ lint, types, and tests/u);
});
