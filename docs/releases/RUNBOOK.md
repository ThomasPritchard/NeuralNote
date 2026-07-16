# NeuralNote alpha release runbook

The operator guide for cutting a NeuralNote Apple Silicon alpha, end to end. It covers the parts
that happen on `main` before a build — version bump, the dual changelog, and the tag — then hands
off to [`releasing-macos-alpha.md`](../releasing-macos-alpha.md) for the GitHub environment setup
and the `workflow_dispatch` mechanics.

Replace `X.Y.Z` below with the release version (for example `0.2.1`). Every command assumes Node 24.

## 1. Bump the version everywhere

The release build (`release-alpha.yml` → **Validate application versions and workflow contract**)
fails closed unless `package.json`, `tauri.conf.json`, and `Cargo.toml` all equal `RELEASE_VERSION`,
and `scripts/check-release-workflow.mjs` passes. Bump all of these together in one commit:

Six version manifests:

- `app/desktop/package.json`
- `app/desktop/e2e-native/package.json`
- `app/desktop/src-tauri/tauri.conf.json`
- `app/desktop/src-tauri/Cargo.toml`
- `crates/neuralnote-core/Cargo.toml`
- `crates/neuralnote-release/Cargo.toml`

Plus:

- `Cargo.lock` — refresh the workspace-crate versions (`cargo update -p neuralnote-core -p neuralnote-release`, or `cargo build` and commit the resulting lockfile change).
- `app/desktop/src/updater/release-config.test.ts` — the validator test that pins the app-local versions; update its expected string to `X.Y.Z`.
- `.github/workflows/release-alpha.yml` — 14 version references (the `release_tag` default and description, the two `preflight`/`build` tag allow-lists, the two `RELEASE_VERSION` env values, the two manifest `notes` strings, the changelog copy path `docs/releases/vX.Y.Z.md`, the two `RELEASE_TITLE` strings, and the manifest commit message). Grep to confirm none were missed: `grep -c 'X\.Y\.Z' .github/workflows/release-alpha.yml` should report 14.

## 2. Write the dual changelog

Two files describe the same release and are cross-checked against each other by
`scripts/check-release-workflow.mjs`. Keep them in lockstep.

- `app/desktop/src/whats-new/releaseNotes.ts` — the in-app "What's new". `CURRENT_RELEASE_NOTES`
  auto-selects the entry whose key matches `package.json`'s version, so the record must contain an
  entry keyed `"X.Y.Z"` (version, title `What's new in NeuralNote X.Y.Z`, introduction, and
  `groups[]`, each with a `title` and `items[]`).
- `docs/releases/vX.Y.Z.md` — the immutable GitHub release body. The workflow copies it verbatim to
  `RELEASE_NOTES.md` and publishes it as the release description.

**The deepEqual contract.** The workflow-contract test asserts that the ordered list of `- ` bullet
lines in `vX.Y.Z.md` (with backticks stripped) is exactly equal to the ordered list of every
`items:` string in `releaseNotes.ts`. Two consequences:

- Each `.md` bullet must be byte-identical to its `.ts` item (backticks aside). Formatting a token
  as `` `.txt` `` in the `.md` is fine because the test strips backticks before comparing; the `.ts`
  item stores the plain text.
- The test greps the **whole** `releaseNotes.ts` file, not one entry. The file must therefore hold
  the current release's items only — do not leave a superseded version's entry in the record, or its
  items will appear in `bundledItems` and the comparison against the single-version `.md` will fail.

Also update the version-specific assertions the same test makes: the `# NeuralNote X.Y.Z ALPHA`
H1, the four `## ` section headings (match your group titles), and the handful of representative
substring checks. Keep the structural `deepEqual` assertion itself unchanged.

Update the two tests that mirror the shipped copy so the suite stays green:

- `app/desktop/src/whats-new/ReleaseNotesArticle.test.tsx` — expects the current title, headings,
  and representative items (keep the `CURRENT_RELEASE_NOTES.version === packageJson.version` check).
- `app/desktop/src/App.test.tsx` — the "What's new" modal title and the version persisted on
  dismiss both track the current version.

Verify before committing:

```bash
node scripts/check-release-workflow.mjs
npm --prefix app/desktop run test:run
npm --prefix app/desktop run typecheck
npm --prefix app/desktop run lint
```

Land the version bump and changelog on `main` (via the normal PR flow) before touching the tag.

## 3. Create and push the tag

The workflow never creates or moves a tag; the tag must already exist and point at the exact `main`
commit selected when the dispatch runs. The accepted patterns are `X.Y.Z` and `vX.Y.Z`.

```bash
git switch main
git pull --ff-only
git status --short          # clean, and HEAD is the release commit
git tag -a vX.Y.Z -m "NeuralNote X.Y.Z alpha"
git push origin vX.Y.Z
```

Never move a release tag. A protecting tag ruleset should reject the attempt; if the tag points
anywhere except the current `main` commit the build fails, and if it moves after the signed build the
publish job fails closed.

## 4. Dispatch the release build

Run **Actions → release-macos-alpha → Run workflow** with **Use workflow from** set to `main`. Inputs:

- `release_tag` — the existing tag, normally `vX.Y.Z`.
- `signing_mode` — `ad-hoc` (default; no Apple membership, unnotarized) or `developer-id` (Apple
  Developer ID signed and notarized).
- `confirm_unnotarized` — required `true` for `ad-hoc`; ignored for `developer-id`.

See [`releasing-macos-alpha.md`](../releasing-macos-alpha.md) for the `release` environment secrets,
branch/tag protections, and release-immutability settings this dispatch depends on.

## 5. What the workflow does, and the security design

Three least-privilege stages run with a top-level `contents: read` token:

1. **preflight** — a secret-free check of the ref, tag pattern, signing mode, and the unnotarized
   acknowledgement. It rejects any dispatch whose ref is not `main`.
2. **build** — runs the full release gates (lint, typecheck, coverage, build, bindings drift,
   dependency audits, `cargo test --workspace`, `rust-quality-gate.sh`), verifies the app versions
   against `RELEASE_VERSION`, builds and signs the app and DMG, signs the updater archive with the
   Tauri updater key and verifies it against `TAURI_UPDATER_PUBLIC_KEY`, checks the macOS signature
   mode, and uploads a checksum-bound (`SHA256SUMS`) artifact set. It holds no repository write token.
3. **publish** — a signing-secret-free job that receives a scoped `contents: write` token only after
   the artifacts exist. It re-validates the downloaded artifacts against the checksums, re-resolves
   the remote tag and confirms it still points at the commit the build signed
   (`REMOTE_TAG_SHA == RELEASE_SHA`), creates a **draft** prerelease, attaches every asset, publishes
   it as a non-latest prerelease, confirms the release is immutable, and only then publishes the
   auto-update manifest.

Key guarantees to preserve when editing the workflow:

- The build job runs repository code but never has write access; the publish job has write access but
  executes no repository code.
- The tag is re-checked immediately before draft creation and again before publication, so a tag that
  moves between signing and publishing fails closed.
- The updater manifest (`latest-alpha.json`, on the dedicated `release-manifests` branch) is written
  **last** — clients never see a manifest until the signed artifact, the checksum-validated transfer,
  and the public immutable prerelease all exist. That branch is what installed apps poll for updates.

## 6. Verify publication

Confirm the release is a non-latest prerelease containing one DMG, one `.app.tar.gz`, its `.sig`, and
`latest-alpha.json`; that the manifest carries `darwin-aarch64`, the expected version, a non-empty
signature, and an HTTPS updater URL; that the raw `release-manifests/latest-alpha.json` returns the
same manifest; and that an installed older build detects the update and surfaces any failure visibly.
The recovery and resume procedures (partial draft, manifest-only re-run) live in
[`releasing-macos-alpha.md`](../releasing-macos-alpha.md).
