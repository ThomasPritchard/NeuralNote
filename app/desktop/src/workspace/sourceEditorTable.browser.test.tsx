// Real-browser proof that the table alignment actually lines the columns up.
//
// Updated for drawn chrome: the pipes are hidden, so alignment is measured from
// the rendered dividers rather than from pipe glyphs.
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

/** Screen x of each drawn cell divider on a line, left to right. */
function dividerPositions(line: Element): number[] {
  return [...line.querySelectorAll(".nn-lp-cell-chrome-divider")]
    .map((element) => element.getBoundingClientRect().left);
}

function tableLines(container: Element): Element[] {
  return [...container.querySelectorAll(".cm-line")].filter((line) =>
    line.querySelector(".nn-lp-cell-chrome-divider"),
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

    // No pipe is painted anywhere, though every one is still in the document.
    expect(host.querySelector(".cm-content")?.textContent ?? "").not.toContain("|");

    const lines = tableLines(host);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Every content row must agree on where each drawn divider sits.
    const columns = Math.min(...lines.map((line) => dividerPositions(line).length));
    expect(columns).toBeGreaterThan(0);

    for (let column = 0; column < columns; column += 1) {
      const positions = lines.map((line) => dividerPositions(line)[column]!);
      const spread = Math.max(...positions) - Math.min(...positions);
      expect(spread).toBeLessThan(1.5);
    }

    root.unmount();
    host.remove();
    root = null;
  });
});
