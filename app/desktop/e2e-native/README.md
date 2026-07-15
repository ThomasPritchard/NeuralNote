# Tier-2 native WebDriver tests (CI only)

These tests drive the **real** NeuralNote desktop window — the actual Rust backend
behind the actual system webview — using [WebdriverIO] + [`tauri-driver`].

## This tier does NOT run on macOS

`tauri-driver` proxies to the platform's native WebView WebDriver:

- **Linux** → `WebKitWebDriver` (package `webkit2gtk-driver`)
- **Windows** → the Edge WebView2 driver (`msedgedriver`)
- **macOS** → **not supported.** There is no WebDriver for the macOS WKWebView, so
  `tauri-driver` officially supports Linux and Windows only.

So you **cannot run this suite on a Mac.** It exists purely for **Linux/Windows CI**
(`.github/workflows/e2e.yml`, `ubuntu-latest` + `windows-latest`).

### What to run locally instead

Use the **Tier-1 mockIPC suite**, which runs the real `<App/>` in jsdom over a
stateful in-memory vault driven through the genuine Tauri IPC boundary — it runs and
passes on macOS:

```bash
cd app/desktop
npm run test:e2e        # full-journey e2e (src/e2e/*.e2e.test.tsx)
npm run test:run        # the whole unit + e2e suite
```

## Running this tier (Linux / Windows)

```bash
# 1. tauri-driver (one-time)
cargo install tauri-driver --locked

# 2. system WebView driver
#    Linux (Debian/Ubuntu):
sudo apt-get install -y webkit2gtk-driver xvfb
#    Windows: msedgedriver matching your WebView2 runtime, on PATH

# 3. deps
cd app/desktop && npm ci
cd e2e-native && npm ci

# 4. run (the wdio onPrepare hook builds `tauri build --debug --no-bundle` first)
npm test                # Windows
xvfb-run npm test       # Linux (headless display)
```

## Layout

| File | Purpose |
| --- | --- |
| `wdio-build.ts` | Cross-platform, no-shell Tauri build invocation and explicit build-result validation. |
| `wdio.conf.ts` | WebdriverIO config: `tauri:options.application` pointing at the debug binary; spawns/stops `tauri-driver`; builds the app in `onPrepare`. |
| `tauri.e2e.conf.json` | Build overlay that removes the Ollama sidecars and resources; the smoke test does not exercise local AI. |
| `specs/smoke.spec.ts` | Smoke test: the window boots and the welcome brand heading + vault entry points are visible. |

### Binary name

`wdio.conf.ts` points at the workspace-level `../../../target/debug/desktop` (`.exe`
on Windows), because Cargo builds every workspace member into the root target directory.
`mainBinaryName` is unset in `tauri.conf.json`, so the binary keeps the Cargo crate
name (`desktop`), not the `productName` (`NeuralNote`). If a `mainBinaryName` is added
to the Tauri config later, update `BINARY_NAME` in `wdio.conf.ts` to match.

## Dependency hygiene

The `@wdio/*` stack is already pinned to the latest published line (`9.29.1`), so the
deprecated packages that surface in this tree are all transitive and upstream-owned.
`package.json` (`overrides`) is the only lever we have; comments can't live in JSON, so
the rationale lives here.

**Removed** via `overrides.mocha = "^11.7.6"` (mocha ships as a `@wdio/mocha-framework`
dependency, not a direct dep, so the override is how we advance it):

- `glob@8` (< 9 — the version class carrying the publicised ReDoS/security advisories).
- `inflight@1.0.6` (the memory-leaking request-coalescer). Both arrived through
  `mocha@10 → glob@8 → inflight`. mocha 11 uses `glob@10`, which dropped `inflight`
  entirely. `@wdio/mocha-framework@9.29.1` declares `mocha@^10.3.0`, but the adapter only
  touches mocha's stable programmatic API (`new Mocha`, `addFile`, `loadFilesAsync`,
  `run`, `suite`, `unloadFiles`, `reporter`, `options`, `fullTrace`) — all unchanged in
  mocha 11 — so the override is safe. `@types/mocha` stays at `^10` because no `@types/mocha@11`
  is published and mocha's test-authoring API is unchanged.

**Upstream blockers** (left in place deliberately — no safe local fix):

- `glob@10.5.0` — the maintainer blanket-deprecates every non-latest major, but `glob@10`
  is modern: no `inflight`, not the < 9 vulnerability class. It's pinned by `@wdio/config`
  (`^10.2.2`), `archiver-utils` (`^10.0.0`), and mocha 11 (`^10.4.5`). Forcing `glob@13`
  (the only non-deprecated line) would rewrite the spec-glob resolver `@wdio/config` uses
  to expand `specs: ["./specs/**/*.spec.ts"]` and archiver's file walk — runtime paths
  that only execute in the Linux/Windows wdio run and can't be validated on macOS.
  Removal waits on WebdriverIO adopting `glob@11+` upstream (WDIO v10).
- `whatwg-encoding@3.1.1` — the *latest* published version is itself deprecated (points to
  `@exodus/bytes`), so there is no non-deprecated version to override to. Chain:
  `webdriverio → cheerio → encoding-sniffer → whatwg-encoding`. Removal waits on
  `encoding-sniffer`/`cheerio` migrating off it.

Re-check on any `@wdio/*` bump: `npm install` and confirm the warning set with
`npm ls glob inflight whatwg-encoding`.

[WebdriverIO]: https://webdriver.io
[`tauri-driver`]: https://v2.tauri.app/develop/tests/webdriver/
