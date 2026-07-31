import assert from "node:assert/strict";

import { $$, $, browser } from "@wdio/globals";

import { MARKDOWN_COMPATIBILITY_SOURCE } from "../native-fixtures.js";
import {
  currentSourceMatches,
  ensureFixtureWorkspace,
} from "./native-helpers.js";

describe("NeuralNote native workspace restoration after process restart", () => {
  it("restores both tabs and the active editor in the relaunched app", async () => {
    await ensureFixtureWorkspace();
    await browser.waitUntil(async () => {
      const tabs = await $$("[role='tablist'][aria-label='Open notes'] [role='tab']");
      const labels: Array<string | null> = [];
      for (const tab of tabs) labels.push(await tab.getAttribute("aria-label"));
      return labels.includes("Native start")
        && labels.includes("Native Markdown Compatibility");
    }, { timeout: 30_000, interval: 50 });

    const active = await $("[role='tab'][aria-selected='true']");
    assert.equal(await active.getAttribute("aria-label"), "Native Markdown Compatibility");
    const editor = await $("[role='textbox'][aria-label='Note content']");
    await editor.waitForDisplayed({ timeout: 30_000 });
    await browser.waitUntil(() => currentSourceMatches(MARKDOWN_COMPATIBILITY_SOURCE), {
      timeout: 10_000,
      interval: 50,
    });
  });
});
