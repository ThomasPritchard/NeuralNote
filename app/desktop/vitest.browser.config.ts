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
    include: [
      "react-force-graph-3d",
      "three",
      "three/examples/jsm/postprocessing/UnrealBloomPass.js",
      "three-spritetext",
    ],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    retry: 0,
    browser: {
      enabled: true,
      screenshotFailures: true,
      screenshotDirectory: `artifacts/browser/${requestedBrowser}/screenshots`,
      trace: {
        mode: "retain-on-failure",
        tracesDir: `artifacts/browser/${requestedBrowser}/traces`,
      },
      provider: playwright({
        contextOptions: {
          reducedMotion: "reduce",
        },
      }),
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
