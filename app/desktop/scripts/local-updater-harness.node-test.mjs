import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HARNESS_IDENTIFIER,
  HARNESS_PRODUCT_NAME,
  assertContainedPath,
  assertNoSymlinkPath,
  assertSupportedNode,
  buildManifest,
  buildOpenArguments,
  buildOverlay,
  createSigningEnvironment,
  classifyRequest,
  validatePort,
  validatePrivateKeyPath,
  validatePublicKey,
  writeTamperedArchive,
} from "./local-updater-harness.mjs";

const MINISIGN_PUBLIC_KEY = [
  "untrusted comment: minisign public key 0123456789ABCDEF",
  Buffer.concat([Buffer.from("Ed"), Buffer.alloc(40, 7)]).toString("base64"),
].join("\n");
const PUBLIC_KEY = Buffer.from(MINISIGN_PUBLIC_KEY).toString("base64");

test("accepts only the supported Node 22.12+ and Node 24 LTS lines", () => {
  assert.doesNotThrow(() => assertSupportedNode("v22.12.0"));
  assert.doesNotThrow(() => assertSupportedNode("v24.12.0"));
  assert.throws(() => assertSupportedNode("v22.11.0"), /Node 22\.12 or Node 24 LTS/);
  assert.throws(() => assertSupportedNode("v26.5.0"), /Node 22\.12 or Node 24 LTS/);
});

test("accepts a bounded port and rejects privileged or malformed values", () => {
  assert.equal(validatePort("48765"), 48765);
  for (const value of ["0", "1023", "65536", "1.5", "nope"]) {
    assert.throws(() => validatePort(value), /port/);
  }
});

test("accepts Tauri's base64-wrapped minisign public key but rejects paths and inner text", () => {
  assert.equal(validatePublicKey(PUBLIC_KEY), PUBLIC_KEY);
  for (const value of [
    "/Users/test/.tauri/key.pub",
    MINISIGN_PUBLIC_KEY,
    Buffer.from("untrusted comment: minisign private key\nRWQ=").toString("base64"),
    Buffer.from("untrusted comment: minisign public key\nnot-base64!").toString("base64"),
    Buffer.from("untrusted comment: minisign public key\n" + Buffer.alloc(41).toString("base64")).toString("base64"),
    `${PUBLIC_KEY}\nextra`,
  ]) {
    assert.throws(() => validatePublicKey(value), /public key/i);
  }
});

test("private updater keys must be owner-only regular files and never symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-updater-key-"));
  const key = path.join(root, "updater.key");
  await writeFile(key, "secret");
  await chmod(key, 0o600);
  assert.equal(await validatePrivateKeyPath(key), key);

  await chmod(key, 0o644);
  await assert.rejects(validatePrivateKeyPath(key), /0600/);
  await chmod(key, 0o600);
  const linked = path.join(root, "linked.key");
  await symlink(key, linked);
  await assert.rejects(validatePrivateKeyPath(linked), /symlink/);
});

test("generated overlays isolate identity, artifacts, endpoint, and ad-hoc signing", () => {
  const baseline = buildOverlay({
    version: "0.1.1",
    publicKey: PUBLIC_KEY,
    port: 48765,
    createUpdaterArtifacts: false,
  });
  const update = buildOverlay({
    version: "0.2.0",
    publicKey: PUBLIC_KEY,
    port: 48765,
    createUpdaterArtifacts: true,
  });

  for (const overlay of [baseline, update]) {
    assert.equal(overlay.productName, HARNESS_PRODUCT_NAME);
    assert.equal(overlay.identifier, HARNESS_IDENTIFIER);
    assert.deepEqual(overlay.bundle.externalBin, []);
    assert.deepEqual(overlay.bundle.resources, []);
    assert.equal(overlay.bundle.macOS.signingIdentity, "-");
    assert.deepEqual(overlay.plugins.updater.endpoints, [
      "http://127.0.0.1:48765/latest-alpha.json",
    ]);
    assert.equal(overlay.plugins.updater.pubkey, PUBLIC_KEY);
    assert.equal(overlay.plugins.updater.dangerousInsecureTransportProtocol, true);
  }
  assert.equal(baseline.bundle.createUpdaterArtifacts, false);
  assert.equal(update.bundle.createUpdaterArtifacts, true);
});

test("manifest binds one strictly newer update to the exact loopback archive", () => {
  const manifest = buildManifest({
    version: "0.2.0",
    platformKey: "darwin-aarch64",
    port: 48765,
    archiveName: "NeuralNote Updater Harness.app.tar.gz",
    signature: "trusted-signature",
  });
  assert.equal(manifest.version, "0.2.0");
  assert.deepEqual(manifest.platforms["darwin-aarch64"], {
    signature: "trusted-signature",
    url: "http://127.0.0.1:48765/NeuralNote%20Updater%20Harness.app.tar.gz",
  });
  assert.throws(
    () => buildManifest({ version: "0.1.1", platformKey: "darwin-aarch64", port: 48765, archiveName: "x", signature: "s" }),
    /strictly newer/,
  );
});

test("negative journey changes exactly one archive byte while preserving its structure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-updater-archive-"));
  const source = path.join(root, "valid.app.tar.gz");
  const tampered = path.join(root, "tampered.app.tar.gz");
  await writeFile(source, Buffer.from([1, 2, 3, 4, 5]));
  await writeTamperedArchive(source, tampered);

  const [before, after] = await Promise.all([readFile(source), readFile(tampered)]);
  assert.equal(after.length, before.length);
  assert.equal(
    [...before].filter((byte, index) => byte !== after[index]).length,
    1,
  );
});

test("child signing environment strips Apple, GitHub, and ambient signing secrets", () => {
  const env = createSigningEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      APPLE_ID: "apple-secret",
      GH_TOKEN: "github-secret",
      SOME_TOKEN: "other-secret",
      OPENAI_API_KEY: "provider-secret",
      DATABASE_URL: "database-secret",
      AWS_ACCESS_KEY_ID: "cloud-secret",
      TAURI_CONFIG: "ambient-config",
      NODE_OPTIONS: "--require malicious.js",
      TAURI_SIGNING_PRIVATE_KEY: "raw-private-key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "old-password",
    },
    "/safe/updater.key",
    "new-password",
  );
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/Users/test");
  assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, "/safe/updater.key");
  assert.equal(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "new-password");
  assert.equal(env.APPLE_ID, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.SOME_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.TAURI_CONFIG, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("macOS launch always requests a fresh application instance", () => {
  assert.deepEqual(buildOpenArguments("/safe/Harness.app"), ["-n", "/safe/Harness.app"]);
});

test("loopback server exposes only manifest and archive through GET or HEAD", () => {
  assert.equal(classifyRequest("GET", "/latest-alpha.json", "Bundle.app.tar.gz"), "manifest");
  assert.equal(classifyRequest("HEAD", "/Bundle.app.tar.gz", "Bundle.app.tar.gz"), "archive");
  assert.equal(classifyRequest("POST", "/latest-alpha.json", "Bundle.app.tar.gz"), "method-not-allowed");
  for (const url of ["/../key", "/%2e%2e/key", "/.env", "/overlay.json", "/Bundle.app.tar.gz.sig", "/unknown"]) {
    assert.equal(classifyRequest("GET", url, "Bundle.app.tar.gz"), "not-found");
  }
});

test("launch and artifact paths must remain inside their unique harness session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-updater-session-"));
  const app = path.join(root, "baseline-valid", "Harness.app");
  await mkdir(app, { recursive: true });
  assert.equal(await assertContainedPath(root, app), app);
  await assert.rejects(assertContainedPath(root, path.dirname(root)), /outside/);
});

test("session creation rejects a symlinked target component before writing through it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nn-updater-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "nn-updater-outside-"));
  await symlink(outside, path.join(root, "target"));

  await assert.rejects(
    assertNoSymlinkPath(path.join(root, "target", "local-updater"), root),
    /symlink/,
  );
});
