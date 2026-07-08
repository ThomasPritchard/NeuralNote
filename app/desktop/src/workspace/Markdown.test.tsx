import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NoteIndexEntry } from "./linkResolve";
import { Markdown } from "./Markdown";

// A single rich document that exercises every entry in the components map.
const RICH = [
  "# H1",
  "## H2",
  "### H3",
  "#### H4",
  "",
  "A paragraph with **bold**, _italic_, `inline code`, and a [link](https://example.com).",
  "",
  "- one",
  "- two",
  "",
  "1. first",
  "2. second",
  "",
  "> a quote",
  "",
  "---",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "| Col A | Col B |",
  "| ----- | ----- |",
  "| a1    | b1    |",
  "",
  "![alt text](https://example.com/i.png)",
].join("\n");

describe("Markdown", () => {
  it("renders the full set of GFM elements", () => {
    const { container } = render(<Markdown body={RICH} />);
    expect(screen.getByRole("heading", { level: 1, name: "H1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "H4" })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    const lists = screen.getAllByRole("list");
    expect(lists.map((l) => l.tagName)).toEqual(
      expect.arrayContaining(["UL", "OL"]),
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Col A" })).toBeInTheDocument();
    expect(screen.getByText("a quote")).toBeInTheDocument();
    expect(container.querySelector("hr")).not.toBeNull();
    expect(container.querySelector("pre code")).not.toBeNull();
    expect(screen.getByText("inline code").tagName).toBe("CODE");
    expect(screen.getByRole("img", { name: "alt text" })).toBeInTheDocument();
  });

  it("renders links but keeps them inert (no navigation)", async () => {
    render(<Markdown body="[click](https://example.com)" />);
    const link = screen.getByRole("link", { name: "click" });
    expect(link).toHaveAttribute("href", "https://example.com");
    // preventDefault means the click is swallowed; just assert it does not throw.
    await userEvent.click(link);
    expect(link).toBeInTheDocument();
  });

  it("renders [[wikilinks]] as literal text when no note index is provided (chat)", () => {
    render(<Markdown body="see [[Deep Work]]" />);
    expect(screen.getByText("see [[Deep Work]]")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

const INDEX: NoteIndexEntry[] = [
  { relPath: "Areas/Deep Work.md", stem: "deep work" },
  { relPath: "Daily.md", stem: "daily" },
];

describe("Markdown — wikilinks (with a note index)", () => {
  it("resolves a [[wikilink]] and opens the note on click", async () => {
    const onOpenLink = vi.fn();
    render(
      <Markdown body="see [[Deep Work]]" noteIndex={INDEX} onOpenLink={onOpenLink} />,
    );
    const link = screen.getByRole("link", { name: "Deep Work" });
    await userEvent.click(link);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("Areas/Deep Work.md");
  });

  it("keeps the #heading in the nn-wikilink url and still resolves", async () => {
    const onOpenLink = vi.fn();
    render(
      <Markdown
        body="[[Deep Work#Rituals]]"
        noteIndex={INDEX}
        onOpenLink={onOpenLink}
      />,
    );
    const link = screen.getByRole("link", { name: "Deep Work#Rituals" });
    expect(link.getAttribute("href")).toMatch(/^nn-wikilink:/);
    await userEvent.click(link);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("Areas/Deep Work.md");
  });

  it("shows the alias for [[target|alias]]", async () => {
    const onOpenLink = vi.fn();
    render(
      <Markdown body="[[Daily|today's note]]" noteIndex={INDEX} onOpenLink={onOpenLink} />,
    );
    await userEvent.click(screen.getByRole("link", { name: "today's note" }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("Daily.md");
  });

  it("renders an unresolved [[wikilink]] dimmed, non-navigating, with a hint", () => {
    render(<Markdown body="[[Missing Note]]" noteIndex={INDEX} onOpenLink={vi.fn()} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const unresolved = screen.getByText("Missing Note");
    expect(unresolved.tagName).toBe("SPAN");
    expect(unresolved).toHaveAttribute("title", "No note called “Missing Note” yet");
  });

  it("keeps [[wikilinks]] inside code fences and inline code literal", () => {
    const body = "```\n[[Deep Work]]\n```\n\nAnd `[[Daily]]` inline.";
    render(<Markdown body={body} noteIndex={INDEX} onOpenLink={vi.fn()} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("[[Deep Work]]")).toBeInTheDocument();
    expect(screen.getByText("[[Daily]]")).toBeInTheDocument();
  });

  it("makes an internal markdown link open the note in-app", async () => {
    const onOpenLink = vi.fn();
    render(
      <Markdown
        body="[the plan](Areas/Deep%20Work.md)"
        noteIndex={INDEX}
        onOpenLink={onOpenLink}
      />,
    );
    await userEvent.click(screen.getByRole("link", { name: "the plan" }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("Areas/Deep Work.md");
  });

  it("keeps external links inert and never opens them in-app", async () => {
    const onOpenLink = vi.fn();
    render(
      <Markdown
        body="[out](https://example.com)"
        noteIndex={INDEX}
        onOpenLink={onOpenLink}
      />,
    );
    const link = screen.getByRole("link", { name: "out" });
    expect(link).toHaveAttribute("href", "https://example.com");
    await userEvent.click(link);
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("still strips javascript: urls (the sanitizing transform is delegated to)", () => {
    render(
      <Markdown
        body="[evil](javascript:alert(1))"
        noteIndex={INDEX}
        onOpenLink={vi.fn()}
      />,
    );
    const link = screen.getByText("evil");
    expect(link.getAttribute("href") ?? "").not.toContain("javascript:");
  });
});
