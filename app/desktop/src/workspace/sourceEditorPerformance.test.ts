import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ChangeSet, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { collectObsidianPreview } from "./obsidianLivePreview";
import { collectMarkdownPreview } from "./sourceEditorDecorations";
import { applySourceChanges, loadSourceText, serializeSourceText } from "./sourceText";

const PARAGRAPH = "A representative paragraph with **strong text**, [[Vault Link]], Unicode café 界, and trailing spaces.  ";
const FIXTURE = Array.from(
  { length: 5_000 },
  (_, index) => `## Heading ${index}\n\n${PARAGRAPH}`,
).join("\r\n\r\n");

describe("source editor performance budgets", () => {
  it("opens the visible portion of a 500 KiB / 5,000-paragraph fixture within budget", () => {
    expect(new TextEncoder().encode(FIXTURE).byteLength).toBeGreaterThanOrEqual(500 * 1024);
    const samples: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      const state = EditorState.create({
        doc: loadSourceText(FIXTURE).text,
        extensions: [markdown({ base: markdownLanguage, completeHTMLTags: false })],
      });
      const visible = [{ from: 0, to: Math.min(8_192, state.doc.length) }];
      collectMarkdownPreview(state, visible);
      collectObsidianPreview(state, [{ relPath: "Vault Link.md", stem: "vault link" }], visible);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    expect(samples[2]).toBeLessThanOrEqual(1_500);
  });

  it("keeps p95 exact-source reconstruction below the 50 ms key-to-paint budget", () => {
    let source = loadSourceText(FIXTURE);
    let state = EditorState.create({
      doc: source.text,
      extensions: [markdown({ base: markdownLanguage, completeHTMLTags: false })],
    });
    const samples: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const position = Math.min(source.text.length, 512 + run * 997);
      const changes = ChangeSet.of({ from: position, insert: run % 4 === 0 ? "\n" : "x" }, source.text.length);
      const started = performance.now();
      source = applySourceChanges(source, changes);
      state = state.update({ changes }).state;
      const visible = [{ from: Math.max(0, position - 4_096), to: Math.min(state.doc.length, position + 4_096) }];
      collectMarkdownPreview(state, visible);
      collectObsidianPreview(state, [{ relPath: "Vault Link.md", stem: "vault link" }], visible);
      serializeSourceText(source);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    expect(samples[18]).toBeLessThanOrEqual(50);
  });
});
