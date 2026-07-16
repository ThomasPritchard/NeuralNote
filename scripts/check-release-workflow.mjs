import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowUrl = new URL("../.github/workflows/release-alpha.yml", import.meta.url);
const workflow = await readFile(fileURLToPath(workflowUrl), "utf8");

async function readRepositoryFile(relativePath) {
  return readFile(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function between(startMarker, endMarker) {
  const start = workflow.indexOf(startMarker);
  if (start === -1) return "";
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

function jobBody(name) {
  const marker = `  ${name}:`;
  const start = workflow.indexOf(marker);
  if (start === -1) return "";
  const tail = workflow.slice(start + marker.length);
  const nextJob = tail.search(/^  [a-zA-Z0-9_-]+:\s*$/m);
  return workflow.slice(start, nextJob === -1 ? workflow.length : start + marker.length + nextJob);
}

function stepBody(job, name) {
  const marker = `      - name: ${name}`;
  const start = job.indexOf(marker);
  if (start === -1) return "";
  const nextStep = job.indexOf("\n      - name:", start + marker.length);
  return job.slice(start, nextStep === -1 ? job.length : nextStep);
}

function runBodies(source) {
  const lines = source.split("\n");
  const bodies = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*\|\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.length - line.trimStart().length <= indent) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    bodies.push(body.join("\n"));
  }

  return bodies;
}

const trigger = between("on:\n", "\nconcurrency:");
const preflight = jobBody("preflight");
const build = jobBody("build");
const publish = jobBody("publish");

test("all production manifests use the release version", async () => {
  const releaseVersion = "0.2.1";
  const [desktopPackage, nativeE2ePackage, tauriConfig] = await Promise.all([
    readRepositoryFile("app/desktop/package.json"),
    readRepositoryFile("app/desktop/e2e-native/package.json"),
    readRepositoryFile("app/desktop/src-tauri/tauri.conf.json"),
  ]);
  for (const manifest of [desktopPackage, nativeE2ePackage, tauriConfig]) {
    assert.equal(JSON.parse(manifest).version, releaseVersion);
  }

  const cargoManifests = await Promise.all([
    readRepositoryFile("app/desktop/src-tauri/Cargo.toml"),
    readRepositoryFile("crates/neuralnote-core/Cargo.toml"),
    readRepositoryFile("crates/neuralnote-release/Cargo.toml"),
  ]);
  for (const manifest of cargoManifests) {
    assert.match(manifest, new RegExp(`^version = "${releaseVersion.replaceAll(".", "\\.")}"$`, "m"));
  }
});

test("release publication is manual-only and requires an explicit signing choice", () => {
  assert.match(trigger, /\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(trigger, /^  (?:push|pull_request|schedule|release|workflow_run|workflow_call):/m);
  assert.match(trigger, /release_tag:[\s\S]*?required:\s*true[\s\S]*?default:\s*v0\.2\.1/);
  assert.match(
    trigger,
    /signing_mode:[\s\S]*?type:\s*choice[\s\S]*?required:\s*true[\s\S]*?default:\s*ad-hoc[\s\S]*?options:[\s\S]*?- ad-hoc[\s\S]*?- developer-id/,
  );
  assert.match(
    trigger,
    /confirm_unnotarized:[\s\S]*?type:\s*boolean[\s\S]*?required:\s*true[\s\S]*?default:\s*false/,
  );
  assert.doesNotMatch(trigger, /Existing or new tag/i);
});

test("build and publication use separate least-privilege jobs", () => {
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  assert.ok(build, "release workflow is missing the build job");
  assert.ok(publish, "release workflow is missing the publish job");
  assert.match(build, /^\s{4}permissions:\s*\n\s{6}contents:\s*read\s*$/m);
  assert.match(publish, /^\s{4}permissions:\s*\n(?:\s{6}.+\n)*?\s{6}contents:\s*write\s*$/m);
  assert.match(publish, /^\s{4}needs:\s*build\s*$/m);
  assert.doesNotMatch(build, /contents:\s*write|GH_TOKEN|\$\{\{\s*github\.token\s*\}\}/);
  assert.match(build, /persist-credentials:\s*false/);
  assert.doesNotMatch(publish, /\$\{\{\s*(?:secrets|vars)\./);
  assert.doesNotMatch(publish, /actions\/checkout@|\bnpm\b|\bcargo\b|\.\/scripts\//);
  assert.match(build, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(publish, /actions\/download-artifact@[a-f0-9]{40}/);
});

test("job-level environment expressions use contexts available during workflow validation", () => {
  const publishJobHeader = publish.slice(0, publish.indexOf("\n    steps:"));
  assert.doesNotMatch(
    publishJobHeader,
    /\$\{\{\s*runner\./,
    "the runner context is unavailable in job-level env expressions",
  );
});

test("a secret-free preflight rejects untrusted dispatches before signing", () => {
  assert.ok(preflight, "release workflow is missing the preflight job");
  assert.doesNotMatch(preflight, /environment:\s*release|\$\{\{\s*(?:secrets|vars)\./);
  assert.match(preflight, /DISPATCH_REF:\s*\$\{\{\s*github\.ref\s*\}\}/);
  assert.match(preflight, /"\$DISPATCH_REF"\s*!=\s*"refs\/heads\/main"/);
  assert.match(build, /^\s{4}needs:\s*preflight\s*$/m);
  assert.doesNotMatch(build, /^\s{4}if:\s*\$\{\{\s*github\.ref/m);
});

test("the build proves an existing tag matches the trusted main dispatch commit", () => {
  const checkout = stepBody(build, "Check out the existing release tag");
  const validation = stepBody(build, "Validate release source and signing choice");
  assert.match(checkout, /ref:\s*refs\/tags\/\$\{\{\s*inputs\.release_tag\s*\}\}/);
  assert.match(checkout, /fetch-depth:\s*0/);
  assert.match(checkout, /persist-credentials:\s*false/);
  assert.match(validation, /RELEASE_TAG:\s*\$\{\{\s*inputs\.release_tag\s*\}\}/);
  assert.match(validation, /DISPATCH_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(validation, /git show-ref --verify "refs\/tags\/\$RELEASE_TAG"/);
  assert.match(validation, /git rev-list -n 1 "\$RELEASE_TAG"/);
  assert.match(validation, /git rev-parse HEAD/);
  assert.match(validation, /RELEASE_SHA.*GITHUB_OUTPUT/);
  assert.match(build, /^\s{4}outputs:[\s\S]*?release_sha:/m);
  assert.match(publish, /RELEASE_SHA:\s*\$\{\{\s*needs\.build\.outputs\.release_sha\s*\}\}/);
  assert.doesNotMatch(publish, /--target "\$GITHUB_SHA"/);
  assert.match(publish, /--verify-tag/);
  assert.match(publish, /--target "\$RELEASE_SHA"/);
});

test("the publisher revalidates the remote tag before draft creation and publication", () => {
  const draft = stepBody(publish, "Create draft GitHub prerelease");
  const publishRelease = stepBody(publish, "Publish GitHub prerelease");

  for (const step of [draft, publishRelease]) {
    assert.match(step, /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$RELEASE_TAG"/);
    assert.match(step, /REMOTE_TAG_SHA/);
    assert.match(step, /"\$REMOTE_TAG_SHA"\s*!=\s*"\$RELEASE_SHA"/);
  }
});

test("ad-hoc publication requires an explicit unnotarized acknowledgement", () => {
  const validation = stepBody(build, "Validate release source and signing choice");
  assert.match(validation, /SIGNING_MODE:\s*\$\{\{\s*inputs\.signing_mode\s*\}\}/);
  assert.match(
    validation,
    /CONFIRM_UNNOTARIZED:\s*\$\{\{\s*inputs\.confirm_unnotarized\s*\}\}/,
  );
  assert.match(
    validation,
    /"\$SIGNING_MODE"\s*=\s*"ad-hoc"[\s\S]*?"\$CONFIRM_UNNOTARIZED"\s*!=\s*"true"/,
  );
  for (const body of runBodies(workflow)) {
    assert.doesNotMatch(body, /\$\{\{\s*inputs\./, "workflow inputs must reach shell through env");
  }
});

test("Apple credentials and trust checks are isolated to Developer ID mode", () => {
  const importCertificate = stepBody(build, "Import Apple Developer ID certificate");
  const developerBuild = stepBody(build, "Build Developer ID Apple Silicon bundles");
  const cleanup = stepBody(build, "Remove temporary signing keychain");
  const adHocBuild = stepBody(build, "Build ad-hoc Apple Silicon bundles");
  const verify = stepBody(build, "Verify signed app and locate release artifacts");

  for (const step of [importCertificate, developerBuild, cleanup]) {
    assert.match(step, /if:\s*\$\{\{[\s\S]*?inputs\.signing_mode\s*==\s*'developer-id'/);
  }
  assert.match(adHocBuild, /if:\s*\$\{\{\s*inputs\.signing_mode\s*==\s*'ad-hoc'\s*\}\}/);
  assert.match(adHocBuild, /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\.TAURI_SIGNING_PRIVATE_KEY\s*\}\}/);
  assert.doesNotMatch(adHocBuild, /APPLE_/);
  assert.match(
    build,
    /const signingIdentity\s*=\s*signingMode\s*===\s*"ad-hoc"\s*\?\s*"-"/,
  );
  assert.match(verify, /Signature=adhoc/);
  assert.match(verify, /spctl --assess/);
  assert.match(verify, /"\$SIGNING_MODE"\s*=\s*"developer-id"/);

  const commonBuildWithoutConditionalSteps = build
    .replace(importCertificate, "")
    .replace(developerBuild, "")
    .replace(cleanup, "");
  assert.doesNotMatch(commonBuildWithoutConditionalSteps, /secrets\.(?:APPLE_|KEYCHAIN_)/);
});

test("the publisher stages a draft prerelease and exposes the manifest last", () => {
  const draft = stepBody(publish, "Create draft GitHub prerelease");
  const publishRelease = stepBody(publish, "Publish GitHub prerelease");
  const publishManifest = stepBody(publish, "Publish dedicated release-manifests branch");
  assert.match(draft, /gh release create/);
  assert.match(draft, /--verify-tag/);
  assert.match(draft, /--draft/);
  assert.match(draft, /--prerelease/);
  assert.match(draft, /--latest=false/);
  assert.match(draft, /UPDATE_BUNDLE|\.app\.tar\.gz/);
  assert.match(draft, /UPDATE_SIGNATURE|\.sig/);
  assert.match(publishRelease, /gh release edit/);
  assert.match(publishRelease, /--draft=false/);
  assert.match(publishRelease, /--prerelease/);
  assert.match(publishRelease, /--latest=false/);
  assert.match(publishManifest, /HEAD:refs\/heads\/release-manifests/);

  const draftIndex = publish.indexOf("      - name: Create draft GitHub prerelease");
  const releaseIndex = publish.indexOf("      - name: Publish GitHub prerelease");
  const manifestIndex = publish.indexOf("      - name: Publish dedicated release-manifests branch");
  assert.ok(draftIndex < releaseIndex && releaseIndex < manifestIndex);
  assert.equal(
    publish.slice(manifestIndex).match(/\n      - name:/g)?.length ?? 0,
    0,
    "manifest publication must be the final named publish step",
  );
});

test("the immutable GitHub release description includes the complete v0.2.1 changelog", async () => {
  const releaseNotes = await readRepositoryFile("docs/releases/v0.2.1.md");
  const bundledReleaseNotes = await readRepositoryFile("app/desktop/src/whats-new/releaseNotes.ts");
  const validate = stepBody(publish, "Validate downloaded release artifacts");
  const draft = stepBody(publish, "Create draft GitHub prerelease");

  assert.match(releaseNotes, /^# NeuralNote 0\.2\.1 ALPHA$/m);
  for (const heading of [
    "Editing and search",
    "Neural Assistant AI",
    "Accessibility and interface",
    "Reliability and release readiness",
  ]) {
    assert.match(releaseNotes, new RegExp(`^## ${heading}$`, "m"));
  }
  assert.match(releaseNotes, /plain-text notes/);
  assert.match(releaseNotes, /best-effort for citation fidelity/);
  assert.match(releaseNotes, /keyboard-accessible Move to action/);
  assert.match(releaseNotes, /aligned on version 0\.2\.1/);
  const bundledItems = [...bundledReleaseNotes.matchAll(/items:\s*\[([\s\S]*?)\]/g)].flatMap(
    ([, items]) => [...items.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(([item]) => JSON.parse(item)),
  );
  const publishedItems = releaseNotes
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).replaceAll("`", ""));
  assert.deepEqual(publishedItems, bundledItems);
  assert.match(build, /docs\/releases\/v0\.2\.1\.md/);
  assert.match(build, /ad-hoc signed and unnotarized/);
  assert.match(build, /Developer ID signed and notarized/);
  assert.match(validate, /RELEASE_NOTES/);
  assert.match(draft, /--notes-file "\$RELEASE_NOTES"/);
  assert.doesNotMatch(draft, /--notes "\$RELEASE_NOTES"/);
});

test("the publisher can safely resume after release or manifest publication", () => {
  const draft = stepBody(publish, "Create draft GitHub prerelease");
  const publishRelease = stepBody(publish, "Publish GitHub prerelease");
  const publishManifest = stepBody(publish, "Publish dedicated release-manifests branch");

  assert.match(draft, /gh release view/);
  assert.match(draft, /gh release download/);
  assert.match(draft, /cmp --/);
  assert.match(draft, /--json name/);
  assert.match(draft, /--json body/);
  assert.match(draft, /"\$RELEASE_NAME"\s*!=\s*"\$RELEASE_TITLE"/);
  assert.match(draft, /EXPECTED_RELEASE_BODY="\$\(cat "\$RELEASE_NOTES"\)"/);
  assert.match(draft, /"\$RELEASE_BODY"\s*!=\s*"\$EXPECTED_RELEASE_BODY"/);
  assert.match(draft, /RELEASE_ALREADY_PUBLISHED=true/);
  assert.match(publishRelease, /RELEASE_ALREADY_PUBLISHED/);
  assert.match(publishRelease, /--json isImmutable/);
  assert.match(publishRelease, /"\$RELEASE_IS_IMMUTABLE"\s*!=\s*"true"/);
  // Exact-ref probe (no --heads): `--heads <full-ref>` is a version-dependent
  // footgun that sent the second-ever release down the orphan path and failed the
  // non-fast-forward push (0.2.1 manifest publish). Assert the fixed form is present
  // and guard the buggy `--heads ... release-manifests` form from ever returning.
  assert.match(
    publishManifest,
    /git ls-remote --exit-code origin refs\/heads\/release-manifests/,
  );
  assert.doesNotMatch(publishManifest, /git ls-remote[^\n]*--heads[^\n]*release-manifests/);
  assert.match(publishManifest, /release-manifests already contains this manifest/);
  assert.doesNotMatch(publishManifest, /already contains this manifest[\s\S]*?exit 1/);
});

test("release artifacts are allowlisted and integrity-checked between jobs", () => {
  const verifySignature = stepBody(build, "Verify updater archive signature");
  const upload = stepBody(build, "Upload validated release artifacts");
  const validate = stepBody(publish, "Validate downloaded release artifacts");
  assert.match(
    verifySignature,
    /TAURI_UPDATER_PUBLIC_KEY:\s*\$\{\{\s*vars\.TAURI_UPDATER_PUBLIC_KEY\s*\}\}/,
  );
  assert.match(
    verifySignature,
    /cargo run --locked --package neuralnote-release --bin verify-updater-signature/,
  );
  assert.match(verifySignature, /"\$UPDATE_BUNDLE"\s+"\$UPDATE_SIGNATURE"/);
  assert.match(upload, /if-no-files-found:\s*error/);
  assert.match(upload, /retention-days:\s*1/);
  assert.match(validate, /SHA256SUMS/);
  assert.match(validate, /sha256sum --check/);
  assert.match(validate, /EXPECTED_FILE_COUNT=6/);
  assert.match(validate, /RELEASE_NOTES="\$RELEASE_ARTIFACT_DIR\/RELEASE_NOTES\.md"/);
  assert.match(validate, /\.app\.tar\.gz/);
  assert.match(validate, /\.dmg/);
  assert.match(validate, /latest-alpha\.json/);
});

test("existing release quality and supply-chain controls remain enforced", () => {
  assert.match(build, /^\s{4}environment:\s*release\s*$/m);
  const releaseGates = stepBody(build, "Run release gates");
  assert.match(
    releaseGates,
    /TAURI_CONFIG:\s*'\{"bundle":\{"externalBin":\[\],"resources":\[\]\}\}'/,
  );
  assert.match(releaseGates, /npm --prefix app\/desktop run audit:all/);

  const fetchSidecar = stepBody(build, "Fetch and verify Ollama sidecar");
  assert.match(fetchSidecar, /\.\/scripts\/fetch-ollama-sidecar\.sh/);

  const actionLines = workflow.split("\n").filter((line) => /^\s+uses:/.test(line));
  assert.ok(actionLines.length > 0);
  assert.ok(actionLines.every((line) => /@[a-f0-9]{40}(?:\s|#|$)/.test(line)));

  const validateConfigIndex = build.indexOf("      - name: Validate public release configuration");
  const fetchSidecarIndex = build.indexOf("      - name: Fetch and verify Ollama sidecar");
  const adHocBuildIndex = build.indexOf("      - name: Build ad-hoc Apple Silicon bundles");
  const developerBuildIndex = build.indexOf("      - name: Build Developer ID Apple Silicon bundles");
  assert.ok(validateConfigIndex < fetchSidecarIndex);
  assert.ok(fetchSidecarIndex < adHocBuildIndex);
  assert.ok(fetchSidecarIndex < developerBuildIndex);
});
