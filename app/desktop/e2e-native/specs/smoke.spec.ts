// @ts-nocheck — CI-only scaffold (mocha + webdriverio globals install in CI, not
// in the parent app); suppressed to keep the main editor clean. See README.md.
// Native smoke test: the real NeuralNote window boots and the welcome screen's
// brand heading is visible. This is the minimal "the app actually launches in a
// real webview with the real Rust backend behind it" check — the thing the
// jsdom/mockIPC tier structurally cannot prove.
//
// `browser` and `$`/`expect` are WebdriverIO globals (see @wdio/globals).

describe("NeuralNote — native smoke", () => {
  it("boots and shows the welcome brand heading", async () => {
    // The welcome screen renders an <h1>NeuralNote</h1> (src/welcome/BrandHeader.tsx).
    const heading = await $("h1");
    await heading.waitForExist({ timeout: 30_000 });
    await expect(heading).toHaveText("NeuralNote");
  });

  it("offers the open- and create-vault entry points", async () => {
    // VaultActions renders two primary buttons, each with a label + a small
    // description, so match on partial text (src/welcome/VaultActions.tsx).
    await expect($("button*=Open vault")).toBeExisting();
    await expect($("button*=New vault")).toBeExisting();
  });
});
