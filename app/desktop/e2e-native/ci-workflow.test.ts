import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(
  path.resolve(here, "..", "..", "..", ".github", "workflows", "e2e.yml"),
  "utf8",
);
const ciWorkflow = readFileSync(
  path.resolve(here, "..", "..", "..", ".github", "workflows", "ci.yml"),
  "utf8",
);

function jobBody(source: string, start: string, end?: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing workflow job ${start.trim()}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing workflow job ${end?.trim()}`);
  return source.slice(from, to);
}

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
