/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";

// Tier-1.5 real-browser tests (`*.browser.test.tsx`). These run in a genuine
// headless Chromium (Playwright provider) with the app's REAL vite + Tailwind v4
// pipeline, so CSS stacking, z-index, and pointer hit-testing behave exactly as
// they do in the shipped webview — the thing jsdom (no layout engine) cannot
// prove. Kept in its own config so the tuned jsdom `vitest.config.ts` (coverage
// thresholds, excludes) is untouched; the jsdom runner excludes this glob.
//
// Runs on macOS and in CI. Unlike the Tier-2 `e2e-native/` WebDriver suite (which
// needs a built Tauri binary + `tauri-driver`, Linux/Windows only), this needs no
// native driver — only `npx playwright install chromium`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
