# Ollama Sidecar

The bundled Ollama executable is intentionally not committed. Tauri expects the
binary at `app/desktop/src-tauri/binaries/ollama-<target-triple>` and the bundle
config references it as `binaries/ollama`.

Install or refresh the macOS sidecar with:

```sh
scripts/fetch-ollama-sidecar.sh
```

Cargo tests and `cargo clippy` do not need this file. It is only required for
`npm --prefix app/desktop run tauri build` and runtime local-AI use.
