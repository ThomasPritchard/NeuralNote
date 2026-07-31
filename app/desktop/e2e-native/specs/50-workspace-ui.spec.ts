import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { $, browser, expect } from "@wdio/globals";

import {
  appendToSourceEditor,
  clickVisibleTreeNote,
  closeVaultViaNativeMenuAction,
  currentSourceMatches,
  ensureFixtureWorkspace,
  fixturePaths,
  restoreStartSource,
  saveThroughMacOsKeyboardAccelerator,
} from "./native-helpers.js";

const macOsIt = process.platform === "darwin" ? it : it.skip;

async function reopenCleanStartNote(): Promise<string> {
  const existing = await $("button[aria-label='Close Native start']");
  if (await existing.isExisting()) {
    await existing.click();
    await existing.waitForExist({ reverse: true, timeout: 10_000 });
  }
  const initial = restoreStartSource();
  await clickVisibleTreeNote("Start.md");
  await browser.waitUntil(() => currentSourceMatches(initial), {
    timeout: 10_000,
    interval: 50,
  });
  return initial;
}

describe("NeuralNote native workspace interaction", () => {
  beforeEach(async () => {
    await ensureFixtureWorkspace();
  });

  macOsIt("saves through the real macOS keyboard accelerator", async () => {
    const initial = await reopenCleanStartNote();

    const savedText = "Saved through the real keyboard accelerator.";
    await appendToSourceEditor(savedText);
    await $("[aria-label='Unsaved changes']").waitForExist({ timeout: 10_000 });
    await saveThroughMacOsKeyboardAccelerator();

    await browser.waitUntil(
      () => readFileSync(fixturePaths().start, "utf8").includes(savedText),
      { timeout: 10_000, interval: 50 },
    );
    assert.equal(readFileSync(fixturePaths().start, "utf8"), `${initial}\n${savedText}`);
  });

  it("guards dirty vault closure with cancel and discard", async () => {
    await reopenCleanStartNote();
    const editor = await $("[role='textbox'][aria-label='Note content']");

    const dirtyText = "Unsaved close-guard draft.";
    await appendToSourceEditor(dirtyText);
    await $("[aria-label='Unsaved changes']").waitForExist({ timeout: 10_000 });
    await closeVaultViaNativeMenuAction();

    const dialog = await $("[role='alertdialog']");
    await dialog.waitForExist({ timeout: 10_000 });
    assert.match(await dialog.getText(), /Discard unsaved changes\?/u);
    await $("//*[@role='alertdialog']//button[normalize-space(.)='Cancel']").click();
    await expect(editor).toBeExisting();
    assert.equal(readFileSync(fixturePaths().start, "utf8").includes(dirtyText), false);

    await closeVaultViaNativeMenuAction();
    await $("//*[@role='alertdialog']//button[normalize-space(.)='Discard']").click();
    await expect($("h1=NeuralNote")).toBeExisting();
    assert.equal(readFileSync(fixturePaths().start, "utf8").includes(dirtyText), false);
  });
});
