// The arithmetic half of P3d. Everything here is a pure function of numbers or
// of DOM *structure* — never of layout — because jsdom has no layout engine:
// `getBoundingClientRect()` returns all-zeros and `scrollLeft` is a settable
// number nothing honours. The behaviour that needs a real scroller lives in
// `sourceEditorTableScrollSync.browser.test.ts` and is provable only there.
//
// Splitting the module this way is deliberate: the clamp that CT-7 turns on is
// four comparisons, and four comparisons deserve a test that runs in 4ms rather
// than one that needs a browser.

import { describe, expect, it } from "vitest";

import { TABLE_CONTRACT_FIXTURE } from "./sourceEditorTableContractFixture";
import {
  TABLE_ROW_SELECTOR,
  clampOffset,
  offsetsKeepingVisible,
  scrollableRange,
  tableOffset,
  tableRowsAt,
  type RowGeometry,
} from "./sourceEditorTableScrollSync";

/** A 400px band over 1200px of content, its content box starting at x=100. */
const WIDE_ROW: RowGeometry = {
  clientWidth: 400,
  scrollWidth: 1200,
  scrollLeft: 0,
  contentOrigin: 100,
};

function rowElement(className = "cm-line nn-lp-table-row nn-lp-table-row-body"): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

function contentWith(...children: readonly HTMLElement[]): HTMLElement {
  const content = document.createElement("div");
  content.className = "cm-content";
  content.append(...children);
  return content;
}

describe("scrollableRange", () => {
  it("spans zero to the row's own overflow", () => {
    expect(scrollableRange(WIDE_ROW)).toEqual({ min: 0, max: 800 });
  });

  it("collapses to zero for a row that cannot scroll", () => {
    // The alignment row measured in P0 K6: `scrollWidth === clientWidth`, so it
    // sat at 0 while six rows moved to 193px.
    expect(scrollableRange({ ...WIDE_ROW, scrollWidth: 400 })).toEqual({ min: 0, max: 0 });
  });
});

describe("clampOffset", () => {
  it("returns an offset already inside the range", () => {
    expect(clampOffset(120, { min: 100, max: 300 })).toBe(120);
  });

  it("stops at the range's lower bound", () => {
    expect(clampOffset(0, { min: 100, max: 300 })).toBe(100);
  });

  it("stops at the range's upper bound", () => {
    expect(clampOffset(9999, { min: 100, max: 300 })).toBe(300);
  });
});

describe("offsetsKeepingVisible", () => {
  it("bounds the offset by the span's own edges", () => {
    // Span at viewport x 700..708 over a row whose content box starts at 100
    // and is not scrolled: content x 600..608. Scrolled past 600 and the span's
    // left edge leaves the band; scrolled short of 208 and its right edge does.
    expect(offsetsKeepingVisible(WIDE_ROW, { left: 700, right: 708 }))
      .toEqual({ min: 208, max: 600 });
  });

  it("reads the span in content coordinates, not viewport ones", () => {
    // The same character, with the row scrolled 200px: it has moved 200px left
    // on screen but has not moved in the document, so the band is unchanged.
    expect(offsetsKeepingVisible({ ...WIDE_ROW, scrollLeft: 200 }, { left: 500, right: 508 }))
      .toEqual({ min: 208, max: 600 });
  });

  it("never asks for an offset the row cannot reach", () => {
    // Content x 1150..1158 in a row that can only scroll to 800. The upper
    // bound wants 1150 and is held at 800; the lower bound, 758, is genuine.
    expect(offsetsKeepingVisible(WIDE_ROW, { left: 1250, right: 1258 }))
      .toEqual({ min: 758, max: 800 });
  });

  it("shows the start of a span wider than the band", () => {
    // 500px of span in a 400px band cannot be satisfied at both edges. Showing
    // the start is the readable half; the alternative hides where you are.
    expect(offsetsKeepingVisible(WIDE_ROW, { left: 200, right: 700 }))
      .toEqual({ min: 100, max: 100 });
  });
});

describe("tableOffset", () => {
  const scrollable = (scrollLeft: number): RowGeometry => ({ ...WIDE_ROW, scrollLeft });
  const stuck: RowGeometry = { ...WIDE_ROW, scrollWidth: 400, scrollLeft: 0 };

  it("ignores a row that cannot scroll", () => {
    // Without this the alignment row drags the whole table back to column one.
    expect(tableOffset([scrollable(193), stuck, scrollable(193)])).toBe(193);
  });

  it("takes the furthest offset any row still holds", () => {
    // A rebuilt row arrives at 0. Its siblings carry the table's real offset.
    expect(tableOffset([scrollable(0), scrollable(193)])).toBe(193);
  });

  it("is zero when no row can scroll", () => {
    expect(tableOffset([stuck, stuck])).toBe(0);
  });
});

describe("tableRowsAt", () => {
  it("collects the contiguous run of row lines around one row", () => {
    const rows = [rowElement(), rowElement(), rowElement()];
    contentWith(document.createElement("p"), ...rows, document.createElement("p"));

    expect(tableRowsAt(rows[1]!)).toEqual(rows);
  });

  it("stops at a line that is not a table row", () => {
    // Two tables separated by a paragraph are two scroll regions, not one.
    const first = [rowElement(), rowElement()];
    const second = [rowElement(), rowElement()];
    contentWith(...first, document.createElement("p"), ...second);

    expect(tableRowsAt(first[0]!)).toEqual(first);
    expect(tableRowsAt(second[1]!)).toEqual(second);
  });

  it("returns the row alone when it has no siblings", () => {
    const only = rowElement();
    contentWith(only);

    expect(tableRowsAt(only)).toEqual([only]);
  });
});

describe("TABLE_ROW_SELECTOR", () => {
  it("matches every row line CT-1 freezes", () => {
    // The producer is P3b and the selector is here, so nothing goes red if the
    // two drift. This is what goes red. The class names come from the committed
    // fixture, never from a literal copied into this file.
    const classNames = TABLE_CONTRACT_FIXTURE.flatMap((table) =>
      table.rows.map((row) => row.lineClassName));
    expect(classNames.length).toBeGreaterThan(0);

    for (const className of classNames) {
      expect(rowElement(className).matches(TABLE_ROW_SELECTOR)).toBe(true);
    }
  });

  it("does not match an ordinary line", () => {
    expect(rowElement("cm-line").matches(TABLE_ROW_SELECTOR)).toBe(false);
  });
});
