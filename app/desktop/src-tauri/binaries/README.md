# Ollama Sidecar

The bundled Ollama executable is intentionally not committed. Tauri expects the
binary at `app/desktop/src-tauri/binaries/ollama-<target-triple>` and the bundle
config references it as `binaries/ollama`.

Install or refresh the macOS sidecar with:

```sh
scripts/fetch-ollama-sidecar.sh
```

## These ARE needed to run the Rust suite

A workspace-wide `cargo test` or `cargo clippy` **will not run without them.** The `desktop`
crate declares the sidecars as `externalBin` and `resources` in `tauri.conf.json`, and the
Tauri build script treats a missing resource as a hard error, so the crate fails to build:

```
resource path 'binaries/ollama-aarch64-apple-darwin' doesn't exist
glob pattern ollama-libs/**/* path not found
```

`crates/neuralnote-core` builds fine on its own, which is what makes this easy to misdiagnose
as a broken change rather than a missing local artefact.

**In a fresh worktree**, copy the two binaries and symlink the (~354 MB) library directory from
your primary checkout rather than re-downloading:

```sh
cp -p <main>/app/desktop/src-tauri/binaries/{ollama,llama-server}-aarch64-apple-darwin \
      <worktree>/app/desktop/src-tauri/binaries/
ln -sfn <main>/app/desktop/src-tauri/ollama-libs <worktree>/app/desktop/src-tauri/ollama-libs
```

All three paths stay gitignored, so `git status` is unaffected. Scope Rust checks to
`-p neuralnote-core` if you would rather not install them at all.

Note `scripts/fetch-ollama-sidecar.sh` performs a download, which `AGENTS.md` gates behind the
user's approval; copying bytes already on the machine does not.
