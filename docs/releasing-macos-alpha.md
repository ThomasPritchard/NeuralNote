# Releasing the macOS alpha

NeuralNote publishes Apple Silicon alpha builds through the manual
`release-macos-alpha` GitHub Actions workflow. The workflow supports two trust modes:

- `ad-hoc` is the current default. It needs no Apple Developer membership, but the build is
  unnotarized and macOS may require the user to approve it in System Settings.
- `developer-id` retains the production path for a future Developer ID Application certificate
  and Apple notarisation.

Both modes sign the updater archive with NeuralNote's Tauri updater key. That signature is mandatory
and independent of Apple's Gatekeeper trust.

The workflow cryptographically verifies the generated updater archive against
`TAURI_UPDATER_PUBLIC_KEY` before upload. The [local updater harness](local-updater-testing.md)
remains an optional end-to-end check of the installed app's download, rejection, installation, and
relaunch behaviour; it is not a release prerequisite.

## Release environment

Create or update the GitHub environment named `release`.

Both signing modes require:

- Environment secret `TAURI_SIGNING_PRIVATE_KEY`
- Environment secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- Environment variable `TAURI_UPDATER_PUBLIC_KEY`

`developer-id` additionally requires:

- Environment variable `APPLE_SIGNING_IDENTITY`
- Environment secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `KEYCHAIN_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`

Under **Deployment branches and tags**, select **Selected branches and tags** and allow the
`main` branch. Manual dispatch uses `main` as the workflow ref even though `release_tag` names
an existing tag. The workflow also rejects any dispatch whose ref is not `main`.

When another maintainer is available, add a required reviewer, prevent self-review, and disable
administrator bypass. A sole maintainer should not prevent self-review because nobody else could
approve the job. Decide whether to disable administrator bypass based on the repository's recovery
needs.

Before the first release, add an active **tag ruleset** under **Settings > Rules > Rulesets**. Target
both accepted release-tag patterns (`v*` and `[0-9]*`), enable **Restrict updates** and
**Restrict deletions**, and do not give the release operator or workflow a bypass. This prevents a
tag moving between the signed build and publication. The workflow also resolves annotated tags and
rechecks the commit immediately before draft creation and again before publication.

Under **Settings > General > Releases**, enable **release immutability** before publishing. It applies
only to future releases. The workflow follows GitHub's immutable-release order: create a draft,
attach every asset, then publish it. After publication, GitHub locks the release assets and tag.

## Prepare the tag

The workflow never creates or moves a tag. The supplied tag must already exist on GitHub and point
at the exact `main` commit selected when the workflow starts.

For the current alpha, accepted tags are `0.1.1` and `v0.1.1`. Prepare the release only after the
release changes have landed on `main`:

```bash
git switch main
git pull --ff-only
git status --short
git tag -a v0.1.1 -m "NeuralNote 0.1.1 alpha"
git push origin v0.1.1
```

Do not move a release tag. The active tag ruleset must reject the attempt. If the tag points anywhere
except the current `main` commit, the build fails; if it changes later, publication fails closed.

## Run an ad-hoc release

1. Open **Actions > release-macos-alpha > Run workflow**.
2. Keep **Use workflow from** set to `main`.
3. Enter the existing tag, normally `v0.1.1`.
4. Select `ad-hoc`.
5. Check the unnotarized-build confirmation.
6. Start the workflow and approve the `release` environment if it has a reviewer rule.

The workflow runs three stages:

1. A secret-free preflight validates the ref, tag, signing mode, and explicit acknowledgement.
2. A read-only build job runs the release gates, creates the app and DMG, signs the updater archive,
   verifies that archive against the configured updater public key, verifies the selected macOS
   signature mode, and uploads a checksum-bound artifact set.
3. A signing-secret-free publisher receives a scoped `contents: write` token, downloads and validates
   exactly those artifacts, rechecks the remote tag, creates a draft prerelease, publishes it as a
   non-latest prerelease, then updates `latest-alpha.json` last. It executes no repository code.

An ad-hoc release note states that the build is ad-hoc signed and unnotarized. Ad-hoc signing
preserves the macOS code-signing structure but does not establish an Apple-verified developer
identity or notarisation. macOS may block the downloaded app until the user allows it in
**System Settings > Privacy & Security**. Tauri updater signatures authenticate the update archive
independently; they do not satisfy Gatekeeper.

## Run a Developer ID release

Choose `developer-id` instead. The unnotarized confirmation is ignored in this mode. The workflow
fails closed if any Apple identity, certificate, keychain, or notarisation credential is missing.
It imports the certificate into a temporary keychain, builds and notarises through Tauri, requires
`codesign` and `spctl` verification, and removes the keychain even when the build fails.

## Verify publication

Before calling the release ready, confirm:

- The GitHub release is a prerelease and is not marked Latest.
- It contains one DMG, one `.app.tar.gz` updater archive, the matching `.sig`, and
  `latest-alpha.json`.
- The manifest contains `darwin-aarch64`, the expected version, a non-empty signature, and an
  HTTPS URL for the published updater archive.
- The raw `release-manifests/latest-alpha.json` URL returns the same manifest.
- An installed older NeuralNote build detects the new version and reports failures visibly.

If the build or artifact validation fails, the manifest branch is untouched. If a draft or public
prerelease already exists, rerun the failed `publish` job from the same workflow run. It downloads
the existing release assets and byte-compares them with the checksum-validated job artifact, and
requires the exact signing-mode title and notes, before resuming. Re-publishing an identical manifest
is also a successful no-op. A partially uploaded draft cannot resume safely: inspect and delete that
incomplete draft, keep the protected tag, then rerun the failed `publish` job from the same run. Do
not rerun the whole workflow for manifest-only recovery because a new build need not be byte-for-byte
reproducible. Never delete or move the existing tag merely to bypass validation.
