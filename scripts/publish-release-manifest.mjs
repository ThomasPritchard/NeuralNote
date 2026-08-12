#!/usr/bin/env node
/**
 * Publishes the updater manifest onto the dedicated `release-manifests` branch,
 * which every installed client polls for updates.
 *
 * This is the last thing a release does: clients never see a manifest until the
 * signed artifact, the checksum-validated transfer, and the public GitHub
 * prerelease all exist.
 *
 * It lives here rather than inline in `.github/workflows/release-alpha.yml`
 * because it broke on two consecutive releases and a workflow step is only ever
 * exercised by cutting a release. `selectBranchStrategy` and
 * `selectPublicationAction` are pure so the branch-exists, branch-absent, and
 * probe-failed outcomes can be tested directly - see
 * `publish-release-manifest.test.mjs`.
 *
 * Required environment (all supplied by the release workflow's publish job):
 * `RUNNER_TEMP`, `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `RELEASE_MANIFEST`,
 * `RELEASE_VERSION`. Authentication is the caller's job: run
 * `gh auth setup-git` before this script.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_BRANCH = "release-manifests";
const MANIFEST_REF = `refs/heads/${MANIFEST_BRANCH}`;
const MANIFEST_FILENAME = "latest-alpha.json";
const COMMIT_AUTHOR_NAME = "github-actions[bot]";
const COMMIT_AUTHOR_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

/** `git ls-remote --exit-code` answers 0 for "found" and reserves 2 for "no matching refs". */
const REMOTE_REF_FOUND = 0;
const REMOTE_REF_ABSENT = 2;

/** `git diff --quiet` answers 0 when there is nothing staged and 1 when there is. */
const NOTHING_STAGED = 0;
const CHANGES_STAGED = 1;

export const BranchStrategy = Object.freeze({
  FetchExisting: "fetch-existing",
  Orphan: "orphan",
});

export const PublicationAction = Object.freeze({
  Skip: "skip",
  CommitAndPush: "commit-and-push",
});

/** Raised when git's exit status does not map onto a decision this script may act on. */
export class UnexpectedGitStatusError extends Error {
  constructor(command, status) {
    super(`\`${command}\` returned exit ${status}, which is neither a yes nor a no; refusing to guess`);
    this.name = "UnexpectedGitStatusError";
    this.status = status;
  }
}

/**
 * Decides how to obtain the manifest branch from the remote-existence probe.
 *
 * Both the 0.2.1 and 0.3.0 releases published their prerelease and then failed
 * this push. The probe ran outside the manifest worktree, where there is no
 * `origin` to ask, and the resulting failure was read as "the branch does not
 * exist" - so a rootless history was pushed at a branch that already existed.
 * Anything that is not a clean yes or a clean no now stops the release, because
 * guessing wrong destroys the branch clients poll.
 *
 * @param {number} probeStatus exit status of `git ls-remote --exit-code`
 * @returns {string} a {@link BranchStrategy} value
 * @throws {UnexpectedGitStatusError} when the probe answered neither yes nor no
 */
export function selectBranchStrategy(probeStatus) {
  if (probeStatus === REMOTE_REF_FOUND) return BranchStrategy.FetchExisting;
  if (probeStatus === REMOTE_REF_ABSENT) return BranchStrategy.Orphan;
  throw new UnexpectedGitStatusError(`git ls-remote --exit-code origin ${MANIFEST_REF}`, probeStatus);
}

/**
 * Decides whether the staged manifest is worth a commit and a push.
 *
 * @param {number} stagedDiffStatus exit status of `git diff --cached --quiet`
 * @returns {string} a {@link PublicationAction} value
 * @throws {UnexpectedGitStatusError} when the diff answered neither yes nor no
 */
export function selectPublicationAction(stagedDiffStatus) {
  if (stagedDiffStatus === NOTHING_STAGED) return PublicationAction.Skip;
  if (stagedDiffStatus === CHANGES_STAGED) return PublicationAction.CommitAndPush;
  throw new UnexpectedGitStatusError("git diff --cached --quiet", stagedDiffStatus);
}

/** Runs git and reports its exit status, leaving the interpretation to a caller. */
function gitStatus(...args) {
  const { status, error } = spawnSync("git", args, { stdio: "inherit" });
  if (error) throw error;
  return status;
}

/** Runs git, failing the release if it does not succeed. */
function git(...args) {
  const status = gitStatus(...args);
  if (status !== 0) {
    throw new Error(`\`git ${args.join(" ")}\` failed with exit ${status}`);
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set to publish the release manifest`);
  }
  return value;
}

/** Puts the manifest branch in the worktree, whether or not the remote already has it. */
function checkOutManifestBranch(worktree) {
  const strategy = selectBranchStrategy(
    gitStatus("-C", worktree, "ls-remote", "--exit-code", "origin", MANIFEST_REF),
  );
  if (strategy === BranchStrategy.FetchExisting) {
    git("-C", worktree, "fetch", "--depth=1", "origin", MANIFEST_REF);
    git("-C", worktree, "checkout", "-b", MANIFEST_BRANCH, "FETCH_HEAD");
    return;
  }
  if (strategy === BranchStrategy.Orphan) {
    git("-C", worktree, "checkout", "--orphan", MANIFEST_BRANCH);
    return;
  }
  throw new Error(`Unhandled branch strategy: ${strategy}`);
}

export function publishReleaseManifest() {
  const worktree = join(requiredEnvironment("RUNNER_TEMP"), MANIFEST_BRANCH);
  const remote = `${requiredEnvironment("GITHUB_SERVER_URL")}/${requiredEnvironment("GITHUB_REPOSITORY")}.git`;
  const manifestSource = requiredEnvironment("RELEASE_MANIFEST");
  const releaseVersion = requiredEnvironment("RELEASE_VERSION");

  git("init", worktree);
  git("-C", worktree, "remote", "add", "origin", remote);
  checkOutManifestBranch(worktree);

  copyFileSync(manifestSource, join(worktree, MANIFEST_FILENAME));
  git("-C", worktree, "config", "user.name", COMMIT_AUTHOR_NAME);
  git("-C", worktree, "config", "user.email", COMMIT_AUTHOR_EMAIL);
  git("-C", worktree, "add", MANIFEST_FILENAME);

  const action = selectPublicationAction(gitStatus("-C", worktree, "diff", "--cached", "--quiet"));
  if (action === PublicationAction.Skip) {
    console.log(`${MANIFEST_BRANCH} already contains this manifest; nothing to publish`);
    return;
  }

  git("-C", worktree, "commit", "-m", `release: publish NeuralNote ${releaseVersion} alpha manifest`);
  git("-C", worktree, "push", "origin", `HEAD:${MANIFEST_REF}`);
}

function isEntryPoint() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isEntryPoint()) {
  try {
    publishReleaseManifest();
  } catch (error) {
    console.error(error);
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
