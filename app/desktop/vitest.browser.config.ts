import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";

const requestedBrowser = process.env.NEURALNOTE_BROWSER ?? "chromium";
if (requestedBrowser !== "chromium" && requestedBrowser !== "webkit") {
  throw new Error(
    `NEURALNOTE_BROWSER must be "chromium" or "webkit"; received ${JSON.stringify(requestedBrowser)}`,
  );
}

// Tier-1.5 real-browser tests (`*.browser.test.tsx`). These run in a genuine
// headless Chromium (Playwright provider) with the app's REAL vite + Tailwind v4
// pipeline, so CSS stacking, z-index, and pointer hit-testing behave exactly as
// they do in the shipped webview — the thing jsdom (no layout engine) cannot
// prove. Kept in its own config so the tuned jsdom `vitest.config.ts` (coverage
// thresholds, excludes) is untouched; the jsdom runner excludes this glob.
//
// Runs on macOS and in CI. Unlike the Tier-2 `e2e-native/` suite, which uses
// WebdriverIO's embedded Tauri provider against a built binary on required Linux
// and macOS lanes plus informational Windows, this needs no native application
// lifecycle, only `npx playwright install chromium webkit`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // The Chromium-only graph smoke imports these lazily. Pre-bundling them
    // keeps Vite from reloading the running test (and loading a second React)
    // when that spec is the first graph consumer in a fresh cache.
    //
    // The Radix entries are here for the same reason and cost a red run to
    // find: the expand-to-wide spec mounts the whole ChatPane, which is the
    // first browser-tier consumer of the model menu and the icon-button
    // tooltip. Discovering them mid-run re-optimizes and reloads the test with
    // a SECOND copy of React, and every hook in the tree then throws "Invalid
    // hook call" — which reads as a broken component, not a cold cache.
    include: [
      "react-force-graph-3d",
      "three",
      "three/examples/jsm/postprocessing/UnrealBloomPass.js",
      "three-spritetext",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-tooltip",
    ],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    setupFiles: ["./src/test/browserSetup.ts"],
    retry: 0,
    // Browser mode's own defaults are 15s and 30s. They hold locally, where the
    // whole suite runs in ~15s, and expire on GitHub's hosted macOS runner,
    // which drives WebKit several times slower: 52 tests there died on
    // "Test timed out in 15000ms" while the ones that finished took ~2.7s
    // against ~0.3s here. Every failure was an expiry - no assertion ever
    // disagreed - so the budget was measuring the runner. These bound how long
    // we WAIT, not how exact a measurement has to be, which is why widening
    // them is honest where widening a geometry tolerance would not be.
    testTimeout: process.env.CI ? 60_000 : 15_000,
    hookTimeout: process.env.CI ? 60_000 : 30_000,
    browser: {
      enabled: true,
      screenshotFailures: true,
      screenshotDirectory: `artifacts/browser/${requestedBrowser}/screenshots`,
      trace: {
        mode: "retain-on-failure",
        tracesDir: `artifacts/browser/${requestedBrowser}/traces`,
      },
      // No `contextOptions: { reducedMotion: "reduce" }`. Emulating it made the
      // measurement probe read HEADER cells at regular weight instead of bold:
      // live advance came out 1-3px wider than the probe on every header cell,
      // and "measures a header cell at the weight the header rule gives it"
      // inverted to `header <= body`. Six geometry assertions failed with it and
      // pass without it, bisected one option at a time. The reduced-motion rule
      // this would have matched is `styles.css`'s animation/transition reset; it
      // buys this suite nothing, and this suite exists to measure text advance.
      provider: playwright(),
      headless: true,
      instances: [
        {
          browser: requestedBrowser,
          name: requestedBrowser,
          viewport: { width: 1280, height: 800 },
        },
      ],
    },
  },
});
