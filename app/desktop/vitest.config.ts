/// <reference types="vitest/config" />
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Standalone test config (kept separate from the Tauri vite.config so the dev/
// build pipeline is untouched). jsdom + Testing Library; v8 coverage emitted as
// lcov for the SonarQube scanner.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // The Tier-2 native WebDriver specs (e2e-native/**/*.spec.ts) are run by
    // WebdriverIO, not Vitest — keep this runner from collecting them.
    exclude: [...configDefaults.exclude, "e2e-native/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      thresholds: {
        lines: 90,
      },
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        // The e2e harness (mockVault/renderApp) is test infrastructure, not
        // production source; the *.e2e.test.tsx specs are already excluded by the
        // glob above. Excluding the whole dir keeps coverage measuring real app
        // code — which the e2e suite, driving the real <App/>, exercises directly.
        "src/e2e/**",
        "src/main.tsx",
        "src/**/*.d.ts",
      ],
    },
  },
});
