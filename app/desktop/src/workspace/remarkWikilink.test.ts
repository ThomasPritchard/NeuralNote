import { describe, expect, it } from "vitest";
import type { Link, Paragraph, Root, Text } from "mdast";
import { remarkWikilink, WIKILINK_SCHEME } from "./remarkWikilink";

// The plugin is tested at the mdast level with hand-built trees — no parser
// needed, and the code/inlineCode cases can be asserted structurally. The
// DOM-level fence behaviour (a fenced ``[[x]]`` staying literal through the
// real parse) is additionally pinned in Markdown.test.tsx.

const run = (tree: Root): Root => {
  remarkWikilink()(tree);
  return tree;
};

const text = (value: string): Text => ({ type: "text", value });

const paragraph = (...children: Paragraph["children"]): Root => ({
  type: "root",
  children: [{ type: "paragraph", children }],
});

const childrenOf = (tree: Root): Paragraph["children"] =>
  (tree.children[0] as Paragraph).children;

const link = (target: string, label: string): Link => ({
  type: "link",
  url: WIKILINK_SCHEME + target,
  children: [text(label)],
});

describe("remarkWikilink — text nodes", () => {
  it("replaces [[target]] with a nn-wikilink link, keeping surrounding text", () => {
    const tree = run(paragraph(text("see [[Deep Work]] today")));
    expect(childrenOf(tree)).toEqual([
      text("see "),
      link("Deep Work", "Deep Work"),
      text(" today"),
    ]);
  });

  it("uses the alias as the link text for [[target|alias]]", () => {
    const tree = run(paragraph(text("[[Deep Work|focus]]")));
    expect(childrenOf(tree)).toEqual([link("Deep Work", "focus")]);
  });

  it("keeps the #heading in the url for [[target#heading]]", () => {
    const tree = run(paragraph(text("[[Deep Work#Rituals]]")));
    expect(childrenOf(tree)).toEqual([
      link("Deep Work#Rituals", "Deep Work#Rituals"),
    ]);
  });

  it("combines heading urls with alias display for [[target#heading|alias]]", () => {
    const tree = run(paragraph(text("[[Deep Work#Rituals|the rituals]]")));
    expect(childrenOf(tree)).toEqual([
      link("Deep Work#Rituals", "the rituals"),
    ]);
  });

  it("converts multiple wikilinks in one text node", () => {
    const tree = run(paragraph(text("[[A]] and [[B]]!")));
    expect(childrenOf(tree)).toEqual([
      link("A", "A"),
      text(" and "),
      link("B", "B"),
      text("!"),
    ]);
  });

  it("leaves an unclosed [[ as literal text", () => {
    const tree = run(paragraph(text("open [[never closed")));
    expect(childrenOf(tree)).toEqual([text("open [[never closed")]);
  });

  it("leaves empty targets ([[]] and [[|alias]]) literal", () => {
    const tree = run(paragraph(text("a [[]] b [[|alias]] c")));
    expect(childrenOf(tree)).toEqual([text("a [[]] b [[|alias]] c")]);
  });

  it("transforms text nested inside emphasis", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "emphasis", children: [text("[[A]]")] }],
        },
      ],
    };
    run(tree);
    const em = childrenOf(tree)[0];
    expect(em).toEqual({ type: "emphasis", children: [link("A", "A")] });
  });
});

describe("remarkWikilink — code stays literal", () => {
  it("does not touch fenced code blocks (value, not text children)", () => {
    const tree: Root = {
      type: "root",
      children: [{ type: "code", value: "[[Deep Work]]" }],
    };
    run(tree);
    expect(tree.children).toEqual([{ type: "code", value: "[[Deep Work]]" }]);
  });

  it("does not touch inline code", () => {
    const tree = run(paragraph({ type: "inlineCode", value: "[[Deep Work]]" }));
    expect(childrenOf(tree)).toEqual([
      { type: "inlineCode", value: "[[Deep Work]]" },
    ]);
  });

  it("does not nest links inside an existing link", () => {
    const tree = run(
      paragraph({
        type: "link",
        url: "https://example.com",
        children: [text("[[A]]")],
      }),
    );
    expect(childrenOf(tree)).toEqual([
      { type: "link", url: "https://example.com", children: [text("[[A]]")] },
    ]);
  });
});
