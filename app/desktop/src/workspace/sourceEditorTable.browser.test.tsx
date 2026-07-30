// Real-browser proof that the table alignment actually lines the columns up.
//
// The jsdom tests already cover the width arithmetic: `sourceEditorTableModel`
// asserts exact pad widths, so a miscalculated deficit fails there too. What no
// jsdom test can see is whether those widths survive to the screen, because jsdom
// has no layout engine and `getBoundingClientRect()` returns all-zeros.
//
// The gap is real and was measured. Changing `.nn-lp-table-pad` from
// `white-space: pre` to `normal` collapses every padding run to a single space
// and wrecks the alignment — all 67 jsdom tests stay green, and this test fails
// with a ~29px spread. The same holds for a wrong widget `side`, or the editor
// losing its monospace font: correct data, wrong pixels.
//
// So this renders the real <SourceNoteEditor/> in headless Chromium with the
// app's real Tailwind pipeline, reveals a ragged table's source, and measures the
// on-screen x-position of each row's separators. See vitest.browser.config.ts.

import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import { SourceNoteEditor } from "./SourceNoteEditor";
import "../styles.css";

const SOURCE = [
  "# Commitments",
  "",
  "| Start date | Commitment |",
  "| --- | --- |",
  "| 2026-04-03 | DJ gig |",
  "| 2026-11-30 | Rehearsal |",
].join("\n");

/**
 * Screen x of the nth `|` rendered inside a line, walking text nodes so that
 * widget-inserted padding counts exactly as the reader sees it.
 */
function separatorX(line: Element, index: number): number {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    for (let offset = 0; offset < text.length; offset += 1) {
      if (text[offset] !== "|") continue;
      if (seen === index) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        return range.getBoundingClientRect().left;
      }
      seen += 1;
    }
    node = walker.nextNode();
  }
  return Number.NaN;
}

function tableLines(container: Element): Element[] {
  return [...container.querySelectorAll(".cm-line")].filter((line) =>
    (line.textContent ?? "").includes("|"),
  );
}

describe("table column alignment", () => {
  let root: Root | null = null;

  it("lines every column separator up once the source is revealed", async () => {
    const host = document.createElement("div");
    host.className = "nn-source-editor";
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        <SourceNoteEditor
          sessionKey="browser-table"
          loadedHash="browser-table-hash"
          value={SOURCE}
          onChange={() => {}}
          onPreservationError={() => {}}
        />,
      );
    });

    // Reveal the source by putting the caret in the table.
    await page.getByRole("cell", { name: "DJ gig" }).click();
    await expect.element(page.getByRole("table", { name: "Markdown table" })).not.toBeInTheDocument();

    const lines = tableLines(host);
    expect(lines).toHaveLength(4);

    // Each row must agree on where its 2nd and 3rd separators sit.
    for (const separator of [1, 2]) {
      const positions = lines.map((line) => separatorX(line, separator));
      expect(positions.every((value) => Number.isFinite(value))).toBe(true);
      const spread = Math.max(...positions) - Math.min(...positions);
      expect(spread).toBeLessThan(1.5);
    }

    root.unmount();
    host.remove();
    root = null;
  });
});
