import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { $, browser } from "@wdio/globals";

import { MARKDOWN_COMPATIBILITY_SOURCE } from "../native-fixtures.js";
import {
  appendToSourceEditor,
  clickVisibleTreeNote,
  ensureFixtureWorkspace,
  fixturePaths,
} from "./native-helpers.js";

describe("NeuralNote native workspace restart seed", () => {
  it("persists two UI-opened tabs with the second note active", async () => {
    // The main session intentionally edits the native Markdown fixture. Seed
    // the canonical restart document before opening the isolated restart app.
    writeFileSync(fixturePaths().markdown, MARKDOWN_COMPATIBILITY_SOURCE, "utf8");
    await ensureFixtureWorkspace();
    await clickVisibleTreeNote("Start.md");
    const startSource = readFileSync(fixturePaths().start, "utf8");
    await appendToSourceEditor("\nUnsaved restart-tab sentinel.");
    await $("[aria-label='Unsaved changes']").waitForExist({ timeout: 10_000 });
    // Opening another note while the first tab is dirty exercises the normal
    // UI rule that preserves the first tab instead of replacing it.
    await clickVisibleTreeNote("Markdown Compatibility.md");
    await $("[role='textbox'][aria-label='Note content']").waitForExist({ timeout: 30_000 });

    const statePath = path.join(fixturePaths().vault, ".neuralnote", "workspace-state.json");
    await browser.waitUntil(() => {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as {
          openPaths?: string[];
          activePath?: string | null;
        };
        return state.openPaths?.join("|") === "Start.md|Markdown Compatibility.md"
          && state.activePath === "Markdown Compatibility.md";
      } catch {
        return false;
      }
    }, { timeout: 10_000, interval: 50 });

    const active = await $("[role='tab'][aria-selected='true']");
    assert.match((await active.getAttribute("aria-label")) ?? "", /Markdown Compatibility/u);
    assert.equal(readFileSync(fixturePaths().start, "utf8"), startSource);
  });
});
