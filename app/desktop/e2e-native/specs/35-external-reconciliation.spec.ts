import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { $, browser, expect } from "@wdio/globals";

import {
  appendToSourceEditor,
  clickVisibleTreeNote,
  currentSourceMatches,
  fixturePaths,
  nativeWait,
  resetFixtureWorkspace,
  restoreStartSource,
} from "./native-helpers.js";

async function openStartNote(): Promise<void> {
  await clickVisibleTreeNote("Start.md");
  await $("[role='textbox'][aria-label='Note content']").waitForExist({
    timeout: nativeWait(30_000),
  });
}

async function editorText(): Promise<string> {
  return $("[role='textbox'][aria-label='Note content']").getText();
}

describe("NeuralNote native external reconciliation", () => {
  beforeEach(async () => {
    await resetFixtureWorkspace();
    const source = restoreStartSource();
    await openStartNote();
    await browser.waitUntil(() => currentSourceMatches(source), {
      timeout: nativeWait(30_000),
      interval: 50,
    });
  });

  it("reloads a clean external edit through the real watcher", async () => {
    const external = "# Native start\n\nClean external edit.\n";
    writeFileSync(fixturePaths().start, external, "utf8");

    await browser.waitUntil(async () => (await editorText()).includes("Clean external edit."), {
      timeout: nativeWait(10_000),
      interval: 50,
    });
    await expect($("[aria-label='Unsaved changes']")).not.toBeExisting();
    await expect($("*=changed on disk since you opened it")).not.toBeExisting();
  });

  it("keeps a dirty draft on conflict and reloads only after confirmation", async () => {
    const draft = "Local unsaved draft.";
    await appendToSourceEditor(draft);
    await $("[aria-label='Unsaved changes']").waitForExist({ timeout: nativeWait(10_000) });

    const external = "# Native start\n\nChanged underneath the draft.\n";
    writeFileSync(fixturePaths().start, external, "utf8");
    const conflict = await $(
      "//div[@role='alert'][contains(., 'changed on disk since you opened it')]",
    );
    await conflict.waitForExist({ timeout: nativeWait(20_000) });

    assert.equal((await editorText()).includes(draft), true);
    assert.equal(readFileSync(fixturePaths().start, "utf8"), external);
    await $("button*=Reload (discard edits)").click();
    await browser.waitUntil(
      async () => {
        const text = await editorText();
        return text.includes("Changed underneath the draft.") && !text.includes(draft);
      },
      { timeout: nativeWait(10_000), interval: 50 },
    );
    await expect($("[aria-label='Unsaved changes']")).not.toBeExisting();
  });

  it("surfaces an external deletion without dropping the open source", async () => {
    unlinkSync(fixturePaths().start);
    await $("//div[@role='alert'][contains(., 'deleted on disk')]").waitForExist({
      timeout: nativeWait(20_000),
    });
    assert.equal((await editorText()).includes("Exact source."), true);
  });
});
