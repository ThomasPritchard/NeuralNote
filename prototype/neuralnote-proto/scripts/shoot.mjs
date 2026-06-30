// Screenshot harness — captures every direction at desktop size.
// Usage: node scripts/shoot.mjs [variant1 variant2 ...]   (default: all)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const ALL = ["eden", "obsidian", "collective", "deepflow", "linear", "vercel"];
const variants = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const OUT = new URL("../shots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-gl=angle"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

for (const v of variants) {
  let query = `?variant=${v}`;
  let full = false;
  let wait = 400;
  if (v === "galaxy") {
    query = "?galaxy=1";
    wait = 4000; // let the 3D force layout settle
  } else if (v.startsWith("landing-")) {
    query = `?landing=${v.slice("landing-".length)}&shot=1`; // shot=1 hides dev switcher
    full = true; // landings scroll
    wait = v.includes("galaxy") ? 4500 : 1500;
  }
  await page.goto(`http://localhost:5173/${query}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}${v}.png`, fullPage: full });
  console.log("shot:", v);
}

await browser.close();
