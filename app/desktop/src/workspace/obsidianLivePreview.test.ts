import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

import type { NoteIndexEntry } from "./linkResolve";
import { collectObsidianPreview } from "./obsidianLivePreview";

const INDEX: NoteIndexEntry[] = [
  { relPath: "Daily.md", stem: "daily" },
  { relPath: "Areas/Deep Work.md", stem: "deep work" },
];

function state(doc: string, anchor = doc.length) {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ base: markdownLanguage, completeHTMLTags: false })],
  });
}

describe("obsidianLivePreview", () => {
  it("recognizes resolved links, aliases, fragments, inert embeds, callouts, and block IDs", () => {
    const doc = [
      "[[Daily]] [[Daily#Heading|today]] [[Daily#^block-id]]",
      "![[Areas/Deep Work.md]]",
      "> [!NOTE] Callout",
      "A paragraph ^evidence-id",
    ].join("\n");

    const preview = collectObsidianPreview(state(doc), INDEX);

    expect(preview.filter((item) => item.className === "nn-lp-wikilink-resolved")).toHaveLength(3);
    expect(preview).toContainEqual(expect.objectContaining({
      kind: "widget",
      className: "nn-lp-embed",
      label: "Embed: Deep Work",
    }));
    expect(preview).toContainEqual(expect.objectContaining({ className: "nn-lp-callout" }));
    expect(preview).toContainEqual(expect.objectContaining({ className: "nn-lp-block-id" }));
  });

  it("keeps unresolved links distinct and non-navigating", () => {
    const preview = collectObsidianPreview(state("[[Missing]]"), INDEX);
    expect(preview).toEqual([
      expect.objectContaining({
        kind: "widget",
        className: "nn-lp-wikilink-unresolved",
        target: null,
      }),
    ]);
  });

  it("reveals complete source at the caret instead of replacing it", () => {
    const doc = "before [[Daily|today]] after";
    const preview = collectObsidianPreview(state(doc, doc.indexOf("Daily") + 2), INDEX);

    expect(preview).toEqual([
      expect.objectContaining({ kind: "mark", className: "nn-lp-wikilink-active" }),
    ]);
  });

  it("does not decorate malformed links or constructs inside inline and fenced code", () => {
    const doc = "[[unclosed\n`[[Daily]]`\n```md\n[[Daily]]\n```";
    expect(collectObsidianPreview(state(doc), INDEX)).toEqual([]);
  });

  it("never turns embed or image text into a fetching DOM URL", () => {
    const preview = collectObsidianPreview(
      state("![[https://example.com/a.png]] ![x](https://example.com/x.png)"),
      INDEX,
    );
    expect(preview.every((item) => !("src" in item) && !("href" in item))).toBe(true);
  });

  it("does not copy or scan the complete document for a narrow viewport", () => {
    const doc = `${"outside\n".repeat(50_000)}[[Daily]] visible`;
    const editor = state(doc, 0);
    const linkFrom = doc.indexOf("[[Daily]]");
    vi.spyOn(editor.doc, "toString").mockImplementation(() => {
      throw new Error("complete document copied");
    });

    expect(
      collectObsidianPreview(editor, INDEX, [{ from: linkFrom, to: doc.length }]),
    ).toEqual([
      expect.objectContaining({ className: "nn-lp-wikilink-resolved" }),
    ]);
  });
});
