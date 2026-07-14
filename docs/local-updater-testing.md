# Local updater testing without an Apple Developer membership

The local updater harness proves NeuralNote's real Tauri update path without publishing a release,
changing the production endpoint, or requiring a paid Apple Developer account. It builds an isolated
`NeuralNote Updater Harness` app at `0.1.1`, signs a `0.2.0` updater archive with the configured
Tauri updater key, and serves it only from `127.0.0.1`.

This harness is a recommended one-time preflight, not a prerequisite for a GitHub release. Production
publication is documented in [Releasing the macOS alpha](releasing-macos-alpha.md).

This tests the Tauri signing-key pair, manifest, download, signature verification, installation, and
relaunch flow. It does **not** test Developer ID signing, notarisation, Gatekeeper behaviour for an app
downloaded in a browser, or GitHub Release publication.

## Safety model

- The harness has a separate bundle identifier and therefore separate app preferences from NeuralNote.
- Every run uses a new directory below the ignored `target/local-updater/` tree and a private Cargo
  target directory. It never reuses normal release artifacts.
- Plain HTTP is enabled only in generated config overlays whose endpoint is exactly `127.0.0.1`.
  The production `tauri.conf.json` remains HTTPS-only.
- The server exposes only `latest-alpha.json` and the update archive. It does not serve config files,
  signatures, directory listings, dotfiles, or key paths.
- The private key must be a current-user-owned, non-symlink regular file with mode `0600`. The harness
  passes its path directly to Tauri and never reads, copies, or prints the key.

## Prerequisites

- macOS on Apple Silicon or Intel.
- Node 24 LTS (preferred) or Node 22.12 or newer within the Node 22 LTS line.
- Rust 1.96 and the macOS target for the current machine.
- The updater key pair generated with Tauri. The expected local paths in this checkout are:
  `~/.tauri/neuralnote-updater.key` and `~/.tauri/neuralnote-updater.key.pub`.

Confirm the private key permissions without displaying its contents:

```bash
chmod 600 "$HOME/.tauri/neuralnote-updater.key"
```

## 1. Prepare both journeys

Use a hidden zsh prompt so the password does not appear in shell history. The password variable must
be explicitly present; an empty value is supported only for a deliberately passwordless key.

```zsh
read -s "TAURI_SIGNING_PRIVATE_KEY_PASSWORD?Tauri updater key password: "
echo
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD

npm --prefix app/desktop run updater:local -- prepare \
  --public-key-file "$HOME/.tauri/neuralnote-updater.key.pub" \
  --private-key-file "$HOME/.tauri/neuralnote-updater.key"

unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Preparation builds twice and prints a unique absolute session path plus the next commands. Keep that
path; the examples below call it `<session>`.

## 2. Prove a tampered update cannot install

```bash
npm --prefix app/desktop run updater:local -- serve \
  --session '<session>' \
  --mode invalid
```

In the opened harness app, use **Settings → General → Check for updates**, review `0.2.0`, and attempt
the install. This journey serves an archive with exactly one changed byte while retaining the genuine
signature, so Tauri must reject it during cryptographic verification. The failure must be visible.
Stop the server with `Ctrl+C`, then verify that the app remains at `0.1.1`:

```bash
npm --prefix app/desktop run updater:local -- verify \
  --session '<session>' \
  --mode invalid
```

Fully quit this harness app before starting the valid journey. The script also uses `open -n` to
request a fresh macOS application instance, but keeping two copies open makes the result needlessly
ambiguous.

## 3. Prove the valid update installs

```bash
npm --prefix app/desktop run updater:local -- serve \
  --session '<session>' \
  --mode valid
```

Repeat the check, review, install, and relaunch flow. Stop the server after relaunch, then verify the
independent valid app copy is now `0.2.0`:

```bash
npm --prefix app/desktop run updater:local -- verify \
  --session '<session>' \
  --mode valid
```

Both proofs are required. A successful valid update shows that the public key embedded in the app
matches the private key used by the build. A rejected tampered archive, checked against that same
genuine signature, shows that changed downloaded bytes cannot bypass Tauri's verification.

## Troubleshooting

- **Unsupported Node version:** switch to Node 24 LTS. The harness intentionally refuses Node 26.
- **Port already in use:** rerun `prepare` with `--port <1024-65535>`. Use the same generated session
  for `serve`; its port is stored in the session metadata.
- **Key mode is not 0600:** run the `chmod` command above. Do not loosen the harness check.
- **The update is not found:** keep the server running, confirm the harness app (not normal NeuralNote)
  is open, then use the manual check in Settings.
- **Gatekeeper warning:** ad-hoc signing preserves the macOS code-signing structure but does not
  establish an Apple-verified developer identity or notarisation. macOS may require approval in
  **System Settings > Privacy & Security**. The updater signature does not satisfy Gatekeeper.

Generated sessions may be deleted manually after testing. Do not copy generated overlays or enable
`dangerousInsecureTransportProtocol` in the production Tauri configuration.
