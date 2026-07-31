import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../styles.css";
import { SourceNoteEditor } from "./SourceNoteEditor";
import { clearSourceEditorSessions } from "./sourceEditorSession";

vi.mock("../lib/api", () => ({
  onMenu: vi.fn(async () => () => {}),
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  clearSourceEditorSessions();
});

describe("SourceNoteEditor — real-browser typography", () => {
  it("applies the 1.8 editor line-height to plain source lines", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <SourceNoteEditor
          sessionKey="issue-92"
          loadedHash="issue-92"
          value={"alpha\nbeta"}
          onChange={() => {}}
          onPreservationError={() => {}}
        />,
      );
    });

    await expect
      .poll(() => host?.querySelector<HTMLElement>(".cm-line"))
      .not.toBeNull();

    const editor = host.querySelector<HTMLElement>(".cm-editor")!;
    const line = host.querySelector<HTMLElement>(".cm-line")!;
    const fontSize = Number.parseFloat(getComputedStyle(editor).fontSize);
    const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);

    expect(lineHeight).toBeCloseTo(fontSize * 1.8, 2);
  });
});
