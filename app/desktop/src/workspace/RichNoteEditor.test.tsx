// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ComponentProps,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let editorInstances = 0;
let latestEditorProps: Record<string, unknown> | null = null;
let emitMarkdown: ((markdown: string, normalized?: boolean) => void) | null = null;
let storedMarkdown = "";
let setMarkdownCalls: string[] = [];
let linkDialogOptions: { onClickLinkCallback?: (url: string) => void } | undefined;

vi.mock("@mdxeditor/editor", async () => {
  const MockEditor = forwardRef(function MockEditor(
    props: ComponentProps<"div"> & {
      markdown: string;
      onChange?: (markdown: string, normalized: boolean) => void;
    },
    ref,
  ) {
    const [markdown, setMarkdown] = useState(props.markdown);
    useEffect(() => {
      editorInstances += 1;
    }, []);
    latestEditorProps = props as unknown as Record<string, unknown>;
    storedMarkdown = markdown;
    emitMarkdown = (next, normalized = false) => {
      storedMarkdown = next;
      setMarkdown(next);
      props.onChange?.(next, normalized);
    };
    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => storedMarkdown,
        setMarkdown: (next: string) => {
          setMarkdownCalls.push(next);
          storedMarkdown = next;
          setMarkdown(next);
        },
        focus: vi.fn(),
      }),
      [],
    );
    return (
      <div
        role="textbox"
        contentEditable
        aria-label="Note content"
        suppressContentEditableWarning
      >
        {markdown}
      </div>
    );
  });
  const plugin = () => ({ init: vi.fn() });
  return {
    MDXEditor: MockEditor,
    applyBlockType$: {},
    applyFormat$: {},
    codeBlockPlugin: plugin,
    headingsPlugin: plugin,
    linkDialogPlugin: vi.fn((options) => {
      linkDialogOptions = options;
      return { linkDialogOptions: options };
    }),
    linkPlugin: vi.fn((options) => ({ options })),
    listsPlugin: plugin,
    markdownShortcutPlugin: plugin,
    openLinkEditDialog$: {},
    quotePlugin: plugin,
    realmPlugin: vi.fn(() => plugin),
    thematicBreakPlugin: plugin,
    useCodeBlockEditorContext: () => ({ setCode: vi.fn() }),
  };
});

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, onMenu: vi.fn(() => Promise.resolve(vi.fn())) };
});

import { RichNoteEditor } from "./RichNoteEditor";
import type { RichSourceDocument } from "./richEditorAdapter";

function document(body = "Alpha\n"): RichSourceDocument {
  return {
    revision: `rev:${body}`,
    body,
    blocks: [{ id: "a", leadingSeparator: "", markdown: body, trailingSeparator: "" }],
  };
}

beforeEach(() => {
  cleanup();
  editorInstances = 0;
  latestEditorProps = null;
  emitMarkdown = null;
  storedMarkdown = "";
  setMarkdownCalls = [];
  linkDialogOptions = undefined;
});

async function waitUntilReady() {
  const editor = await screen.findByRole("textbox", { name: "Note content" });
  await waitFor(() =>
    expect(editor.closest(".nn-rich-editor")).toHaveAttribute("aria-busy", "false"),
  );
  return editor;
}

describe("RichNoteEditor", () => {
  it("mounts one reading-styled editor and proves exact source round trip", async () => {
    render(
      <RichNoteEditor
        document={document()}
        body={"Alpha\n"}
        sourceRelPath="Current.md"
        onBodyChange={vi.fn()}
        onFallback={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );

    expect(await waitUntilReady()).toBeTruthy();
    expect(editorInstances).toBe(1);
    expect(setMarkdownCalls).toEqual(["Alpha"]);
  });

  it("preserves the source terminal LF outside the package while editing", async () => {
    const onBodyChange = vi.fn();
    render(
      <RichNoteEditor
        document={document()}
        body={"Alpha\n"}
        sourceRelPath="Current.md"
        onBodyChange={onBodyChange}
        onFallback={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    await waitUntilReady();

    act(() => emitMarkdown?.("Alpha changed"));

    expect(onBodyChange).toHaveBeenCalledWith("Alpha changed\n");
  });

  it("reuses the mounted editor when switching rich-note tabs", async () => {
    const { rerender } = render(
      <RichNoteEditor
        document={document("Alpha")}
        body="Alpha"
        sourceRelPath="Current.md"
        onBodyChange={vi.fn()}
        onFallback={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    await waitUntilReady();
    const firstInstanceCount = editorInstances;

    rerender(
      <RichNoteEditor
        document={document("Beta")}
        body="Beta"
        sourceRelPath="Other.md"
        onBodyChange={vi.fn()}
        onFallback={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );

    await waitFor(() => expect(storedMarkdown).toBe("Beta"));
    expect(editorInstances).toBe(firstInstanceCount);
    expect(screen.getAllByRole("textbox", { name: "Note content" })).toHaveLength(1);
  });

  it("routes keyboard undo and redo to the active tab history", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(
      <RichNoteEditor
        document={document("Alpha")}
        body="Alpha"
        sourceRelPath="Current.md"
        onBodyChange={vi.fn()}
        onFallback={vi.fn()}
        onUndo={onUndo}
        onRedo={onRedo}
      />,
    );
    const editor = await waitUntilReady();
    editor.focus();

    await user.keyboard("{Meta>}z{/Meta}");
    await user.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");

    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledOnce();
  });

  it("uses the same safe URL policy in the package link plugin", async () => {
    render(
      <RichNoteEditor
        document={document("Alpha")}
        body="Alpha"
        sourceRelPath="Current.md"
        onBodyChange={vi.fn()}
        onFallback={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    await waitUntilReady();

    const plugins = latestEditorProps?.plugins as Array<{ options?: { validateUrl?: (url: string) => boolean } }>;
    const validateUrl = plugins.find((entry) => entry.options)?.options?.validateUrl;
    expect(validateUrl?.("https://example.com")).toBe(true);
    expect(validateUrl?.("javascript:alert(1)")).toBe(false);
  });

  it("opens only validated, resolved relative Markdown links in-app", async () => {
    const onOpenLink = vi.fn();
    render(
      <RichNoteEditor
        document={document("[inside](Areas/Deep%20Work.md#Section)")}
        body="[inside](Areas/Deep%20Work.md#Section)"
        sourceRelPath="Current.md"
        noteIndex={[{ relPath: "Areas/Deep Work.md", stem: "deep work" }]}
        onOpenLink={onOpenLink}
        onBodyChange={vi.fn()}
        onFallback={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    await waitUntilReady();

    linkDialogOptions?.onClickLinkCallback?.("Areas/Deep%20Work.md#Section");
    linkDialogOptions?.onClickLinkCallback?.("https://example.com/Deep%20Work.md");
    linkDialogOptions?.onClickLinkCallback?.("/Areas/Deep%20Work.md");
    linkDialogOptions?.onClickLinkCallback?.("..%2FAreas/Deep%20Work.md");
    linkDialogOptions?.onClickLinkCallback?.("javascript:alert(1)");

    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("Areas/Deep Work.md");
  });

  it("resolves safe sibling links from the current note folder but keeps parent links inert", async () => {
    const onOpenLink = vi.fn();
    render(
      <RichNoteEditor
        document={document("[sibling](Peer.md) [nested](Sibling/Peer.md)")}
        body="[sibling](Peer.md) [nested](Sibling/Peer.md)"
        sourceRelPath="Areas/Current.md"
        noteIndex={[
          { relPath: "Areas/Peer.md", stem: "peer" },
          { relPath: "Areas/Sibling/Peer.md", stem: "peer" },
        ]}
        onOpenLink={onOpenLink}
        onBodyChange={vi.fn()}
        onFallback={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    await waitUntilReady();

    linkDialogOptions?.onClickLinkCallback?.("Peer.md");
    linkDialogOptions?.onClickLinkCallback?.("Sibling/Peer.md");
    linkDialogOptions?.onClickLinkCallback?.("../Peer.md");
    linkDialogOptions?.onClickLinkCallback?.("../../Peer.md");

    expect(onOpenLink).toHaveBeenNthCalledWith(1, "Areas/Peer.md");
    expect(onOpenLink).toHaveBeenNthCalledWith(2, "Areas/Sibling/Peer.md");
    expect(onOpenLink).toHaveBeenCalledTimes(2);
  });

  it("draws a persistent high-contrast focus boundary around the rich editor", async () => {
    render(
      <RichNoteEditor
        document={document("Alpha")}
        body="Alpha"
        sourceRelPath="Current.md"
        onBodyChange={vi.fn()}
        onFallback={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    const editor = await waitUntilReady();

    expect(editor.closest(".nn-rich-editor")).toHaveClass(
      "focus-within:ring-2",
      "focus-within:ring-ring",
      "focus-within:ring-offset-2",
    );
  });
});
