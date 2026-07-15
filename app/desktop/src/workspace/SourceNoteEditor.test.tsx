import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("navigates only modifier-clicked wikilinks resolved by the vault index", () => {
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

    fireEvent.mouseDown(container.querySelector(".nn-lp-wikilink-resolved")!, { metaKey: true });
    expect(onOpenLink).toHaveBeenCalledWith("Daily.md");
    fireEvent.mouseDown(container.querySelector(".nn-lp-wikilink-unresolved")!, { metaKey: true });
    expect(onOpenLink).toHaveBeenCalledTimes(1);
    expect(container.querySelector("a")).toBeNull();
  });

  it("navigates modifier-clicked internal Markdown links through the guarded vault resolver", () => {
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
    fireEvent.mouseDown(links[0]!, { metaKey: true });
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("folder/Azure Account.md");
    fireEvent.mouseDown(links[1]!, { metaKey: true });
    expect(onOpenLink).toHaveBeenCalledTimes(1);
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
    fireEvent.mouseDown(rendered.container.querySelector(".nn-lp-link")!, { metaKey: true });
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
});
