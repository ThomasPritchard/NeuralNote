import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const baseUrl = "http://127.0.0.1:4174";
const landings = ["galaxy", "product", "gradient"];
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 960 },
];
const expectedBrandCopy = [
  "More knowledge, less setup.",
  "Built for instant use.",
  "AI-powered knowledge assistant",
];
const staleBrandCopy = [
  /Obsidian/i,
  /Your notes\. Your AI\. Your choice\./i,
  /cited AI/i,
  /Cited recall/i,
  /zero setup/i,
];
const screenshotDir = process.env.BRAND_SCREENSHOT_DIR
  ? resolve(process.env.BRAND_SCREENSHOT_DIR)
  : null;

const server = spawn(
  process.execPath,
  [viteBin, "--host", "127.0.0.1", "--port", "4174", "--strictPort"],
  {
    cwd: projectRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Vite.\n${serverOutput}`);
}

async function revealFullPage(page, viewportHeight) {
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = Math.max(320, Math.floor(viewportHeight * 0.75));

  for (let y = 0; y < pageHeight; y += step) {
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
    await page.waitForTimeout(80);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(160);
}

let browser;

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

  for (const landing of landings) {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport });
      await page.goto(`${baseUrl}/?landing=${landing}&shot=1`, { waitUntil: "networkidle" });

      const marks = page.locator('img[data-neuralnote-brand-mark="true"]');
      assert.ok(
        (await marks.count()) >= 2,
        `${landing}/${viewport.name}: expected the shared brand mark in navigation and footer`,
      );
      assert.equal(
        await marks.first().getAttribute("alt"),
        "",
        `${landing}/${viewport.name}: the mark should be decorative beside the live wordmark`,
      );
      assert.ok(await marks.first().evaluate((image) => image.complete && image.naturalWidth > 0));

      const wordmark = page.locator('[data-neuralnote-wordmark="true"]').first();
      assert.equal((await wordmark.textContent())?.trim(), "NeuralNote");
      const fontFamily = await wordmark.evaluate((element) => getComputedStyle(element).fontFamily);
      assert.match(fontFamily, /Geist/i, `${landing}/${viewport.name}: wordmark should render in Geist`);

      const visibleCopy = await page.locator("body").innerText();
      for (const expected of expectedBrandCopy) {
        assert.ok(
          visibleCopy.includes(expected),
          `${landing}/${viewport.name}: expected visible copy to include ${JSON.stringify(expected)}`,
        );
      }
      for (const stale of staleBrandCopy) {
        assert.doesNotMatch(
          visibleCopy,
          stale,
          `${landing}/${viewport.name}: visible copy still matches stale branding ${String(stale)}`,
        );
      }

      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert.equal(
        hasHorizontalOverflow,
        false,
        `${landing}/${viewport.name}: page should not overflow horizontally`,
      );

      if (screenshotDir) {
        await revealFullPage(page, viewport.height);
        await page.screenshot({
          path: resolve(screenshotDir, `${landing}-${viewport.name}.png`),
          fullPage: true,
        });
      }
      await page.close();
    }
  }

  console.log("Brand smoke test passed for galaxy, product, and gradient landings.");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
