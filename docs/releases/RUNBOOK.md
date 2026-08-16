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

- `Cargo.lock` — refresh the workspace-crate versions with `cargo update --workspace`. It should report exactly three packages moved (`desktop`, `neuralnote-core`, `neuralnote-release`) and touch nothing else; anything more means a dependency drifted and belongs in its own commit.
- `app/desktop/package-lock.json` and `app/desktop/e2e-native/package-lock.json` — the root `"version"` on **lines 3 and 9 only** (two slots each: the top-level field and the `""` self-entry). Do not replace globally: `e2e-native/package-lock.json` also pins unrelated dependencies that happen to sit at the old version number.
- `app/desktop/src/updater/release-config.test.ts` — the validator test that pins the app-local versions; update its expected strings to `X.Y.Z`. **One of them is a regex** (`/^version = "X\.Y\.Z"$/m`) — see the escaping warning below.
- `app/desktop/src/whats-new/ReleaseNotesArticle.test.tsx` and `app/desktop/src/App.test.tsx` — both name the version in test titles and in the "What's new" modal heading they assert (three occurrences each).
- `scripts/check-release-workflow.mjs` — the contract test hard-codes the release version itself: `releaseVersion`, the `release_tag` default assertion, the changelog path (twice), the `# NeuralNote X.Y.Z ALPHA` heading assertion, and the test's own name. Bumping the workflow without bumping its checker leaves the gate asserting the previous release. **Four of these are regexes.**

  It also pins **content, not just the version**: the five `## ` section headings of the changelog and one distinctive phrase from each section (`assert.match(releaseNotes, /…/)`). Those exist so the published GitHub body cannot silently become a stub or the wrong file, and since every release invents its own section titles they must be re-pointed at the new changelog by hand. Choose phrases specific to this release — a generic one that would match any release retires the check while appearing to keep it.

**Version literals hide inside regexes.** Five of the slots above store the version *escaped* — `0\.4\.0`, not `0.4.0`. A find-and-replace for the plain string does not touch them, and neither does the `grep -c 'X\.Y\.Z'` verification below, because `\.` in that pattern matches a literal dot and not a backslash. Following this checklist exactly and verifying exactly as instructed still leaves the release red. Sweep **both spellings**, then confirm neither remains:

```bash
grep -rn 'A\.B\.C\|A\\\.B\\\.C' scripts/ .github/workflows/ app/desktop/src/updater/ \
  app/desktop/src/whats-new/ app/desktop/src/App.test.tsx    # A.B.C = the OLD version; expect no output
```
- `.github/workflows/release-alpha.yml` — **13 lines** carrying 17 occurrences (four of the lines name the version twice): the `release_tag` description and default, the two `preflight`/`build` tag allow-lists (two lines each), the two `RELEASE_VERSION` env values, the two updater-manifest `notes` strings, the changelog copy path `docs/releases/vX.Y.Z.md`, and the two `RELEASE_TITLE` strings. The line count is what the `grep -c` below reports; the occurrence count is not.

  **This was 14 until the manifest publisher was extracted.** The fourteenth line was the manifest commit message, which now lives in `scripts/publish-release-manifest.mjs` and does not name the version at all. Nothing else moved. If the count drifts again, find out which line left before changing the number — the count exists to catch a missed bump, and quietly re-fitting it to whatever `grep` currently reports would retire the check while appearing to maintain it.

  Five of these are guarded by nothing — the two `RELEASE_TITLE` strings and the two manifest `notes` strings reach immutable published output, and a missed bump there publishes a correct build under the *previous* version's title or update note with every gate still green. Tracked in #145; until it is fixed, check those four lines by eye.

**Do not bulk-replace the old version string.** Three places name a previous version on purpose and must survive the bump:

- `.github/workflows/release-alpha.yml` and `scripts/check-release-workflow.mjs` each carry a comment recording that the 0.2.1 and 0.3.0 releases both published and then failed their manifest push. That is the evidence for the `git -C` fix; rewriting it destroys the record.
- `docs/security/dependency-advisories.md` names `urlpattern 0.3.0`, a third-party crate version.

So verify by counting the *new* string rather than searching for leftovers of the old one: `grep -c 'X\.Y\.Z' .github/workflows/release-alpha.yml` should report **13**, and a single `0.3.0` hit remaining in that file is correct.

## 2. Write the dual changelog

Two files describe the same release. **Write only one of them.**

- `docs/releases/vX.Y.Z.md` — **the source you edit.** It is the immutable GitHub release body; the
  workflow copies it verbatim to `RELEASE_NOTES.md` and publishes it as the release description.
- `app/desktop/src/whats-new/releaseNotes.ts` — the in-app "What's new", **generated** from that
  `.md`. Never hand-edit it.

```bash
npm --prefix app/desktop run gen:release-notes    # write the .ts from the .md
npm --prefix app/desktop run check:release-notes  # verify it is current (exit 1 on drift)
```

The generator reads the version from `app/desktop/package.json`, so run it *after* step 1.

**Why it is generated.** `scripts/check-release-workflow.mjs` asserts the ordered list of `- `
bullet lines in the `.md` (backticks stripped) is `deepEqual` to the ordered list of every `items:`
string in the `.ts`. Hand-maintaining both means drift is merely *detected*, at whatever point
someone runs the gate; generating one from the other means there is a single place to edit and
drift cannot exist. It also disposes of the old trap where a superseded release's entry left behind
in the record put its items into the comparison and failed the release: the `.md` holds one release,
so the generated `.ts` can only hold one.

Write the `.md` to the house style: an H1 `# NeuralNote X.Y.Z ALPHA`, one introduction paragraph,
then `## ` sections of `- ` bullets. Each bullet is one plain-English sentence describing something
a *user* can observe. Keep `Application packages, updater checks, and the upgrade journey are
aligned on version X.Y.Z.` as the last bullet of the last section.

Then update the version-specific assertions in `scripts/check-release-workflow.mjs`: the
`# NeuralNote X.Y.Z ALPHA` H1, the list of `## ` section headings (match your section titles), and
the handful of representative substring checks. Keep the structural `deepEqual` assertion unchanged.

> Pick representative substrings that appear in **exactly one** place. The introduction paraphrases
> every section, so a phrase it shares with a bullet matches twice — harmless in the `.md` checker,
> but `getByText` in the article test throws on the ambiguity and the failure reads as absence.

Update the two tests that mirror the shipped copy:

- `app/desktop/src/whats-new/ReleaseNotesArticle.test.tsx` — the current title, the section
  headings, and the representative items. It also asserts `Object.keys(RELEASE_NOTES)` equals the
  built version, which is the check that a superseded entry is gone. Do **not** replace that with a
  `queryByText` for the previous release's prose: the article renders only `CURRENT_RELEASE_NOTES`,
  so a stale entry is never in the DOM and such an assertion passes whether or not the entry exists.
  For the same reason `CURRENT_RELEASE_NOTES.version === packageJson.version` is self-referential —
  the record is looked up *by* that version — and proves nothing about the release version. The real
  version guards are `release-config.test.ts` and the hardcoded titles.
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
