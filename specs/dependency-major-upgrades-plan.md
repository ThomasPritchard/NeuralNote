# Dependency major upgrades — analysis and plan

> Status: **steps 1-3 executed in PR #107; steps 4-6 remain**. Written 2026-08-10.
>
> Done: `@testing-library/jest-dom` 7.0.1, `@vitejs/plugin-react` 5.2.0 with `resolve.dedupe`
> made explicit in all three configs, and `@wdio/tauri-*` 1.3.0 across all four coordinates
> (including the `@wdio/native-utils` override that would otherwise have silently downgraded it).
> Outstanding: **Vite 8**, then `@vitejs/plugin-react` 6, and **jsdom 30** once 30.0.2 ships.
>
> All version, engine, and peer-range claims below were verified against the npm registry and
> crates.io at the time of writing, not asserted from memory. Re-check before executing — the
> jsdom recommendation in particular is expected to change within weeks.

## Where things stand

After PR #107 there are **zero** outstanding vulnerabilities and **zero** in-range updates left in
either npm project or the Cargo workspace. Every remaining item is a deliberate semver decision.

| Package | Current | Latest | Verdict | Effort |
| --- | --- | --- | --- | --- |
| `@testing-library/jest-dom` | ~~6.9.1~~ 7.0.1 | 7.0.1 | ✅ **Done** | ~10 min |
| `@vitejs/plugin-react` | ~~4.7.0~~ 5.2.0 | 5.2.0 (interim) | ✅ **Done** | ~15 min |
| `@wdio/tauri-plugin` / `-service` (+ Rust crates) | ~~1.2.0~~ 1.3.0 | 1.3.0 | ✅ **Done** | ~half day |
| `vite` | 7.3.6 | 8.2.1 | **Schedule** | 4–8 h |
| `@vitejs/plugin-react` | 5.2.0 | 6.0.5 | **With Vite 8** | in the above |
| `jsdom` | 29.1.1 | 30.0.1 | **Wait for 30.0.2** | blocked |

Two smaller items that are not majors but are worth a decision, at the end: the `@codemirror/*`
exact pins, and the TypeScript version split between the two npm projects.

---

## 1. `@testing-library/jest-dom` 6.9.1 → 7.0.1 — take now

The v7 major contains **exactly two changes, both packaging metadata**: `engines.node` moves to
`>=22`, and `@testing-library/dom >=10 <11` becomes a required peer. Both are already satisfied
(`engines` is `^22.12.0 || ^24.0.0`; `@testing-library/dom` is a direct devDependency at `^10.4.1`).

No matcher was removed, renamed, or changed. The matcher set goes 33 → 49 and the diff of
`src/matchers.js` across the major is purely additive; `toBeVisible`, `toHaveStyle`,
`toHaveTextContent`, `toBeInTheDocument` and `toHaveAccessibleName` are byte-identical. The
`./vitest` subpath export and its type definitions are byte-identical too, so
`src/test/setup.ts` and the `types` entry in `tsconfig.json` need no edit.

7.0.1 additionally makes `vitest` an *optional* peer, which is a fix in our favour.

**Do:** bump `app/desktop/package.json`, `npm install`, run `test:run`. No code changes.

## 2. `@vitejs/plugin-react` 4.7.0 → 5.2.0 — take now, and it is the key to sequencing

`@vitejs/plugin-react` 4.x peers `vite: ^4.2.0 || ^5 || ^6 || ^7` — no `^8`, so it cannot stay
across a Vite 8 upgrade. v6 peers `vite: ^8.0.0` **only**, so it cannot come early.

The useful fact is that **5.2.0 spans both**:

```
5.1.4  vite: ^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0
5.2.0  vite: ^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0   <- takes us across
6.0.5  vite: ^8.0.0
```

That makes 5.2.0 a free decoupling step: absorb the v5 breaking changes now, on Vite 7, so that if
something breaks we know it was the plugin and not the bundler. (Note `5.1.4` does *not* span Vite 8
— the exact patch matters here.)

**v5 breaking changes:** Oxc used for the refresh transform under rolldown-vite;
`disableOxcRecommendation` removed; development JSX transform used for `NODE_ENV=development`
builds; default `exclude` becomes `[/\/node_modules\//]`; old `babel-plugin-react-compiler` support
removed; Node 20.19+/22.12+. **The one that matters here:** `react` and `react-dom` are **no longer
added to `resolve.dedupe` automatically**.

That last one is a live hazard. The comment at `vitest.browser.config.ts:27-33` exists specifically
to stop Vite loading a second React when the force-graph specs pull in `three`. Today that dedupe
comes free from plugin-react 4.x.

**Do:** bump to `^5.2.0`, **and in the same change add `resolve.dedupe: ["react", "react-dom"]`
explicitly to `vite.config.ts`, `vitest.config.ts`, and `vitest.browser.config.ts`.** On 5.2.0 that
addition is a provable no-op, which is exactly what makes the later Vite 8 step safe.

All three configs call `react()` bare with no options, so nothing else moves.

## 3. `@wdio/tauri-*` 1.2.0 → 1.3.0 — take, but in its own commit

Not a major, but it is exact-pinned on **four** coordinates that must move together, and it carries
a trap.

There is no changelog or GitHub release for 1.3.0; the content below is reconstructed from the
83-commit compare between the release tags and from diffs of the published artifacts. The npm
package's shipped `dist-js` is byte-identical between versions — the real change is entirely in the
Rust crates.

**It is purely additive at the API surface.** `types.d.ts` and `index.d.ts` are byte-identical; the
only additions are an `afterCommand` hook and three window helpers.

**Two changes land on paths we use.** `wdio.conf.ts:83` calls `browser.switchToWindow("main")`
deliberately raw, to avoid granting `list-windows` authority. PR #560 adds an `afterCommand` hook
that suppresses focus recovery after exactly that raw call — upstream's own note says otherwise
"the next getTitle/$/elementClick silently switches the user back". This should *help*
`40-window.spec.ts`, but it is a runtime semantics change. Separately, ~300 lines of macOS 26.4 /
WebKit DirectEval hardening land in `platform/macos.rs` plus a new `eval_channel.rs`. None of it is
API-visible, but it changes the WKWebView execution path our native tier runs on — and this repo has
already shipped one WKWebView-specific bug (58a1664), so run the native tier several times, not once.

**The trap:** `app/desktop/e2e-native/package.json` pins `overrides: { "@wdio/native-utils": "2.5.0" }`.
`@wdio/tauri-service@1.3.0` depends on `@wdio/native-utils` at exactly **2.6.0**. Left alone, that
override silently downgrades it and we run the new service against the old utils. **Bump the
override to `2.6.0` in the same change.**

**npm ↔ Rust coupling.** Both 1.3.0 crates exist on crates.io, published the same second as the npm
packages, and the release tooling versions them as one group. Version parity has held across the
entire history. Upstream documents no matching requirement, so this is a strong inference rather
than a stated guarantee — which is precisely why the existing `=1.3.0` exact pins should stay.

No WebdriverIO major is needed (`webdriverio: ^9.0.0` peer is unchanged), and there is no MSRV or
Tauri version change on the Rust side.

**Files:** `e2e-native/package.json` (both deps + the override), `e2e-native/package-contract.test.ts:11-13`
(hardcoded `"1.2.0"` ×2 and `"2.5.0"` assertions will fail otherwise), `app/desktop/package.json:82`,
`app/desktop/src-tauri/Cargo.toml:73-74`, and all three lockfiles. Also read
`production-dependencies.test.ts:15`, which carries a `v1.2.0` string that may be an unrelated fixture.

## 4. `vite` 7.3.6 → 8.2.1 — schedule it, do not drive-by

Vite 8 replaces Rollup **and** esbuild with Rolldown plus Oxc. It shipped 2026-03-12; 8.2.1 is five
months and two minors past that, with the worst early regressions closed.

**The config surface is clean.** `vite.config.ts` has no `build` block at all — plugins, alias, and
Tauri dev-server settings only. Every renamed or removed option (`rollupOptions` → `rolldownOptions`,
`esbuild` → `oxc`, `manualChunks`, `commonjsOptions`, `transformWithEsbuild`,
`optimizeDeps.esbuildOptions`, `customResolver`) has **zero** occurrences in the repo. The raised
browser targets are irrelevant to a WKWebView-only desktop app.

**Node does not move.** Vite 8's engines are `^20.19.0 || >=22.12.0`, byte-identical to Vite 7's.

**Vitest does not move either.** `vitest@4.1.10` peers `vite: ^6.0.0 || ^7.0.0 || ^8.0.0`, and 4.1
is the release that *added* Vite 8 support. `@vitest/coverage-v8` and `@vitest/browser` carry no
Vite constraint. Do **not** move to Vitest 5 — it is beta only.

`@tailwindcss/vite` already peers `^5.2.0 || ^6 || ^7 || ^8`. No change.

So the exposure is entirely to **changed defaults**, and it concentrates in the two safety nets that
matter most here:

**(a) The production-bundle assertion depends on dead-code elimination.** `src/main.tsx:13` gates two
dynamic imports behind `import.meta.env.VITE_NEURALNOTE_NATIVE_E2E === "1"`, and
`scripts/assert-production-bundle.mjs` fails the build if `wdioTauri` or
`NEURALNOTE_NATIVE_E2E_BRIDGE_V1` appear in any emitted asset. That holds only because Rollup folds
the comparison to `false` and drops both imports without emitting an orphan lazy chunk. Rolldown's
DCE is a different implementation, and the migration guide explicitly flags changed `define`
handling. **This cannot be verified from documentation — only by running the build.** It is the
single most important check, and `npm run build` and `npm run build:native-e2e` assert in opposite
directions, so run both early.

**(b) CSS minification silently becomes Lightning CSS.** No `cssMinify` is set, so the default is
inherited. Tailwind v4 already compiles through Lightning CSS so the risk is low, but emitted CSS
*will* differ — and `vitest.browser.config.ts` is full of geometry assertions (text advance
measurement, header font weight, reduced-motion) that were expensive to tune. That suite across
Chromium and WebKit is the largest untested surface. `build.cssMinify: 'esbuild'` restores Vite 7
behaviour if needed.

One unresolved conflict in the research worth flagging: one source reported that Vite 8's
lightningcss minification drops unprefixed `backdrop-filter` when a `-webkit-` twin is present
(vitejs/vite#22649, closed 2026-06-10, but it could not be confirmed whether it was *fixed* or closed
in favour of the workaround). `backdrop-blur` is used in 6 places, including `components/ui/dialog.tsx`.
Inspect the built CSS for those surfaces.

**Payoff is thin.** Rolldown's headline is 10–30× faster builds on large apps; this is a single
un-tuned bundle. Expect a pleasant build-time drop, not a solved problem. If an alpha cut is near,
defer — 7.3.6 is the `previous` dist-tag, fully patched and supported.

## 5. `jsdom` 29.1.1 → 30.0.1 — wait for 30.0.2

**Do not take this yet.** Two independent blockers.

**Engines conflict.** jsdom 30 requires `^22.22.2 || ^24.15.0 || >=26.0.0`. Our declared
`^22.12.0 || ^24.0.0` admits versions jsdom 30 rejects in *both* arms (22.12–22.22.1 and
24.0–24.14). Taking it means raising `engines` and any CI Node floor.

**A live, unfixed regression in 30.0.1.** jsdom#4227: `querySelectorAll()` returns an empty NodeList
when the first compound of a descendant selector matches the context element. It was closed by
bumping `@asamuzakjp/dom-selector` to `^9.0.1` — **outside 30.0.1's declared `^8.3.0` range** — so a
fresh install today still resolves to the buggy 8.3.2. No released version carries the fix. Two more
CSS fixes sit unreleased on main.

Our direct exposure looks low (every `querySelectorAll` in the jsdom-run tests uses a single compound
selector; the one descendant selector lives in a browser-mode spec excluded at `vitest.config.ts:24`;
and `css: false` at `vitest.config.ts:19` means no stylesheets reach jsdom at all). But CodeMirror
internals were not audited, and jsdom 30's unlabelled behavioural changes — `getComputedStyle()` now
converting lengths to pixels, changed CSS function serialization, a different `document.evaluate()`
error type — are exactly the shape that breaks tests quietly.

**One confounder to remember if this is attempted anyway:** testing-library/user-event#1323 (open,
filed 2026-08-08) reports `userEvent` hanging to a 5s timeout on a stack matching ours on every axis
— React 19.2.8, RTL 16.3.2, Vitest 4.1.10, user-event 14.6.3 — **except the reporter is on jsdom 30
and we are on 29.1.1**. We run that user-event version green across 1868 tests today, which makes
jsdom 30 the more likely trigger. If tests start hanging after a bump, pin user-event to 14.6.1 to
isolate before blaming jsdom.

There is no upside to being early. Re-evaluate when 30.0.2 ships.

---

## Recommended sequence

Each step is independently verifiable and independently revertable. Do not batch them.

1. **`@testing-library/jest-dom` → `^7.0.1`.** Verify: `test:run`.
2. **`@vitejs/plugin-react` → `^5.2.0`, plus explicit `resolve.dedupe` in all three configs.**
   Verify: `test:run`, `test:browser:chromium`, `build`.
3. **`@wdio/tauri-*` → 1.3.0** across all four coordinates, plus the `@wdio/native-utils` override
   → 2.6.0 and the contract-test constants. Verify: `rust-quality-gate.sh`, then `test:native`
   **several times** — its failure mode is flakiness, not a clean red.
4. **`vite` → `^8.2.0`.** Verify in this order, because the cheapest signal comes first:
   `build` → `build:native-e2e` → `coverage` → `test:browser:chromium` → `test:browser:webkit` →
   `test:native`. Inspect the built CSS for the `backdrop-blur` surfaces.
5. **`@vitejs/plugin-react` → `^6.0.5`.** Re-run step 4's sequence. `resolve.dedupe` is already
   explicit by now, which is the whole point of step 2.
6. **`jsdom` → 30.0.2+ when it exists**, with the `engines` raise to `^22.22.2 || ^24.15.0` and a
   matching CI Node floor.

Steps 1–3 are safe to take at any time. Steps 4–5 want a clear window, not a release run-up. Step 6
is blocked upstream.

## Two non-major decisions worth making

**The `@codemirror/*` packages are pinned to exact versions**, so routine patches do not flow:
`lang-markdown` 6.5.1 (6.5.2 available) and `view` 6.43.6 (6.43.8 available). Given how much of the
editor's behaviour is tuned against CodeMirror internals — in-place table editing especially — the
pinning is almost certainly deliberate. Worth confirming that intent and, if so, recording it, since
an unexplained exact pin reads as an accident to the next person. Ties to the same reasoning as
`docs/security/dependency-advisories.md`: an exception without a written rationale decays.

**TypeScript is split across the two npm projects:** `7.0.2` (exact) in `app/desktop`, `~5.8.3` in
`e2e-native`. The app was deliberately moved to TS 7, so the split may simply be that e2e-native was
never migrated. Two majors of drift in one repo is a papercut that grows; either close it or write
down why it stays open.

---

## Deferred

Everything PR #107 knowingly left undone. Grouped by whether it is ours to fix.

### Ours, scheduled

- **`DEFER(vite-8)`** — steps 4 and 5 above (`vite` 8.2.x + `@vitejs/plugin-react` 6.0.5).
  Needs a clear window, not a release run-up. The risk is concentrated in
  `scripts/assert-production-bundle.mjs`, which holds only because the bundler's dead-code
  elimination drops the `import.meta.env`-guarded native-e2e imports; Rolldown's DCE is a
  different implementation and no documentation can answer whether it behaves identically.
- **`DEFER(codemirror-pins)`** — `@codemirror/lang-markdown` (6.5.1, 6.5.2 available) and
  `@codemirror/view` (6.43.6, 6.43.8 available) are pinned to exact versions, so routine patches
  do not flow. Almost certainly deliberate given how much editor behaviour is tuned against
  CodeMirror internals, but the intent is not written down anywhere, so it reads as an accident.
  Confirm and record, or unpin.
- **`DEFER(typescript-split)`** — TS `7.0.2` in `app/desktop` vs `~5.8.3` in `e2e-native`.

### Ours, verification gaps rather than changes

- **`DEFER(wdio-native-tier)`** — the `@wdio/tauri-*` 1.3.0 bump could not be exercised locally:
  the native tier needs a built binary on macOS CI. 1.3.0 adds ~300 lines of macOS/WebKit
  DirectEval handling plus a new `eval_channel.rs` under the execution path that suite drives,
  and this repo has already shipped one WKWebView-specific bug (58a1664). Watch that lane across
  several runs, not one.
- One frontend test failed once while the Rust quality gate was running concurrently, then passed
  on an idle re-run. It was not identified before it recovered, so it is recorded here rather
  than diagnosed. If a jsdom test starts failing only under parallel load, this is the first
  place to look.
- **`DEFER(overflow-stderr-race)`** — `youtube::process::tests::stdout_overflow_is_bounded_and_stops_the_child`
  failed once on Ubuntu CI (2026-08-10) and passed on re-run against identical code. Narrowed but
  **not solved**: `stdout.len() == 64` is guaranteed by construction (`read_bounded` caps each
  append at `limit - retained.len()`), so `stderr.is_empty()` is the only clause that can fail —
  yet the child is SIGKILLed as a process group, which should leave it no opportunity to write.
  What produced stderr output is unexplained. Note `/bin/sh` is dash on Ubuntu and bash on macOS,
  which is the most likely source of the divergence and would explain why it never reproduces
  locally. The assertion has been destructured so the next occurrence prints the offending bytes;
  it was deliberately not relaxed, because weakening an assertion whose cause is unknown trades a
  diagnosable flake for a permanent blind spot. Re-open when the message arrives.
- `production-dependencies.test.ts` deliberately keeps `v1.2.0` and `desktop v0.2.1` in its
  fixture strings. They are synthetic inputs proving the rejection is version-independent, not
  pins — do not "fix" them to match the real versions.

### Blocked upstream

- **`DEFER(jsdom-30)`** — step 6 above. Two independent blockers: jsdom 30's `engines`
  (`^22.22.2 || ^24.15.0 || >=26.0.0`) exclude versions our declared range admits in both arms,
  and 30.0.1 ships a `querySelectorAll` regression (jsdom#4227) whose fix landed by bumping
  `@asamuzakjp/dom-selector` **outside 30.0.1's own declared `^8.3.0` range**, so a fresh install
  today still carries the bug. Re-evaluate when 30.0.2 ships. If it is attempted anyway and tests
  begin hanging, pin `@testing-library/user-event` to 14.6.1 first to isolate — user-event#1323
  reports exactly that on a stack matching ours in every respect except jsdom 30.
- The 17 `cargo audit` warnings (Tauri's gtk-rs 0.18 GTK3 chain and the `unic-*` family). Fully
  accounted for in `docs/security/dependency-advisories.md`; both groups are upstream-blocked and
  neither compiles into the `aarch64-apple-darwin` bundle.

### Pre-existing, not introduced here

- **The webkit browser lane fails on `main`.** Re-running main's own CI job at `4d87df3` — which
  passed on 2026-08-01 — reproduced the failures on unmodified code (`TitleBar` drag-layer hit
  test plus three `SourceNoteEditor` tests). The specific set varies per run, which is the
  signature of a contended runner rather than a deterministic break; the full suite passes
  locally on the same engine build. One contributing cause *was* fixed here (the scroll-sync
  frame assertion's tolerance did not scale with its baseline), but the remaining failures are
  geometry assertions against a runner whose frames measured ~40x slower than healthy. Worth its
  own issue: the lane is informational, so it fails quietly and permanently, and a gate nobody
  trusts is not a gate.
- **A fresh clone or worktree cannot build the `desktop` crate** until `scripts/fetch-ollama-sidecar.sh`
  has been run there. It writes three gitignored artifacts — `binaries/ollama-*`,
  `binaries/llama-server-*` and `ollama-libs/` — and the last is a resource *glob*, where matching
  nothing is a hard build failure. The script already existed; the gap was that `CONTRIBUTING.md`
  framed it as a prerequisite for `tauri dev` rather than for **any** Rust build, so someone running
  only `cargo test --workspace` or the quality gate hits a Rust build error that reads as a code
  problem. Fixed in `CONTRIBUTING.md`.

### One-time, post-merge

- Deleting `prototype/` removes the tracked files only. The untracked `prototype/node_modules`
  (~352MB) survives in any existing checkout and must be removed by hand.
