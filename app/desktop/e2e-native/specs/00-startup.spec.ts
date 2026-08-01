import { $, expect } from "@wdio/globals";

import { dismissWhatsNewIfPresent, nativeWait } from "./native-helpers.js";

describe("NeuralNote native startup", () => {
  it("boots with the vault entry points", async () => {
    const heading = await $("h1");
    await heading.waitForExist({ timeout: nativeWait(30_000) });
    await expect(heading).toHaveText("NeuralNote");
    await expect($("button*=Open vault")).toBeExisting();
    await expect($("button*=New vault")).toBeExisting();
  });

  it("opens a pre-authorised recent vault and persists release-note acknowledgement", async () => {
    await dismissWhatsNewIfPresent();
    const recent = await $("button[aria-label='Open Native Fixture']");
    await recent.waitForDisplayed({ timeout: nativeWait(30_000) });
    await recent.click();

    const tabs = await $("[role='tablist'][aria-label='Open notes']");
    await tabs.waitForExist({ timeout: nativeWait(30_000) });
    await expect($("button[aria-label='Toggle navigation sidebar']")).toBeExisting();
  });
});
