// The editor's line-height is a computed-style fact, so only a real browser can
// check it. jsdom resolves no cascade and would pass whatever we wrote.
//
// Issue #92: `styles.css` sets `line-height: 1.8` on `.nn-source-editor
// .cm-editor`, but CodeMirror's base theme declares `lineHeight: 1.4` directly
// on `.cm-scroller` (@codemirror/view index.js:6813). A descendant's own
// declaration beats inheritance from an ancestor, so the design system's value
// never reached a single line of text.

import { describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import { SourceNoteEditor } from "./SourceNoteEditor";
import "../styles.css";

const NOTE = "# Heading\n\nA paragraph of body text that should sit on the design system's rhythm.";

describe("editor typography", () => {
  let root: Root | null = null;

  it("applies the design system's line-height to rendered lines", async () => {
    const host = document.createElement("div");
    host.className = "nn-source-editor";
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        <SourceNoteEditor
          noteIndexStatus="ready"
          sessionKey="typography"
          loadedHash="typography"
          value={NOTE}
          onChange={() => {}}
          onPreservationError={() => {}}
        />,
      );
    });

    const line = host.querySelector<HTMLElement>(".cm-line")!;
    const style = getComputedStyle(line);
    const fontSize = Number.parseFloat(style.fontSize);
    const lineHeight = Number.parseFloat(style.lineHeight);

    root.unmount();
    host.remove();
    root = null;

    // 1.8 is the token. CodeMirror's base theme would give 1.4.
    expect(fontSize).toBeGreaterThan(0);
    expect(lineHeight / fontSize).toBeCloseTo(1.8, 1);
  });
});
