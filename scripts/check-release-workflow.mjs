import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const workflowUrl = new URL("../.github/workflows/release-alpha.yml", import.meta.url);
const workflow = await readFile(fileURLToPath(workflowUrl), "utf8");

function stepBody(name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `release workflow is missing the '${name}' step`);

  const nextStep = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, nextStep === -1 ? workflow.length : nextStep);
}

const releaseGates = stepBody("Run release gates");
assert.match(
  releaseGates,
  /TAURI_CONFIG:\s*'\{"bundle":\{"externalBin":\[\],"resources":\[\]\}\}'/,
  "release-only Rust gates must disable sidecar bundling before the sidecars are fetched",
);

const fetchSidecar = stepBody("Fetch and verify Ollama sidecar");
assert.match(
  fetchSidecar,
  /\.\/scripts\/fetch-ollama-sidecar\.sh/,
  "the release workflow must use the checksum-verifying sidecar fetcher",
);

const validateConfigIndex = workflow.indexOf("      - name: Validate public release configuration");
const fetchSidecarIndex = workflow.indexOf("      - name: Fetch and verify Ollama sidecar");
const importCertificateIndex = workflow.indexOf("      - name: Import Apple Developer ID certificate");
const buildBundlesIndex = workflow.indexOf(
  "      - name: Build, sign, and notarize Apple Silicon bundles",
);

assert.ok(
  validateConfigIndex < fetchSidecarIndex &&
    fetchSidecarIndex < importCertificateIndex &&
    importCertificateIndex < buildBundlesIndex,
  "validate configuration, fetch the verified sidecars, import the certificate, then build bundles",
);

console.log("Release workflow sidecar contract is valid.");
