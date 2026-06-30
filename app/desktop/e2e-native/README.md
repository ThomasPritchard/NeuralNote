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
| `wdio.conf.ts` | WebdriverIO config: `browserName: "wry"` + `tauri:options.application` pointing at the debug binary; spawns/stops `tauri-driver`; builds the app in `onPrepare`. |
| `specs/smoke.spec.ts` | Smoke test: the window boots and the welcome brand heading + vault entry points are visible. |

### Binary name

`wdio.conf.ts` points at `../src-tauri/target/debug/desktop` (`.exe` on Windows).
`mainBinaryName` is unset in `tauri.conf.json`, so the binary keeps the Cargo crate
name (`desktop`), not the `productName` (`NeuralNote`). If a `mainBinaryName` is added
to the Tauri config later, update `BINARY_NAME` in `wdio.conf.ts` to match.

[WebdriverIO]: https://webdriver.io
[`tauri-driver`]: https://v2.tauri.app/develop/tests/webdriver/
