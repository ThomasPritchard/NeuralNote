#!/usr/bin/env node

import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HARNESS_PRODUCT_NAME = "NeuralNote Updater Harness";
export const HARNESS_IDENTIFIER = "com.neuralnote.desktop.updater-harness";

const BASELINE_VERSION = "0.1.1";
const UPDATE_VERSION = "0.2.0";
const DEFAULT_PORT = 48765;
const MANIFEST_ROUTE = "/latest-alpha.json";
const MAX_PUBLIC_KEY_BYTES = 8 * 1024;
const MAX_SIGNATURE_BYTES = 8 * 1024;
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const harnessRoot = path.join(repositoryRoot, "target", "local-updater");

export function assertSupportedNode(version = process.version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (!match || !((major === 22 && minor >= 12) || major === 24)) {
    throw new Error(
      `The local updater harness requires Node 22.12 or Node 24 LTS; found ${version}.`,
    );
  }
}

export function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("The updater harness port must be an integer from 1024 through 65535.");
  }
  return port;
}

export function validatePublicKey(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_PUBLIC_KEY_BYTES) {
    throw new Error("The updater public key is missing or oversized.");
  }
  const wrapped = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(wrapped)) {
    throw new Error("The updater public key is not valid Tauri public-key content.");
  }
  const decodedWrapper = Buffer.from(wrapped, "base64");
  if (decodedWrapper.toString("base64") !== wrapped) {
    throw new Error("The updater public key has invalid base64 encoding.");
  }
  const minisign = decodedWrapper.toString("utf8").trim();
  const lines = minisign.split(/\r?\n/);
  if (
    lines.length !== 2 ||
    !/^untrusted comment: minisign public key\b/i.test(lines[0]) ||
    /private key/i.test(minisign) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(lines[1])
  ) {
    throw new Error("The updater public key does not wrap valid minisign public-key content.");
  }
  const decoded = Buffer.from(lines[1], "base64");
  if (decoded.length !== 42 || decoded.subarray(0, 2).toString("ascii") !== "Ed") {
    throw new Error("The updater public key has an invalid minisign payload.");
  }
  return wrapped;
}

export async function validatePrivateKeyPath(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error("The updater private key must be provided as an absolute file path.");
  }
  let info;
  try {
    info = await lstat(candidate);
  } catch {
    throw new Error("The updater private key file is unavailable.");
  }
  if (info.isSymbolicLink()) {
    throw new Error("The updater private key must not be a symlink.");
  }
  if (!info.isFile()) {
    throw new Error("The updater private key must be a regular file.");
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error("The updater private key must have mode 0600.");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("The updater private key must be owned by the current user.");
  }
  return candidate;
}

export function buildOverlay({ version, publicKey, port, createUpdaterArtifacts }) {
  if (![BASELINE_VERSION, UPDATE_VERSION].includes(version)) {
    throw new Error("The harness supports only the fixed 0.1.1 to 0.2.0 journey.");
  }
  const checkedPort = validatePort(port);
  const checkedKey = validatePublicKey(publicKey);
  return {
    productName: HARNESS_PRODUCT_NAME,
    identifier: HARNESS_IDENTIFIER,
    version,
    bundle: {
      targets: ["app"],
      createUpdaterArtifacts,
      externalBin: [],
      resources: [],
      macOS: { signingIdentity: "-" },
    },
    plugins: {
      updater: {
        pubkey: checkedKey,
        endpoints: [`http://127.0.0.1:${checkedPort}${MANIFEST_ROUTE}`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  };
}

export function buildManifest({ version, platformKey, port, archiveName, signature }) {
  if (version !== UPDATE_VERSION) {
    throw new Error(`The harness update must be strictly newer than ${BASELINE_VERSION}.`);
  }
  if (!/^darwin-(aarch64|x86_64)$/.test(platformKey)) {
    throw new Error("The updater manifest platform is not a supported macOS target.");
  }
  if (!archiveName || path.basename(archiveName) !== archiveName) {
    throw new Error("The updater archive name must be one safe path component.");
  }
  const normalizedSignature = String(signature ?? "").trim();
  if (!normalizedSignature || Buffer.byteLength(normalizedSignature) > MAX_SIGNATURE_BYTES) {
    throw new Error("The updater signature is missing or oversized.");
  }
  const encodedArchive = encodeURIComponent(archiveName).replaceAll("%2E", ".");
  return {
    version,
    notes: "Local NeuralNote updater harness test",
    platforms: {
      [platformKey]: {
        signature: normalizedSignature,
        url: `http://127.0.0.1:${validatePort(port)}/${encodedArchive}`,
      },
    },
  };
}

const BUILD_ENVIRONMENT_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "RUSTC_WRAPPER",
  "DEVELOPER_DIR",
  "SDKROOT",
  "MACOSX_DEPLOYMENT_TARGET",
]);

export function createSigningEnvironment(base, privateKeyPath, password) {
  const clean = Object.fromEntries(
    Object.entries(base).filter(
      ([name, value]) => value !== undefined && BUILD_ENVIRONMENT_ALLOWLIST.has(name),
    ),
  );
  return {
    ...clean,
    TAURI_SIGNING_PRIVATE_KEY: privateKeyPath,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  };
}

export async function writeTamperedArchive(source, destination) {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 1) {
    throw new Error("The updater archive must be a nonempty regular file.");
  }
  await cp(source, destination, { errorOnExist: true });
  const handle = await openFile(destination, "r+");
  try {
    const offset = Math.floor(sourceInfo.size / 2);
    const byte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(byte, 0, 1, offset);
    if (bytesRead !== 1) throw new Error("Could not read the updater archive tamper byte.");
    byte[0] ^= 1;
    await handle.write(byte, 0, 1, offset);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(destination, 0o600);
}

export function buildOpenArguments(appPath) {
  return ["-n", appPath];
}

export function classifyRequest(method, requestUrl, archiveName) {
  if (method !== "GET" && method !== "HEAD") return "method-not-allowed";
  let pathname;
  try {
    pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
  } catch {
    return "not-found";
  }
  if (pathname === MANIFEST_ROUTE) return "manifest";
  if (pathname === `/${encodeURIComponent(archiveName).replaceAll("%2E", ".")}`) return "archive";
  return "not-found";
}

export async function assertContainedPath(root, candidate) {
  const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("The updater harness path resolves outside its isolated session.");
  }
  return candidate;
}

export async function assertNoSymlinkPath(candidate, stopAt) {
  const boundary = path.resolve(stopAt);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(boundary, resolvedCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Updater harness directories must remain inside the repository target.");
  }
  let current = boundary;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Updater harness directories must not be symlinks.");
      if (!info.isDirectory()) throw new Error("Updater harness path component is not a directory.");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function createSessionDirectory() {
  await assertNoSymlinkPath(harnessRoot, repositoryRoot);
  await mkdir(harnessRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(harnessRoot, repositoryRoot);
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const session = path.join(harnessRoot, `${timestamp}-${randomBytes(4).toString("hex")}`);
  await mkdir(session, { recursive: false, mode: 0o700 });
  await assertContainedPath(harnessRoot, session);
  return session;
}

function platformDetails() {
  if (process.platform !== "darwin") {
    throw new Error("The local updater harness currently supports macOS only.");
  }
  if (process.arch === "arm64") {
    return { targetTriple: "aarch64-apple-darwin", platformKey: "darwin-aarch64" };
  }
  if (process.arch === "x64") {
    return { targetTriple: "x86_64-apple-darwin", platformKey: "darwin-x86_64" };
  }
  throw new Error(`Unsupported macOS architecture: ${process.arch}.`);
}

async function writePrivateJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
}

function runTauriBuild({ targetTriple, cargoTarget, configPath, env }) {
  const npm = path.join(path.dirname(process.execPath), "npm");
  const args = [
    "run",
    "tauri",
    "--",
    "build",
    "--target",
    targetTriple,
    "--bundles",
    "app",
    "--config",
    configPath,
    "--ci",
    "--ignore-version-mismatches",
  ];
  const result = spawnSync(npm, args, {
    cwd: desktopRoot,
    env: { ...env, CARGO_TARGET_DIR: cargoTarget },
    stdio: "inherit",
    shell: false,
    timeout: 30 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Tauri updater harness build failed with exit code ${result.status ?? "unknown"}.`);
  }
}

async function findExactlyOne(directory, predicate, description) {
  const entries = await readdir(directory, { withFileTypes: true });
  const matches = entries.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${description}; found ${matches.length}.`);
  }
  const candidate = path.join(directory, matches[0].name);
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) throw new Error(`The ${description} must not be a symlink.`);
  return candidate;
}

async function findApp(bundleDirectory) {
  return findExactlyOne(
    bundleDirectory,
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
    "macOS application bundle",
  );
}

async function readPlistValue(appPath, key) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  await assertContainedPath(appPath, plist);
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", plist],
    { encoding: "utf8", shell: false },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Could not validate ${key} in the updater harness bundle.`);
  }
  return result.stdout.trim();
}

async function assertBundleIdentity(appPath, version) {
  const [identifier, bundleVersion] = await Promise.all([
    readPlistValue(appPath, "CFBundleIdentifier"),
    readPlistValue(appPath, "CFBundleShortVersionString"),
  ]);
  if (identifier !== HARNESS_IDENTIFIER || bundleVersion !== version) {
    throw new Error("The built updater harness bundle has an unexpected identity or version.");
  }
}

async function prepare(options) {
  assertSupportedNode();
  const { targetTriple, platformKey } = platformDetails();
  const port = validatePort(options.port ?? DEFAULT_PORT);
  if (!options.publicKeyFile || !path.isAbsolute(options.publicKeyFile)) {
    throw new Error("--public-key-file must be an absolute path.");
  }
  const publicKeyInfo = await lstat(options.publicKeyFile).catch(() => null);
  if (!publicKeyInfo?.isFile() || publicKeyInfo.isSymbolicLink()) {
    throw new Error("The updater public key must be a regular, non-symlink file.");
  }
  const publicKey = validatePublicKey(await readFile(options.publicKeyFile, "utf8"));
  const privateKey = await validatePrivateKeyPath(options.privateKeyFile);
  if (!Object.hasOwn(process.env, "TAURI_SIGNING_PRIVATE_KEY_PASSWORD")) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be set explicitly (an empty value is allowed).",
    );
  }

  const session = await createSessionDirectory();
  const cargoTarget = path.join(session, "cargo-target");
  await mkdir(cargoTarget, { mode: 0o700 });
  const baselineConfig = path.join(session, "baseline-overlay.json");
  const updateConfig = path.join(session, "update-overlay.json");
  await writePrivateJson(
    baselineConfig,
    buildOverlay({ version: BASELINE_VERSION, publicKey, port, createUpdaterArtifacts: false }),
  );
  await writePrivateJson(
    updateConfig,
    buildOverlay({ version: UPDATE_VERSION, publicKey, port, createUpdaterArtifacts: true }),
  );

  const cleanEnvironment = createSigningEnvironment(process.env, privateKey, "");
  delete cleanEnvironment.TAURI_SIGNING_PRIVATE_KEY;
  delete cleanEnvironment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  runTauriBuild({ targetTriple, cargoTarget, configPath: baselineConfig, env: cleanEnvironment });

  const bundleDirectory = path.join(cargoTarget, targetTriple, "release", "bundle", "macos");
  const baselineApp = await findApp(bundleDirectory);
  await assertBundleIdentity(baselineApp, BASELINE_VERSION);
  const validAppDirectory = path.join(session, "baseline-valid");
  const invalidAppDirectory = path.join(session, "baseline-invalid");
  await mkdir(validAppDirectory, { mode: 0o700 });
  await mkdir(invalidAppDirectory, { mode: 0o700 });
  const validApp = path.join(validAppDirectory, path.basename(baselineApp));
  const invalidApp = path.join(invalidAppDirectory, path.basename(baselineApp));
  await cp(baselineApp, validApp, { recursive: true, errorOnExist: true });
  await cp(baselineApp, invalidApp, { recursive: true, errorOnExist: true });

  const signingEnvironment = createSigningEnvironment(
    process.env,
    privateKey,
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  );
  runTauriBuild({ targetTriple, cargoTarget, configPath: updateConfig, env: signingEnvironment });

  const updateApp = await findApp(bundleDirectory);
  await assertBundleIdentity(updateApp, UPDATE_VERSION);
  const archive = await findExactlyOne(
    bundleDirectory,
    (entry) => entry.isFile() && entry.name.endsWith(".app.tar.gz"),
    "updater archive",
  );
  const signatureFile = await findExactlyOne(
    bundleDirectory,
    (entry) => entry.isFile() && entry.name.endsWith(".app.tar.gz.sig"),
    "updater signature",
  );
  const signature = (await readFile(signatureFile, "utf8")).trim();
  if (!signature || Buffer.byteLength(signature) > MAX_SIGNATURE_BYTES) {
    throw new Error("The generated updater signature is missing or oversized.");
  }

  const publicDirectory = path.join(session, "public");
  await mkdir(publicDirectory, { mode: 0o700 });
  const validArchive = path.join(publicDirectory, path.basename(archive));
  const invalidArchive = path.join(publicDirectory, `tampered-${path.basename(archive)}`);
  await cp(archive, validArchive, { errorOnExist: true });
  await writeTamperedArchive(archive, invalidArchive);
  const commonManifestInput = {
    version: UPDATE_VERSION,
    platformKey,
    port,
  };
  await writePrivateJson(
    path.join(session, "manifest-valid.json"),
    buildManifest({ ...commonManifestInput, archiveName: path.basename(validArchive), signature }),
  );
  await writePrivateJson(
    path.join(session, "manifest-invalid.json"),
    buildManifest({ ...commonManifestInput, archiveName: path.basename(invalidArchive), signature }),
  );
  await writePrivateJson(path.join(session, "session.json"), {
    formatVersion: 1,
    identifier: HARNESS_IDENTIFIER,
    baselineVersion: BASELINE_VERSION,
    updateVersion: UPDATE_VERSION,
    port,
    platformKey,
    validArchiveName: path.basename(validArchive),
    invalidArchiveName: path.basename(invalidArchive),
    validArchive: path.relative(session, validArchive),
    invalidArchive: path.relative(session, invalidArchive),
    validApp: path.relative(session, validApp),
    invalidApp: path.relative(session, invalidApp),
    validManifest: "manifest-valid.json",
    invalidManifest: "manifest-invalid.json",
  });

  console.log(`Prepared isolated updater harness: ${session}`);
  console.log(`Next: npm run updater:local -- serve --session ${JSON.stringify(session)} --mode invalid`);
  console.log(`Then: npm run updater:local -- serve --session ${JSON.stringify(session)} --mode valid`);
}

function validateSessionMetadata(value) {
  if (
    value?.formatVersion !== 1 ||
    value.identifier !== HARNESS_IDENTIFIER ||
    value.baselineVersion !== BASELINE_VERSION ||
    value.updateVersion !== UPDATE_VERSION ||
    !["darwin-aarch64", "darwin-x86_64"].includes(value.platformKey)
  ) {
    throw new Error("The updater harness session metadata is invalid.");
  }
  for (const name of [value.validArchiveName, value.invalidArchiveName]) {
    if (!name || path.basename(name) !== name || !name.endsWith(".app.tar.gz")) {
      throw new Error("The updater harness session archive name is invalid.");
    }
  }
  for (const field of [
    value.validArchive,
    value.invalidArchive,
    value.validApp,
    value.invalidApp,
    value.validManifest,
    value.invalidManifest,
  ]) {
    if (
      typeof field !== "string" ||
      path.isAbsolute(field) ||
      path.normalize(field).startsWith(`..${path.sep}`) ||
      path.normalize(field) === ".."
    ) {
      throw new Error("The updater harness session contains an unsafe relative path.");
    }
  }
  value.port = validatePort(value.port);
  return value;
}

function validateServedManifest(manifest, metadata, archiveName) {
  const entry = manifest?.platforms?.[metadata.platformKey];
  const expected = buildManifest({
    version: UPDATE_VERSION,
    platformKey: metadata.platformKey,
    port: metadata.port,
    archiveName,
    signature: entry?.signature,
  });
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error("The updater harness manifest no longer matches its isolated session.");
  }
  return manifest;
}

async function loadSession(sessionArgument) {
  if (!sessionArgument || !path.isAbsolute(sessionArgument)) {
    throw new Error("--session must be an absolute updater harness session path.");
  }
  const session = await realpath(sessionArgument);
  await assertContainedPath(harnessRoot, session);
  const metadataPath = path.join(session, "session.json");
  await assertContainedPath(session, metadataPath);
  const metadata = validateSessionMetadata(JSON.parse(await readFile(metadataPath, "utf8")));
  return { session, metadata };
}

async function createHarnessServer({ manifest, archive, archiveName, port }) {
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) {
    throw new Error("The served updater archive must be a regular, non-symlink file.");
  }
  const server = createServer((request, response) => {
    if (request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(404, { "Cache-Control": "no-store", "Content-Length": "0" });
      response.end();
      return;
    }
    const route = classifyRequest(request.method, request.url, archiveName);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (route === "method-not-allowed") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
      response.end();
      return;
    }
    if (route === "not-found") {
      response.writeHead(404, { "Content-Length": "0" });
      response.end();
      return;
    }
    if (route === "manifest") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(manifestBody.length),
      });
      response.end(request.method === "HEAD" ? undefined : manifestBody);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Length": String(archiveInfo.size),
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(archive).on("error", () => response.destroy()).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function serve(options) {
  assertSupportedNode();
  platformDetails();
  const mode = options.mode;
  if (mode !== "valid" && mode !== "invalid") throw new Error("--mode must be valid or invalid.");
  const { session, metadata } = await loadSession(options.session);
  const manifestPath = path.join(
    session,
    mode === "valid" ? metadata.validManifest : metadata.invalidManifest,
  );
  const archiveName = mode === "valid" ? metadata.validArchiveName : metadata.invalidArchiveName;
  const archive = path.join(
    session,
    mode === "valid" ? metadata.validArchive : metadata.invalidArchive,
  );
  const app = path.join(session, mode === "valid" ? metadata.validApp : metadata.invalidApp);
  await Promise.all([
    assertContainedPath(session, manifestPath),
    assertContainedPath(session, archive),
    assertContainedPath(session, app),
  ]);
  await assertBundleIdentity(app, BASELINE_VERSION);
  const manifest = validateServedManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
    metadata,
    archiveName,
  );
  const otherManifestPath = path.join(
    session,
    mode === "valid" ? metadata.invalidManifest : metadata.validManifest,
  );
  await assertContainedPath(session, otherManifestPath);
  const otherManifest = JSON.parse(await readFile(otherManifestPath, "utf8"));
  const signature = manifest.platforms[metadata.platformKey].signature;
  if (otherManifest?.platforms?.[metadata.platformKey]?.signature !== signature) {
    throw new Error("Valid and invalid updater journeys must use the same genuine signature.");
  }
  const server = await createHarnessServer({
    manifest,
    archive,
    archiveName,
    port: metadata.port,
  });
  console.log(`Serving the ${mode} updater journey at http://127.0.0.1:${metadata.port}${MANIFEST_ROUTE}`);
  console.log("Keep this process running until the app has checked and attempted the update. Press Ctrl+C to stop.");
  if (options.launch !== false) {
    const launch = spawnSync("/usr/bin/open", buildOpenArguments(app), {
      encoding: "utf8",
      shell: false,
      timeout: 15_000,
    });
    if (launch.error || launch.status !== 0) {
      await new Promise((resolve) => server.close(resolve));
      throw new Error("Could not launch the isolated updater harness app.");
    }
  }
  const stop = () => {
    const timeout = setTimeout(() => process.exit(1), 5_000);
    timeout.unref();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function verify(options) {
  assertSupportedNode();
  const mode = options.mode;
  if (mode !== "valid" && mode !== "invalid") throw new Error("--mode must be valid or invalid.");
  const { session, metadata } = await loadSession(options.session);
  const app = path.join(session, mode === "valid" ? metadata.validApp : metadata.invalidApp);
  await assertContainedPath(session, app);
  const expectedVersion = mode === "valid" ? UPDATE_VERSION : BASELINE_VERSION;
  await assertBundleIdentity(app, expectedVersion);
  console.log(`${mode} updater journey verified at ${expectedVersion}.`);
}

function parseOptions(argv) {
  const [command, ...rest] = argv;
  const options = { launch: true };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "--no-launch") {
      options.launch = false;
      continue;
    }
    if (!item.startsWith("--") || index + 1 >= rest.length) {
      throw new Error(`Invalid updater harness argument: ${item}.`);
    }
    const key = item.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function printUsage() {
  console.log(`Usage:
  npm run updater:local -- prepare --public-key-file /absolute/key.pub --private-key-file /absolute/key [--port ${DEFAULT_PORT}]
  npm run updater:local -- serve --session /absolute/session --mode valid|invalid [--no-launch]
  npm run updater:local -- verify --session /absolute/session --mode valid|invalid`);
}

async function main() {
  const { command, options } = parseOptions(process.argv.slice(2));
  if (command === "prepare") await prepare(options);
  else if (command === "serve") await serve(options);
  else if (command === "verify") await verify(options);
  else {
    printUsage();
    throw new Error("Choose prepare, serve, or verify.");
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`Updater harness failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
