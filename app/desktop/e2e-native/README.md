# Native Tauri end-to-end tests

This tier drives the real NeuralNote Rust backend, system webview, filesystem,
watcher, persistence, window and native-menu boundaries. It uses WebdriverIO's
[embedded Tauri provider] rather than the standalone `tauri-driver` harness, so
the same suite runs on Linux, macOS and Windows.

Ubuntu and macOS are required pull-request gates. Windows runs only on `main` or
manual dispatch and remains informational until issue #78 is resolved.

## Run locally

Use the repository-supported Node and Rust toolchains, then install both locked
dependency trees:

```bash
npm --prefix app/desktop ci
npm --prefix app/desktop/e2e-native ci
npm --prefix app/desktop/e2e-native test
```

Linux also needs the Tauri GTK/WebKit packages and a display. CI runs the suite
under `xvfb-run`; macOS needs no external WebDriver installation.

The wrapper type-checks and tests the harness, builds one debug/no-bundle app
with `--features native-e2e`, then runs every native spec serially. A failed app
or driver startup may be retried once only before the first-test readiness
sentinel. Test failures are never retried.

## Isolation and security

- The E2E build uses `com.neuralnote.desktop.e2e` and the test-only
  `native-e2e` capability.
- Rust automation plugins are optional exact `1.2.0` dependencies. Production
  config allows only `default`, and a release-profile `native-e2e` build fails
  at compile time.
- The E2E frontend also exposes a minimal bridge for bounded CodeMirror mutations
  and the fixed close-vault menu event because embedded WKWebView does not
  deliver those WebDriver inputs reliably. On macOS, a separate no-argument,
  feature-gated command dispatches one fixed Command-S event through the active
  AppKit window and native Tauri menu key equivalent. Linux does not relabel
  WebDriver's webview key events as native accelerator coverage.
  Production bundle scanning rejects both that bridge and the WebdriverIO
  bootstrap; browser-engine suites retain responsibility for keyboard input.
- Each attempt creates an owner-only, marked root directly under the process
  temporary directory. `NEURALNOTE_E2E_ROOT` redirects only app config; `HOME`
  is inherited unchanged.
- Cleanup revalidates the exact root and session marker and runs only after the
  embedded service returns and the app has exited.
- Failure page source and screenshots hide editable contents; logs and metadata
  redact the temporary root and credential-shaped values. CI uploads only this
  artifact directory, never the temporary vault.

## Coverage

The specs cover startup and a pre-authorised recent vault; direct IPC authority;
real watcher shutdown; create/edit/save/rename/move and persistence; stale-save,
external-delete and oversized-file handling; workspace restoration; exact
Markdown, CRLF and mixed-ending fidelity; inert image/embed markup; native save
accelerators and dirty-close guards; and macOS fullscreen/titlebar behaviour.

The Markdown fixture is synthetic and version-controlled in
`native-fixtures.ts`. Opening and closing it must not write; a local edit must
leave every untouched byte unchanged.

## Layout

| File | Responsibility |
| --- | --- |
| `run-native.ts` | Build-once runner, isolated attempts, readiness-only retry and cleanup. |
| `native-root.ts` | Marked temporary-root lifecycle and environment isolation. |
| `native-fixtures.ts` | Exact synthetic vault, Markdown and line-ending fixtures. |
| `native-artifacts.ts` | Redacted page source, screenshot, logs and fixture metadata. |
| `wdio.conf.ts` | Serial embedded-provider WebdriverIO configuration. |
| `tauri.e2e.conf.json` | E2E identity, capability and bundle overlay. |
| `specs/` | Small native journeys grouped by boundary. |

The debug binary is the workspace target `target/debug/desktop` (`desktop.exe`
on Windows). If Tauri's binary name changes, update the path in `wdio.conf.ts`.

[embedded Tauri provider]: https://webdriver.io/docs/desktop-testing/tauri/plugin-setup/
[Tauri WebDriver guidance]: https://v2.tauri.app/develop/tests/webdriver/
