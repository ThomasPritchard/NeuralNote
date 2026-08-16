import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BranchStrategy,
  PublicationAction,
  UnexpectedGitStatusError,
  selectBranchStrategy,
  selectPublicationAction,
} from "./publish-release-manifest.mjs";

const publisherPath = fileURLToPath(new URL("./publish-release-manifest.mjs", import.meta.url));

// ---------------------------------------------------------------------------
// The decision, as a pure function.
//
// Both the 0.2.1 and 0.3.0 releases published their prerelease and then failed
// this push, because a probe that could not reach the remote was read as "the
// branch does not exist" and a rootless history was pushed at a branch that
// already existed. The decision is isolated here so those three outcomes can be
// exercised without cutting a release.
// ---------------------------------------------------------------------------

test("an existing release-manifests branch is fetched, never orphaned", () => {
  assert.equal(selectBranchStrategy(0), BranchStrategy.FetchExisting);
});

test("an absent release-manifests branch is created as an orphan", () => {
  assert.equal(selectBranchStrategy(2), BranchStrategy.Orphan);
});

test("a probe that failed for any other reason refuses to guess", () => {
  // 128 is git's "fatal" status - no repository, no such remote, no network.
  // `null` is what spawnSync reports when git is killed by a signal.
  for (const status of [1, 3, 127, 128, 129, -1, null, undefined, "0", Number.NaN]) {
    assert.throws(
      () => selectBranchStrategy(status),
      UnexpectedGitStatusError,
      `probe status ${String(status)} must not resolve to a branch strategy`,
    );
  }
});

test("an unchanged manifest publishes nothing", () => {
  assert.equal(selectPublicationAction(0), PublicationAction.Skip);
});

test("a changed manifest is committed and pushed", () => {
  assert.equal(selectPublicationAction(1), PublicationAction.CommitAndPush);
});

test("a staged-diff check that failed refuses to guess", () => {
  for (const status of [2, 128, null, undefined]) {
    assert.throws(
      () => selectPublicationAction(status),
      UnexpectedGitStatusError,
      `staged-diff status ${String(status)} must not resolve to a publication action`,
    );
  }
});

test("a refusal names the exit status that could not be interpreted", () => {
  assert.throws(() => selectBranchStrategy(128), /exit 128/);
});

// ---------------------------------------------------------------------------
// The plumbing, against a real git remote.
//
// The pure function above cannot see the defect that actually shipped: the
// probe was spelled correctly and run in the wrong directory. These run the
// real script against a real (local, bare) remote, so the commands have to work
// where they are actually issued.
// ---------------------------------------------------------------------------

/** Runs git for test setup, failing loudly rather than continuing on a broken fixture. */
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: isolatedGitEnvironment() });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Keeps the developer's own git configuration out of the fixture. A global
 * `commit.gpgsign` or `init.defaultBranch` would otherwise decide whether these
 * tests pass.
 */
function isolatedGitEnvironment(overrides = {}) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...overrides,
  };
}

/** A bare repository standing in for the GitHub remote, plus the runner temp dir. */
function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "neuralnote-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const serverRoot = join(root, "server");
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(serverRoot, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  git(serverRoot, "init", "--bare", "remote.git");

  return { root, serverRoot, runnerTemp, remotePath: join(serverRoot, "remote.git") };
}

/** Seeds the remote with an existing `release-manifests` branch. */
function seedManifestBranch({ root, remotePath }, manifest) {
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init");
  git(seed, "remote", "add", "origin", remotePath);
  writeFileSync(join(seed, "latest-alpha.json"), manifest);
  git(seed, "config", "user.name", "seed");
  git(seed, "config", "user.email", "seed@example.com");
  git(seed, "add", "latest-alpha.json");
  git(seed, "commit", "-m", "seed");
  git(seed, "push", "origin", "HEAD:refs/heads/release-manifests");
  return git(seed, "rev-parse", "HEAD");
}

/**
 * Runs the publisher exactly as the release workflow does: as a process, from
 * env, and from a working directory that is *not* a git repository. The publish
 * job checks nothing out by design, so a git command that forgets its
 * `-C <worktree>` has no repository to fall back on - which is precisely the
 * defect that shipped in 0.3.0.
 */
function runPublisher(fixture, manifest) {
  const manifestPath = join(fixture.root, "latest-alpha.json");
  writeFileSync(manifestPath, manifest);
  return spawnSync(process.execPath, [publisherPath], {
    cwd: fixture.root,
    encoding: "utf8",
    env: isolatedGitEnvironment({
      RUNNER_TEMP: fixture.runnerTemp,
      GITHUB_SERVER_URL: `file://${fixture.serverRoot}`,
      GITHUB_REPOSITORY: "remote",
      RELEASE_MANIFEST: manifestPath,
      RELEASE_VERSION: "9.9.9",
    }),
  });
}

/** Reads a file from the remote's `release-manifests` branch. */
function readPublishedManifest(remotePath) {
  return git(remotePath, "show", "release-manifests:latest-alpha.json");
}

test("publishing onto an existing branch extends it instead of replacing its history", (t) => {
  const fixture = createFixture(t);
  const existingTip = seedManifestBranch(fixture, '{"version":"0.0.1"}\n');

  const result = runPublisher(fixture, '{"version":"9.9.9"}\n');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readPublishedManifest(fixture.remotePath), '{"version":"9.9.9"}');
  const publishedTip = git(fixture.remotePath, "rev-parse", "release-manifests");
  assert.notEqual(publishedTip, existingTip, "the manifest should have been updated");
  assert.equal(
    git(fixture.remotePath, "rev-list", "--parents", "-n", "1", "release-manifests"),
    `${publishedTip} ${existingTip}`,
    "the new commit must sit on top of the existing tip, not start a rootless history",
  );
});

test("publishing to an absent branch creates it", (t) => {
  const fixture = createFixture(t);

  const result = runPublisher(fixture, '{"version":"9.9.9"}\n');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readPublishedManifest(fixture.remotePath), '{"version":"9.9.9"}');
  assert.equal(
    git(fixture.remotePath, "rev-list", "--count", "release-manifests"),
    "1",
    "a branch created from nothing should have exactly one commit",
  );
});

test("an identical manifest leaves the branch untouched and still succeeds", (t) => {
  const fixture = createFixture(t);
  const existingTip = seedManifestBranch(fixture, '{"version":"9.9.9"}\n');

  const result = runPublisher(fixture, '{"version":"9.9.9"}\n');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    git(fixture.remotePath, "rev-parse", "release-manifests"),
    existingTip,
    "nothing was staged, so nothing should have been pushed",
  );
  assert.match(result.stdout, /nothing to publish/);
});

test("an unreachable remote stops the release rather than orphaning the branch", (t) => {
  const fixture = createFixture(t);
  rmSync(fixture.remotePath, { recursive: true, force: true });

  const result = runPublisher(fixture, '{"version":"9.9.9"}\n');

  assert.notEqual(result.status, 0, "an unanswerable probe must fail the release");
  assert.match(result.stderr, /::error::/);
});

test("a missing release environment fails before any git work", (t) => {
  const fixture = createFixture(t);
  const manifestPath = join(fixture.root, "latest-alpha.json");
  writeFileSync(manifestPath, '{"version":"9.9.9"}\n');

  const result = spawnSync(process.execPath, [publisherPath], {
    cwd: fixture.root,
    encoding: "utf8",
    env: isolatedGitEnvironment({
      RUNNER_TEMP: fixture.runnerTemp,
      GITHUB_SERVER_URL: `file://${fixture.serverRoot}`,
      GITHUB_REPOSITORY: "remote",
      RELEASE_MANIFEST: manifestPath,
      RELEASE_VERSION: "",
    }),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RELEASE_VERSION/);
});
