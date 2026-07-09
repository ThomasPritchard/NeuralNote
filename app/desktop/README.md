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

Since the foundation shipped, two AI slices have landed: **cited chat** over your vault — ask a
question and get an answer grounded in your notes, with each claim citing the note and line it came
from — powered by either a **BYO OpenRouter API key** or a **bundled local Ollama model**. You pick
the provider on first run and can change it later in **Settings**.

## Develop

```sh
npm install
npm run tauri dev      # run the app with hot reload
npm run tauri build    # produce a release bundle
```

Frontend-only checks: `npm run build` (tsc + vite build). Core tests:
`cargo test -p neuralnote-core` from the repo root.
