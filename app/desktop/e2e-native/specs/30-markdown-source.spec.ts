import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { $, browser, expect } from "@wdio/globals";

import { MARKDOWN_COMPATIBILITY_SOURCE } from "../native-fixtures.js";
import {
  bytes,
  clickVisibleTreeNote,
  fixturePaths,
  nativeWait,
  resetFixtureWorkspace,
} from "./native-helpers.js";

const CRLF_SOURCE = "# CRLF\r\n\r\nFirst\r\nSecond\r\n";
const MIXED_SOURCE = "# Mixed\r\n\rFirst\nSecond\r\nThird\r";

async function editor() {
  const noteEditor = await $("[role='textbox'][aria-label='Note content']");
  await noteEditor.waitForExist({ timeout: nativeWait(30_000) });
  return noteEditor;
}

async function replaceVisibleLinePrefix(
  lineText: string,
  sourcePrefix: string,
  replacement: string,
): Promise<void> {
  const line = await $(`.cm-line*=${lineText}`);
  await line.waitForDisplayed({ timeout: nativeWait(30_000) });
  await line.scrollIntoView();
  const changed = await browser.execute(
    (expected, insertedText) =>
      window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1?.replaceFirst?.(expected, insertedText) ?? false,
    sourcePrefix,
    replacement,
  );
  if (!changed) throw new Error("native E2E editor bridge did not find the expected source span");
  await $("[aria-label='Unsaved changes']").waitForExist({ timeout: nativeWait(10_000) });
}

async function saveWithVisibleControl(): Promise<void> {
  const save = await $("button=Save");
  await save.waitForClickable({ timeout: nativeWait(30_000) });
  await save.click();
  await $("[aria-label='Unsaved changes']").waitForExist({ reverse: true, timeout: nativeWait(30_000) });
}

describe("NeuralNote native Markdown source fidelity", () => {
  beforeEach(async () => {
    await resetFixtureWorkspace();
    writeFileSync(fixturePaths().markdown, MARKDOWN_COMPATIBILITY_SOURCE, "utf8");
    writeFileSync(fixturePaths().crlf, CRLF_SOURCE, "utf8");
    writeFileSync(fixturePaths().mixed, MIXED_SOURCE, "utf8");
  });

  afterEach(async () => {
    await browser.execute(() => {
      const target = window as typeof window & {
        nnNativeE2eOriginalFetch?: typeof window.fetch;
        nnNativeE2eOriginalXhrOpen?: typeof XMLHttpRequest.prototype.open;
      };
      if (target.nnNativeE2eOriginalFetch) {
        window.fetch = target.nnNativeE2eOriginalFetch;
        delete target.nnNativeE2eOriginalFetch;
      }
      if (target.nnNativeE2eOriginalXhrOpen) {
        XMLHttpRequest.prototype.open = target.nnNativeE2eOriginalXhrOpen;
        delete target.nnNativeE2eOriginalXhrOpen;
      }
    });
  });

  it("opens and closes the supported-construct fixture without writing a byte", async () => {
    const before = bytes(fixturePaths().markdown);
    await clickVisibleTreeNote("Markdown Compatibility.md");
    await editor();
    const close = await $("button[aria-label='Close Native Markdown Compatibility']");
    await close.waitForDisplayed({ timeout: nativeWait(10_000) });
    await close.click();
    await close.waitForExist({ reverse: true, timeout: nativeWait(10_000) });

    assert.deepEqual(bytes(fixturePaths().markdown), before);
  });

  it("changes one local span and preserves every untouched Markdown byte", async () => {
    await clickVisibleTreeNote("Markdown Compatibility.md");
    await editor();
    await replaceVisibleLinePrefix("Paragraph one with", "Paragraph one", "Paragraph one edited");
    await saveWithVisibleControl();

    const changed = MARKDOWN_COMPATIBILITY_SOURCE.replace("Paragraph one", "Paragraph one edited");
    await browser.waitUntil(
      () => readFileSync(fixturePaths().markdown, "utf8") === changed,
      { timeout: nativeWait(10_000), interval: 50 },
    );

    assert.equal(readFileSync(fixturePaths().markdown, "utf8"), changed);
    assert.equal(changed.replace(" edited", ""), MARKDOWN_COMPATIBILITY_SOURCE);
  });

  it("preserves CRLF and mixed endings outside one exact local edit", async () => {
    for (const [label, pathname] of [
      ["CRLF.md", fixturePaths().crlf],
      ["Mixed Endings.md", fixturePaths().mixed],
    ] as const) {
      const before = readFileSync(pathname, "utf8");
      await clickVisibleTreeNote(label);
      await editor();
      await replaceVisibleLinePrefix("First", "First", "First edited");
      await saveWithVisibleControl();
      const changed = before.replace("First", "First edited");
      await browser.waitUntil(() => readFileSync(pathname, "utf8") === changed, {
        timeout: nativeWait(10_000),
        interval: 50,
      });
      const after = readFileSync(pathname, "utf8");
      assert.equal(after, changed);
      assert.equal(after.replace(" edited", ""), before);
    }
  });

  it("renders image and embed labels as inert text without DOM URLs", async () => {
    const existingClose = await $("button[aria-label='Close Native Markdown Compatibility']");
    if (await existingClose.isExisting()) {
      await existingClose.click();
      await existingClose.waitForExist({ reverse: true, timeout: nativeWait(10_000) });
    }
    const auditPath = path.join(fixturePaths().root, "artifacts", "native-read-audit.jsonl");
    writeFileSync(auditPath, "", "utf8");
    await browser.execute(() => {
      const target = window as typeof window & {
        nnNativeE2eNetworkAudit?: string[];
        nnNativeE2eOriginalFetch?: typeof window.fetch;
        nnNativeE2eOriginalXhrOpen?: typeof XMLHttpRequest.prototype.open;
      };
      target.nnNativeE2eNetworkAudit = [];
      target.nnNativeE2eOriginalFetch ??= window.fetch;
      target.nnNativeE2eOriginalXhrOpen ??= XMLHttpRequest.prototype.open;
      const originalFetch = target.nnNativeE2eOriginalFetch;
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        target.nnNativeE2eNetworkAudit!.push(`fetch:${String(input)}`);
        return originalFetch.call(window, input, init);
      }) as typeof window.fetch;
      const originalOpen = target.nnNativeE2eOriginalXhrOpen;
      XMLHttpRequest.prototype.open = function auditedOpen(
        method: string,
        url: string | URL,
        async = true,
        username?: string | null,
        password?: string | null,
      ) {
        target.nnNativeE2eNetworkAudit!.push(`xhr:${String(url)}`);
        Reflect.apply(originalOpen, this, [method, url, async, username, password]);
      };
      performance.clearResourceTimings();
    });
    // Select the fixture through the real tree and move the editor viewport to
    // the inert constructs.
    await clickVisibleTreeNote("Markdown Compatibility.md");
    const noteEditor = await $("[role='textbox'][aria-label='Note content']");
    await noteEditor.waitForExist({ timeout: nativeWait(30_000) });
    await noteEditor.click();
    await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller");
      if (!scroller) throw new Error("CodeMirror scroller is missing");
      scroller.scrollTop = scroller.scrollHeight * 0.62;
    });

    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll(".nn-lp-image, .nn-lp-embed").length)) > 0,
      { timeout: nativeWait(10_000), interval: 50 },
    );
    await expect($("img[src*='native-e2e-image']")).not.toBeExisting();
    assert.equal(
      await browser.execute(() =>
        [...document.querySelectorAll(".nn-lp-image, .nn-lp-embed")].some(
          (element) => element.hasAttribute("src") || element.hasAttribute("href"),
        ),
      ),
      false,
    );
    const networkAudit = await browser.execute(() => {
      const target = window as typeof window & { nnNativeE2eNetworkAudit?: string[] };
      return {
        calls: target.nnNativeE2eNetworkAudit ?? [],
        resources: performance.getEntriesByType("resource").map(({ name }) => name),
      };
    });
    assert.deepEqual(
      networkAudit.calls.filter((request) => request.includes("native-e2e-image")),
      [],
    );
    assert.deepEqual(
      networkAudit.resources.filter((request) => request.includes("native-e2e-image")),
      [],
    );
    const nativeReads = readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string);
    const inertTargets = new Set([
      "never-read-standard-image.png",
      "never-read-obsidian-image.png",
      "Never Read Obsidian Note",
      "Never Read Obsidian Note.md",
    ]);
    assert.deepEqual(
      nativeReads.filter((fileName) => inertTargets.has(fileName)),
      [],
    );
  });
});
