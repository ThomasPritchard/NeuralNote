import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

const menu = vi.hoisted(() => ({
  handler: null as null | ((event: { action: string }) => void),
}));

vi.mock("../lib/api", () => ({
  onMenu: vi.fn((handler: (event: { action: string }) => void) => {
    menu.handler = handler;
    return Promise.resolve(() => {});
  }),
}));

import { SourceNoteEditor } from "./SourceNoteEditor";
import {
  acquireSourceEditorSession,
  clearSourceEditorSessions,
  updateSourceEditorSession,
} from "./sourceEditorSession";
import { refreshSourceEditorDecorations } from "./sourceEditorDecorations";

afterEach(() => {
  menu.handler = null;
  clearSourceEditorSessions();
});

describe("SourceNoteEditor", () => {
  it("mounts one directly editable, accessible multiline CodeMirror surface", () => {
    const { container } = render(
      <SourceNoteEditor
        sessionKey="tab-1"
        loadedHash="hash-1"
        value="# Exact source"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Note content" });
    expect(editor).toHaveAttribute("aria-multiline", "true");
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(editor).toHaveTextContent("# Exact source");
    expect(container.querySelector(".nn-lp-heading-1")).toHaveAttribute("role", "heading");
    expect(container.querySelector(".nn-lp-heading-1")).toHaveAttribute("aria-level", "1");
  });

  it("turns a derived title placeholder into source-backed editable Markdown", async () => {
    const onChange = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-derived-title"
        loadedHash="hash-title"
        value="The hierarchy follows a basic model."
        derivedTitle="Azure Hierarchy"
        onChange={onChange}
        onPreservationError={vi.fn()}
      />,
    );

    const title = screen.getByRole("button", { name: "Edit title: Azure Hierarchy" });
    await userEvent.click(title);
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        "# Azure Hierarchy\n\nThe hierarchy follows a basic model.",
      );
    });
    expect(screen.getByRole("textbox", { name: "Note content" })).toHaveTextContent(
      "Azure Hierarchy",
    );
    expect(screen.queryByRole("button", { name: "Edit title: Azure Hierarchy" })).toBeNull();
  });

  it("preserves CRLF when activating the editable title with the keyboard", async () => {
    const onChange = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-derived-title-crlf"
        loadedHash="hash-title-crlf"
        value={"---\r\ntags: [azure]\r\n---\r\nBody"}
        derivedTitle="Azure Hierarchy"
        onChange={onChange}
        onPreservationError={vi.fn()}
      />,
    );

    const title = screen.getByRole("button", { name: "Edit title: Azure Hierarchy" });
    title.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        "---\r\ntags: [azure]\r\n---\r\n# Azure Hierarchy\r\n\r\nBody",
      );
    });
  });

  it("keeps an EOF frontmatter delimiter separate when activating the title", async () => {
    const onChange = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-derived-title-frontmatter-eof"
        loadedHash="hash-title-frontmatter-eof"
        value={"---\ntitle: Azure\n---"}
        derivedTitle="Azure Hierarchy"
        onChange={onChange}
        onPreservationError={vi.fn()}
      />,
    );

    const title = screen.getByRole("button", { name: "Edit title: Azure Hierarchy" });
    await userEvent.click(title);
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith("---\ntitle: Azure\n---\n# Azure Hierarchy");
    });
  });

  it("emits exact reconstructed CRLF source after typing and emits nothing for selection-only updates", async () => {
    const onChange = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-1"
        loadedHash="hash-1"
        value={"one\r\ntwo"}
        onChange={onChange}
        onPreservationError={vi.fn()}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Note content" });

    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(editor);
    await userEvent.keyboard("{Control>}{End}{/Control}{Enter}three");

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("one\r\ntwo\r\nthree"));
  });

  it("keeps its source session when React unmounts and remounts the same tab revision", async () => {
    const onChange = vi.fn();
    const props = {
      sessionKey: "tab-1",
      loadedHash: "hash-1",
      value: "seed",
      onChange,
      onPreservationError: vi.fn(),
    };
    const first = render(<SourceNoteEditor {...props} />);
    const editor = screen.getByRole("textbox", { name: "Note content" });
    await userEvent.click(editor);
    await userEvent.keyboard("{End}X");
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("seedX"));
    first.unmount();

    render(<SourceNoteEditor {...props} />);
    expect(screen.getByRole("textbox", { name: "Note content" })).toHaveTextContent("seedX");
  });

  it("toggles task source through an accessible checkbox without fetching content", async () => {
    const onChange = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-task"
        loadedHash="hash-task"
        value="- [ ] open"
        onChange={onChange}
        onPreservationError={vi.fn()}
      />,
    );

    await userEvent.click(await screen.findByRole("checkbox", { name: "Mark task complete" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("- [x] open"));
  });

  it("renders an inactive Markdown table semantically and reveals its exact source for editing", async () => {
    const source = [
      "# Commitments",
      "",
      "| Start date | Commitment |",
      "| --- | --- |",
      "| 2026-04-03 | DJ gig |",
    ].join("\n");
    const { container } = render(
      <SourceNoteEditor
        sessionKey="tab-table"
        loadedHash="hash-table"
        value={source}
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
      />,
    );

    const table = screen.getByRole("table", { name: "Markdown table" });
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Start date",
      "Commitment",
    ]);
    expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "2026-04-03",
      "DJ gig",
    ]);
    expect(container.querySelector(".cm-content")).not.toHaveTextContent("| --- | --- |");

    await userEvent.click(table);

    await waitFor(() => expect(screen.queryByRole("table", { name: "Markdown table" })).toBeNull());
    expect(container.querySelector(".cm-content")).toHaveTextContent("| --- | --- |");
  });

  it("renders inline Markdown as table cell text instead of exposing its source markers", () => {
    const source = [
      "# Commitments",
      "",
      "| Status | Note |",
      "| --- | --- |",
      "| **Urgent** | [Details](Details.md) |",
    ].join("\n");
    render(
      <SourceNoteEditor
        sessionKey="tab-table-inline"
        loadedHash="hash-table-inline"
        value={source}
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "Urgent",
      "Details",
    ]);
  });

  it("preserves bare URLs and autolinks rendered inside table cells", () => {
    const source = [
      "# Links",
      "",
      "| Bare URL | Autolink |",
      "| --- | --- |",
      "| https://example.com | <https://example.org> |",
    ].join("\n");
    render(
      <SourceNoteEditor
        sessionKey="tab-table-urls"
        loadedHash="hash-table-urls"
        value={source}
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "https://example.com",
      "https://example.org",
    ]);
  });

  it("returns unchanged YAML source to the visual properties view", async () => {
    const source = "---\ntags: [old]\n---\n# My Note\n\nBody";
    render(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-round-trip"
        loadedHash="hash-frontmatter-round-trip"
        value={source}
        frontmatter={{ tags: ["old"] }}
        frontmatterRaw="tags: [old]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={vi.fn()}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Note content" });
    const view = EditorView.findFromDOM(editor)!;
    await userEvent.click(screen.getByRole("button", { name: "Edit note properties" }));
    expect(editor).toHaveTextContent("tags: [old]");

    await userEvent.click(screen.getByRole("button", { name: "Done editing note properties" }));

    expect(screen.getByRole("button", { name: "Edit note properties" })).toBeInTheDocument();
    expect(editor).not.toHaveTextContent("tags: [old]");
    expect(screen.getByRole("button", { name: "Search for #old" })).toBeInTheDocument();
    expect(view.state.selection.main.head).toBeGreaterThanOrEqual(source.indexOf("# My Note"));
  });

  it("folds edited YAML without showing stale properties until a parsed revision reloads", async () => {
    const source = "---\ntags: [old]\n---\n# My Note\n\nBody";
    const { rerender } = render(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-edit"
        loadedHash="hash-before-save"
        value={source}
        frontmatter={{ tags: ["old"] }}
        frontmatterRaw="tags: [old]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit note properties" }));
    const editor = screen.getByRole("textbox", { name: "Note content" });
    const view = EditorView.findFromDOM(editor)!;
    act(() => view.dispatch({
      changes: { from: source.indexOf("old"), to: source.indexOf("old") + 3, insert: "new" },
      selection: { anchor: view.state.doc.length },
    }));

    expect(editor).toHaveTextContent("tags: [new]");
    expect(editor).not.toHaveTextContent("tags: [old]");

    await userEvent.click(screen.getByRole("button", { name: "Done editing note properties" }));

    expect(editor).not.toHaveTextContent("tags: [new]");
    expect(screen.queryByRole("button", { name: "Search for #old" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Properties changed. Save the note to refresh this preview.",
    );
    expect(screen.getByRole("button", { name: "Edit note properties" })).toBeInTheDocument();

    const saved = source.replace("old", "new");
    rerender(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-edit"
        loadedHash="hash-before-save"
        value={saved}
        frontmatter={{ tags: ["new"] }}
        frontmatterRaw="tags: [new]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit note properties" })).toBeInTheDocument();
    }, { timeout: 5_000 });
    expect(screen.getByRole("textbox", { name: "Note content" })).not.toHaveTextContent("tags: [new]");
    expect(screen.getByRole("button", { name: "Search for #new" })).toBeInTheDocument();
  });

  it("routes visual YAML tag chips through the inline-tag search callback", async () => {
    const onSearchTag = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-tags"
        loadedHash="hash-frontmatter-tags"
        value={"---\ntags: [reference, '#ops/nested', 7]\naliases: [reference]\n---\nBody"}
        frontmatter={{
          tags: ["reference", "#ops/nested", 7],
          aliases: ["reference"],
        }}
        frontmatterRaw={"tags: [reference, '#ops/nested', 7]\naliases: [reference]"}
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={onSearchTag}
      />,
    );

    const reference = screen.getByRole("button", { name: "Search for #reference" });
    const nested = screen.getByRole("button", { name: "Search for #ops/nested" });
    expect(screen.queryByRole("button", { name: "Search for #7" })).toBeNull();

    await userEvent.click(reference);
    await userEvent.click(nested);

    expect(onSearchTag).toHaveBeenNthCalledWith(1, "#reference");
    expect(onSearchTag).toHaveBeenNthCalledWith(2, "#ops/nested");
  });

  it("keeps malformed edited YAML visible when it can no longer be folded", async () => {
    const source = "---\ntags: [old]\n---\nBody";
    render(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-invalid-edit"
        loadedHash="hash-frontmatter-invalid-edit"
        value={source}
        frontmatter={{ tags: ["old"] }}
        frontmatterRaw="tags: [old]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit note properties" }));
    const editor = screen.getByRole("textbox", { name: "Note content" });
    const view = EditorView.findFromDOM(editor)!;
    const closingDelimiter = source.indexOf("---", 3);
    act(() => view.dispatch({
      changes: { from: closingDelimiter, to: closingDelimiter + 3, insert: "" },
    }));

    await userEvent.click(screen.getByRole("button", { name: "Done editing note properties" }));

    expect(view.state.doc.toString()).toContain("tags: [old]");
    expect(editor).toHaveTextContent("tags: old");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Restore the frontmatter delimiters before returning to Properties.",
    );
    expect(screen.queryByRole("button", { name: "Search for #old" })).toBeNull();
  });

  it("does not fold newer YAML when an older save response is parsed", async () => {
    const source = "---\ntags: [old]\n---\nBody";
    const { rerender } = render(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-save-race"
        loadedHash="hash-frontmatter-save-race"
        value={source}
        frontmatter={{ tags: ["old"] }}
        frontmatterRaw="tags: [old]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit note properties" }));
    const editor = screen.getByRole("textbox", { name: "Note content" });
    const view = EditorView.findFromDOM(editor)!;
    const oldFrom = source.indexOf("old");
    act(() => view.dispatch({
      changes: { from: oldFrom, to: oldFrom + 3, insert: "saved" },
    }));
    act(() => view.dispatch({
      changes: { from: oldFrom, to: oldFrom + 5, insert: "latest" },
    }));

    rerender(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-save-race"
        loadedHash="hash-frontmatter-save-race"
        value={source.replace("old", "latest")}
        frontmatter={{ tags: ["saved"] }}
        frontmatterRaw="tags: [saved]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole(
        "button",
        { name: "Done editing note properties" },
      )).toBeInTheDocument();
    }, { timeout: 5_000 });
    expect(view.state.doc.toString()).toContain("tags: [latest]");
    expect(screen.queryByRole("button", { name: "Search for #saved" })).toBeNull();
  });

  it("keeps synchronized saved YAML visible until the user finishes editing properties", async () => {
    const source = "---\ntags: [old]\n---\nBody";
    const { rerender } = render(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-save-while-open"
        loadedHash="hash-frontmatter-save-while-open"
        value={source}
        frontmatter={{ tags: ["old"] }}
        frontmatterRaw="tags: [old]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit note properties" }));
    const editor = screen.getByRole("textbox", { name: "Note content" });
    const view = EditorView.findFromDOM(editor)!;
    const oldFrom = source.indexOf("old");
    act(() => view.dispatch({
      changes: { from: oldFrom, to: oldFrom + 3, insert: "saved" },
    }));

    rerender(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-save-while-open"
        loadedHash="hash-frontmatter-save-while-open"
        value={source.replace("old", "saved")}
        frontmatter={{ tags: ["saved"] }}
        frontmatterRaw="tags: [saved]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole(
        "button",
        { name: "Done editing note properties" },
      )).toBeInTheDocument();
    });
    expect(editor).toHaveTextContent("tags: [saved]");
    expect(screen.queryByRole("button", { name: "Search for #saved" })).toBeNull();

    act(() => view.dispatch({
      changes: { from: oldFrom + 5, insert: "-latest" },
    }));
    expect(view.state.doc.toString()).toContain("tags: [saved-latest]");
    expect(editor).toHaveTextContent("tags: [saved-latest]");
  });

  it("marks a visual properties preview stale when undo changes hidden YAML", async () => {
    const source = "---\ntags: [old]\n---\nBody";
    const { rerender } = render(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-hidden-undo"
        loadedHash="hash-frontmatter-hidden-undo"
        value={source}
        frontmatter={{ tags: ["old"] }}
        frontmatterRaw="tags: [old]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit note properties" }));
    const editor = screen.getByRole("textbox", { name: "Note content" });
    const view = EditorView.findFromDOM(editor)!;
    const oldFrom = source.indexOf("old");
    act(() => view.dispatch({
      changes: { from: oldFrom, to: oldFrom + 3, insert: "new" },
    }));

    rerender(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-hidden-undo"
        loadedHash="hash-frontmatter-hidden-undo"
        value={source.replace("old", "new")}
        frontmatter={{ tags: ["new"] }}
        frontmatterRaw="tags: [new]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole(
        "button",
        { name: "Done editing note properties" },
      )).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: "Done editing note properties" }));
    expect(screen.getByRole("button", { name: "Search for #new" })).toBeInTheDocument();

    act(() => {
      expect(undo(view)).toBe(true);
    });

    expect(view.state.doc.toString()).toContain("tags: [old]");
    expect(screen.queryByRole("button", { name: "Search for #new" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Properties changed. Save the note to refresh this preview.",
    );
  });

  it("keeps YAML tag values inert when no search callback is available", () => {
    render(
      <SourceNoteEditor
        sessionKey="tab-frontmatter-tags-inert"
        loadedHash="hash-frontmatter-tags-inert"
        value={"---\ntags: [reference]\n---\nBody"}
        frontmatter={{ tags: ["reference"] }}
        frontmatterRaw="tags: [reference]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Search for #reference" })).toBeNull();
    expect(screen.getByText("reference")).toBeInTheDocument();
  });

  it("toggles task source with Space and Enter", async () => {
    const onChange = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-task-keyboard"
        loadedHash="hash-task"
        value="- [ ] open"
        onChange={onChange}
        onPreservationError={vi.fn()}
      />,
    );
    const checkbox = await screen.findByRole("checkbox", { name: "Mark task complete" });
    checkbox.focus();
    await userEvent.keyboard(" ");
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("- [x] open"));
    const checkedCheckbox = await screen.findByRole("checkbox", { name: "Mark task incomplete" });
    checkedCheckbox.focus();
    const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Note content" }));
    expect(view).not.toBeNull();
    act(() => view?.dispatch({ effects: refreshSourceEditorDecorations.of(null) }));
    expect(document.activeElement).toBe(checkedCheckbox);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("- [ ] open"));
  });

  it("applies native Format actions only to the focused source editor", async () => {
    const onChange = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-format"
        loadedHash="hash-format"
        value="word"
        onChange={onChange}
        onPreservationError={vi.fn()}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Note content" });
    await userEvent.click(editor);
    await userEvent.keyboard("{Control>}a{/Control}");
    act(() => menu.handler?.({ action: "format-bold" }));

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("**word**"));
  });

  it("retains and formats multiple selections in the actual editor", async () => {
    const onChange = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-multicaret"
        loadedHash="hash-format"
        value="one two"
        onChange={onChange}
        onPreservationError={vi.fn()}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Note content" });
    const view = EditorView.findFromDOM(editor)!;
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(4, 7),
      ]),
    });
    editor.focus();
    act(() => menu.handler?.({ action: "format-bold" }));

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("**one** **two**"));
  });

  it("keeps a recoverable dirty draft when exact-source preservation fails", async () => {
    const sourceSession = acquireSourceEditorSession("tab-ambiguous", "hash-ambiguous", "one\r\ntwo", []);
    updateSourceEditorSession("tab-ambiguous", {
      ...sourceSession,
      source: { ...sourceSession.source, separators: [] },
    });
    const onChange = vi.fn();
    const onPreservationError = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-ambiguous"
        loadedHash="hash-ambiguous"
        value="one\r\ntwo"
        onChange={onChange}
        onPreservationError={onPreservationError}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Note content" });
    await userEvent.click(editor);
    await userEvent.keyboard("{Control>}{End}{/Control}X");

    await waitFor(() => expect(onPreservationError).toHaveBeenCalledWith(expect.stringContaining("Cannot preserve")));
    expect(onChange).toHaveBeenLastCalledWith("one\ntwoX");
  });

  it("restores the editor's own scroll position after a tab remount", () => {
    const props = {
      sessionKey: "tab-scroll",
      loadedHash: "hash-scroll",
      value: Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n"),
      onChange: vi.fn(),
      onPreservationError: vi.fn(),
    };
    const first = render(<SourceNoteEditor {...props} />);
    const scroller = first.container.querySelector<HTMLElement>(".cm-scroller")!;
    scroller.scrollTop = 420;
    first.unmount();

    const second = render(<SourceNoteEditor {...props} />);
    expect(second.container.querySelector<HTMLElement>(".cm-scroller")?.scrollTop).toBe(420);
  });

  it("navigates normally clicked wikilinks resolved by the vault index", () => {
    const onOpenLink = vi.fn();
    const { container } = render(
      <SourceNoteEditor
        sessionKey="tab-links"
        loadedHash="hash-links"
        value="x [[Daily]] [[https://evil.example/x]]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        noteIndex={[{ relPath: "Daily.md", stem: "daily" }]}
        onOpenLink={onOpenLink}
      />,
    );

    const resolved = container.querySelector(".nn-lp-wikilink-resolved")!;
    expect(resolved).toHaveAttribute("title", "Open Daily.md");
    expect(resolved).toHaveAttribute("role", "link");
    expect(resolved).toHaveAttribute("tabindex", "0");
    fireEvent.mouseDown(resolved, { button: 0 });
    expect(onOpenLink).toHaveBeenCalledWith("Daily.md");
    fireEvent.keyDown(container.querySelector(".nn-lp-wikilink-resolved")!, { key: "Enter" });
    expect(onOpenLink).toHaveBeenCalledTimes(2);
    fireEvent.click(container.querySelector(".nn-lp-wikilink-resolved")!);
    expect(onOpenLink).toHaveBeenCalledTimes(3);
    fireEvent.mouseDown(container.querySelector(".nn-lp-wikilink-unresolved")!, { button: 0 });
    expect(onOpenLink).toHaveBeenCalledTimes(3);
    expect(container.querySelector("a")).toBeNull();
  });

  it("keeps a boundary-selected wikilink clickable while the editor is unfocused", () => {
    const { container } = render(
      <SourceNoteEditor
        sessionKey="tab-unfocused-boundary-link"
        loadedHash="hash-unfocused-boundary-link"
        value="[[Daily]]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        noteIndex={[{ relPath: "Daily.md", stem: "daily" }]}
        onOpenLink={vi.fn()}
      />,
    );

    expect(container.querySelector(".nn-lp-wikilink-resolved")).not.toBeNull();
  });

  it("navigates normally clicked internal Markdown links through the guarded vault resolver", () => {
    const onOpenLink = vi.fn();
    const { container } = render(
      <SourceNoteEditor
        sessionKey="tab-markdown-links"
        loadedHash="hash-markdown-links"
        value="[Azure Account](Azure%20Account.md) [unsafe](../Outside.md)"
        sourceRelPath="folder/Overview.md"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        noteIndex={[{ relPath: "folder/Azure Account.md", stem: "azure account" }]}
        onOpenLink={onOpenLink}
      />,
    );

    const links = container.querySelectorAll(".nn-lp-link");
    expect(links[0]).toHaveAttribute("title", "Open folder/Azure Account.md");
    expect(links[0]).toHaveAttribute("role", "link");
    expect(links[0]).toHaveAttribute("tabindex", "0");
    fireEvent.mouseDown(links[0]!, { button: 0 });
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("folder/Azure Account.md");
    fireEvent.keyDown(container.querySelector(".nn-lp-link")!, { key: "Enter" });
    expect(onOpenLink).toHaveBeenCalledTimes(2);
    fireEvent.click(container.querySelector(".nn-lp-link")!);
    expect(onOpenLink).toHaveBeenCalledTimes(3);
    fireEvent.mouseDown(links[1]!, { button: 0 });
    expect(onOpenLink).toHaveBeenCalledTimes(3);
  });

  it("keeps an active Markdown link editable instead of navigating it", () => {
    const onOpenLink = vi.fn();
    const { container } = render(
      <SourceNoteEditor
        sessionKey="tab-active-markdown-link"
        loadedHash="hash-active-markdown-link"
        value="before [Daily](Daily.md) after"
        sourceRelPath="Overview.md"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        noteIndex={[{ relPath: "Daily.md", stem: "daily" }]}
        onOpenLink={onOpenLink}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Note content" });
    const view = EditorView.findFromDOM(editor)!;
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 10 } });
    });
    const activeLink = container.querySelector(".nn-lp-link")!;

    expect(activeLink).not.toHaveAttribute("data-nn-markdown-target");
    expect(activeLink).not.toHaveAttribute("role");
    expect(activeLink).not.toHaveAttribute("tabindex");
    fireEvent.mouseDown(activeLink, { button: 0 });
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("refreshes mounted wikilink decorations when the vault index changes", async () => {
    const props = {
      sessionKey: "tab-index-refresh",
      loadedHash: "hash-links",
      value: "x [[Daily]]",
      onChange: vi.fn(),
      onPreservationError: vi.fn(),
    };
    const rendered = render(<SourceNoteEditor {...props} noteIndex={[]} />);
    expect(rendered.container.querySelector(".nn-lp-wikilink-unresolved")).not.toBeNull();

    rendered.rerender(
      <SourceNoteEditor
        {...props}
        noteIndex={[{ relPath: "Daily.md", stem: "daily" }]}
      />,
    );
    await waitFor(() => {
      expect(rendered.container.querySelector(".nn-lp-wikilink-resolved")).not.toBeNull();
    });
  });

  it("refreshes mounted Markdown-link navigation when the vault index changes", async () => {
    const onOpenLink = vi.fn();
    const props = {
      sessionKey: "tab-markdown-index-refresh",
      loadedHash: "hash-markdown-links",
      value: "[Daily](Daily.md)",
      sourceRelPath: "Overview.md",
      onChange: vi.fn(),
      onPreservationError: vi.fn(),
      onOpenLink,
    };
    const rendered = render(<SourceNoteEditor {...props} noteIndex={[]} />);
    expect(
      rendered.container.querySelector(".nn-lp-link[data-nn-markdown-target]"),
    ).toBeNull();
    expect(onOpenLink).not.toHaveBeenCalled();

    rendered.rerender(
      <SourceNoteEditor
        {...props}
        noteIndex={[{ relPath: "Daily.md", stem: "daily" }]}
      />,
    );
    await waitFor(() => {
      expect(
        rendered.container.querySelector(".nn-lp-link[data-nn-markdown-target='Daily.md']"),
      ).not.toBeNull();
    });
  });

  it("opens the resolved wikilink at the caret with Mod-Enter", async () => {
    const onOpenLink = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-keyboard-link"
        loadedHash="hash-links"
        value="[[Daily]]"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        noteIndex={[{ relPath: "Daily.md", stem: "daily" }]}
        onOpenLink={onOpenLink}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Note content" });
    await userEvent.click(editor);
    EditorView.findFromDOM(editor)!.dispatch({ selection: { anchor: 4 } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(onOpenLink).toHaveBeenCalledWith("Daily.md");
  });

  it("opens a resolved Markdown link at the caret with Mod-Enter", () => {
    const onOpenLink = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-markdown-link-keyboard"
        loadedHash="hash-markdown-link-keyboard"
        value="[Daily](Daily.md)"
        sourceRelPath="Overview.md"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        noteIndex={[{ relPath: "Daily.md", stem: "daily" }]}
        onOpenLink={onOpenLink}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Note content" });
    EditorView.findFromDOM(editor)!.dispatch({ selection: { anchor: 3 } });
    fireEvent.keyDown(editor, {
      key: "Enter",
      ctrlKey: true,
    });
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("Daily.md");
  });

  it("renders an inline tag as preserved source and activates it with a pointer", async () => {
    const onSearchTag = vi.fn();
    const { container } = render(
      <SourceNoteEditor
        sessionKey="tab-inline-tag"
        loadedHash="hash-inline-tag"
        value="#SaaS Software As A Service:"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={onSearchTag}
      />,
    );

    const tag = container.querySelector(".nn-lp-tag");
    expect(tag).toHaveTextContent("#SaaS");
    expect(tag).toHaveAttribute("data-nn-tag", "#SaaS");
    expect(tag).toHaveAttribute("role", "link");
    expect(tag).toHaveAttribute("aria-label", "Search for #SaaS");
    expect(tag).toHaveAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");
    expect(screen.queryByRole("heading", { name: /SaaS/i })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Note content" })).toHaveTextContent(
      "#SaaS Software As A Service:",
    );

    fireEvent.mouseDown(tag!);
    await waitFor(() => expect(onSearchTag).toHaveBeenCalledExactlyOnceWith("#SaaS"));
  });

  it("activates the inline tag at the caret with Mod-Enter", async () => {
    const onSearchTag = vi.fn();
    render(
      <SourceNoteEditor
        sessionKey="tab-inline-tag-keyboard"
        loadedHash="hash-inline-tag-keyboard"
        value="before #SaaS after"
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onSearchTag={onSearchTag}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Note content" });
    EditorView.findFromDOM(editor)!.dispatch({ selection: { anchor: 10 } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(onSearchTag).toHaveBeenCalledExactlyOnceWith("#SaaS"));
  });
});
