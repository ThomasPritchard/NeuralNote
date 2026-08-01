import assert from "node:assert/strict";

import { $, browser, expect } from "@wdio/globals";

import { ensureFixtureWorkspace, invoke, nativeWait } from "./native-helpers.js";

describe("NeuralNote native window chrome", () => {
  beforeEach(async () => {
    await ensureFixtureWorkspace();
  });

  it("keeps empty titlebar chrome draggable and controls clickable", async () => {
    const titlebar = await $(".nn-titlebar");
    await titlebar.waitForExist({ timeout: nativeWait(30_000) });
    await expect($(".nn-titlebar [data-tauri-drag-region]")).toBeExisting();

    const navigation = await $("button[aria-label='Toggle navigation sidebar']");
    const before = await navigation.getAttribute("aria-pressed");
    await navigation.click();
    await browser.waitUntil(
      async () => (await navigation.getAttribute("aria-pressed")) !== before,
      { timeout: nativeWait(10_000), interval: 50 },
    );
  });

  it("tracks native macOS fullscreen without changing other platforms", async () => {
    if (process.platform !== "darwin") return;
    const titlebar = await $(".nn-titlebar");
    await invoke<void>("plugin:window|set_fullscreen", { label: "main", value: false });
    await browser.waitUntil(
      async () => !(await invoke<boolean>("plugin:window|is_fullscreen", { label: "main" })),
      { timeout: nativeWait(30_000), interval: 50 },
    );
    await invoke<void>("plugin:window|set_fullscreen", { label: "main", value: true });
    try {
      await browser.waitUntil(
        () => invoke<boolean>("plugin:window|is_fullscreen", { label: "main" }),
        { timeout: nativeWait(30_000), interval: 50 },
      );
      await browser.waitUntil(
        async () => {
          const className = (await titlebar.getAttribute("class")) ?? "";
          return className.includes("nn-titlebar-toggle-clearance-fullscreen");
        },
        { timeout: nativeWait(30_000), interval: 50 },
      );
      const className = (await titlebar.getAttribute("class")) ?? "";
      assert.equal(
        className.includes("nn-titlebar-toggle-clearance-fullscreen"),
        true,
      );
    } finally {
      await invoke<void>("plugin:window|set_fullscreen", { label: "main", value: false });
      await browser.waitUntil(
        async () => !(await invoke<boolean>("plugin:window|is_fullscreen", { label: "main" })),
        { timeout: nativeWait(30_000), interval: 50 },
      );
    }
  });
});
