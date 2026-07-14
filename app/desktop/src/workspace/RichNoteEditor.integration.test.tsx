// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RichNoteEditor } from "./RichNoteEditor";

vi.mock("../lib/api", () => ({
  onMenu: vi.fn(() => Promise.resolve(() => {})),
}));

describe("RichNoteEditor with the real MDXEditor package", () => {
  it("passes the mounted package round-trip gate for representative Markdown", async () => {
    const markdown = "## Active learning\n\nPlain **strong** and *emphasis*.";
    const onFallback = vi.fn();

    render(
      <RichNoteEditor
        document={{
          revision: "rev-1",
          body: markdown,
          blocks: [{
            id: "block-1",
            leadingSeparator: "",
            markdown,
            trailingSeparator: "",
          }],
        }}
        body={markdown}
        sourceRelPath="Current.md"
        onBodyChange={vi.fn()}
        onFallback={onFallback}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );

    await waitFor(() => {
      const editor = screen.getByRole("textbox", { name: "Note content" });
      expect(editor).toBeVisible();
      expect(editor.closest(".nn-rich-editor")).toHaveAttribute("aria-busy", "false");
    });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("prevents normal, middle-click, and context-menu navigation from content and link previews", async () => {
    const markdown = "[outside](https://example.com)";
    render(
      <RichNoteEditor
        document={{
          revision: "rev-1",
          body: markdown,
          blocks: [{
            id: "block-1",
            leadingSeparator: "",
            markdown,
            trailingSeparator: "",
          }],
        }}
        body={markdown}
        sourceRelPath="Current.md"
        onBodyChange={vi.fn()}
        onFallback={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    let clickWasPrevented = false;
    const observeClick = (event: MouseEvent) => {
      clickWasPrevented = event.defaultPrevented;
    };
    window.addEventListener("click", observeClick);
    try {
      const contentLink = await screen.findByRole("link", { name: "outside" });
      await user.click(contentLink);
      expect(clickWasPrevented).toBe(true);

      const contentMiddleClick = new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      });
      contentLink.dispatchEvent(contentMiddleClick);
      expect(contentMiddleClick.defaultPrevented).toBe(true);

      const contentContextMenu = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      contentLink.dispatchEvent(contentContextMenu);
      expect(contentContextMenu.defaultPrevented).toBe(true);

      clickWasPrevented = false;
      const previewLink = await screen.findByRole("link", {
        name: "https://example.com",
      });
      await user.click(previewLink);
      expect(clickWasPrevented).toBe(true);

      const previewMiddleClick = new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      });
      previewLink.dispatchEvent(previewMiddleClick);
      expect(previewMiddleClick.defaultPrevented).toBe(true);

      const previewContextMenu = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      previewLink.dispatchEvent(previewContextMenu);
      expect(previewContextMenu.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener("click", observeClick);
    }
  });

  it("opens a validated relative note through the preview without removing link editing", async () => {
    const markdown = "[inside](Deep%20Work.md#Section)";
    const onOpenLink = vi.fn();
    render(
      <RichNoteEditor
        document={{
          revision: "rev-1",
          body: markdown,
          blocks: [{
            id: "block-1",
            leadingSeparator: "",
            markdown,
            trailingSeparator: "",
          }],
        }}
        body={markdown}
        sourceRelPath="Areas/Current.md"
        noteIndex={[{ relPath: "Areas/Deep Work.md", stem: "deep work" }]}
        onOpenLink={onOpenLink}
        onBodyChange={vi.fn()}
        onFallback={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "inside" }));

    expect(
      await screen.findByRole("button", { name: "Edit link URL" }),
    ).toBeVisible();
    expect(onOpenLink).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("link", { name: "Deep%20Work.md#Section" }),
    );

    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("Areas/Deep Work.md");
  });
});
