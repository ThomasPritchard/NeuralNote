# NeuralNote — desktop

The Tauri 2 desktop client for NeuralNote. It's the thin shell over the
client-agnostic Rust core (`crates/neuralnote-core`): open or create a vault,
browse the file tree, read rendered markdown, edit and save, and do file/folder
CRUD — all vault-scoped, with deletes going to the OS trash and saves written
atomically.

## Layout

- `src/` — React 19 + Vite + Tailwind frontend (welcome screen + workspace),
  talking to the backend through a thin `invoke` data layer (`src/lib/api.ts`).
- `src-tauri/` — the Tauri shell: wraps the core crate in commands, holds the
  open-vault session + filesystem watcher, and bridges the native folder picker.

All filesystem logic and path safety live in `crates/neuralnote-core`; this app
only wires it to the webview.

## Develop

```sh
npm install
npm run tauri dev      # run the app with hot reload
npm run tauri build    # produce a release bundle
```

Frontend-only checks: `npm run build` (tsc + vite build). Core tests:
`cargo test -p neuralnote-core` from the repo root.
