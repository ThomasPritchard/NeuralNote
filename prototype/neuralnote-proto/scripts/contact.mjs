// Compose the 6 direction screenshots into one labelled contact sheet.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const dir = new URL("../shots/", import.meta.url).pathname;
const dataUri = (id) =>
  `data:image/png;base64,${readFileSync(`${dir}${id}.png`).toString("base64")}`;
const items = [
  ["eden", "Eden — warm-dark sage"],
  ["obsidian", "Obsidian-native — dense"],
  ["collective", "Collective OS — cream editorial"],
  ["deepflow", "Deepflow — indigo dashboard"],
  ["linear", "Linear — zinc command deck"],
  ["vercel", "Vercel — mono / graph paper"],
];

const cards = items
  .map(
    ([id, label]) => `
    <figure>
      <img src="${dataUri(id)}" />
      <figcaption><b>${label}</b> <span>?variant=${id}</span></figcaption>
    </figure>`,
  )
  .join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#0c0c0d;font-family:Inter,system-ui,sans-serif;padding:28px}
  h1{color:#fff;font-size:22px;margin:0 0 6px}
  p{color:#8a8a90;font-size:13px;margin:0 0 22px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  figure{margin:0;background:#161617;border:1px solid #262628;border-radius:12px;overflow:hidden}
  img{width:100%;display:block;border-bottom:1px solid #262628}
  figcaption{color:#d4d4d8;font-size:14px;padding:10px 14px;display:flex;justify-content:space-between}
  figcaption span{color:#6e6e76;font-family:ui-monospace,monospace;font-size:12px}
</style></head><body>
  <h1>NeuralNote — six design directions</h1>
  <p>App workspace · same vault, six aesthetics · flip live at localhost:5173 with ← / →</p>
  <div class="grid">${cards}</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.screenshot({ path: `${dir}contact-sheet.png`, fullPage: true });
await browser.close();
console.log("contact sheet:", `${dir}contact-sheet.png`);
