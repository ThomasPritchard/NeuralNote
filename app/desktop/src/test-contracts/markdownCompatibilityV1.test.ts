import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { withPublishedParse } from "../test/publishedParse";
import { collectObsidianPreview } from "../workspace/obsidianLivePreview";
import {
  collectMarkdownPreview,
  safeCollectMarkdownPreview,
} from "../workspace/sourceEditorDecorations";
import { sourceFrontmatterRange } from "../workspace/sourceFrontmatterPreview";
import {
  applySourceChanges,
  loadSourceText,
  serializeSourceText,
} from "../workspace/sourceText";
import { findWikilinkTrigger } from "../workspace/wikilinkAutocomplete";
import {
  MARKDOWN_COMPATIBILITY_V1,
  type MarkdownCompatibilityCaseV1,
} from "./markdownCompatibilityV1";

const EXPECTED_CASE_IDS = [
  "paragraph-separation",
  "atx-heading-h1",
  "atx-heading-h2",
  "atx-heading-h3",
  "atx-heading-h4",
  "atx-heading-h5",
  "atx-heading-h6",
  "setext-heading-h1",
  "setext-heading-h2",
  "emphasis-asterisk",
  "emphasis-underscore",
  "strong-asterisk",
  "strong-underscore",
  "nested-bold-italic",
  "strikethrough",
  "inline-code-embedded-backtick",
  "ordered-list-period",
  "ordered-list-parenthesis",
  "unordered-list-hyphen",
  "unordered-list-asterisk",
  "unordered-list-plus",
  "nested-mixed-lists",
  "task-unchecked",
  "task-checked",
  "blockquote",
  "horizontal-rule-asterisks",
  "horizontal-rule-hyphens",
  "horizontal-rule-underscores",
  "horizontal-rule-spaced-asterisks",
  "horizontal-rule-spaced-hyphens",
  "horizontal-rule-spaced-underscores",
  "fenced-code-backticks",
  "fenced-code-tildes",
  "fenced-code-nested-longer-outer",
  "markdown-internal-link",
  "markdown-external-link",
  "markdown-unsafe-link",
  "gfm-table-alignment-inline",
  "gfm-table-escaped-pipe",
  "wikilink",
  "wikilink-alias",
  "wikilink-heading-fragment",
  "wikilink-block-fragment",
  "wikilink-resolved",
  "wikilink-unresolved",
  "inline-tag-nested",
  "inline-tag-unicode",
  "inline-tag-emoji",
  "callout-marker",
  "block-id",
  "yaml-frontmatter-properties",
  "marker-reveal-boundaries",
  "multiple-selections",
  "clipboard-history-source",
  "task-toggle-marker-only",
  "table-preview-source-switch",
  "wikilink-completion",
  "wikilink-completion-alias",
  "wikilink-fragment-continuation",
  "pointer-activation",
  "enter-activation",
  "mod-enter-activation",
  "escaped-markdown-literal",
  "malformed-partial-constructs",
  "tag-exclusion-zones",
  "large-table-source-fallback",
  "narrow-viewport-bounded",
  "decoration-failure-recovery",
  "no-op-byte-identity",
  "line-endings-lf",
  "line-endings-crlf",
  "line-endings-cr",
  "line-endings-mixed",
  "byte-order-mark",
  "tabs",
  "trailing-spaces",
  "unicode",
  "image-standard-inert",
  "image-local-vault-inert",
  "image-remote-inert",
  "image-unsafe-scheme-inert",
  "embed-image-inert",
  "embed-note-inert",
  "image-active-source",
  "image-edit-history-source",
  "image-missing-alt-fallback",
  "raw-html-source-only",
  "mdx-source-only",
  "jsx-source-only",
  "inline-math-source-only",
  "block-math-source-only",
  "footnotes-source-only",
  "dataview-source-only",
  "dataviewjs-source-only",
  "mermaid-source-only",
  "plugin-fence-source-only",
  "obsidian-highlight-source-only",
  "obsidian-comment-source-only",
  "unknown-plugin-source-only",
  "malformed-callout-source-only",
  "malformed-embed-source-only",
  "malformed-link-source-only",
  "malformed-table-source-only",
  "reference-link-source-only",
  "autolink-source-only",
  "hard-break-source-only",
  "indented-code-source-only",
] as const;

const INDEX = [
  { relPath: "Daily.md", stem: "daily" },
  { relPath: "Areas/Deep Work.md", stem: "deep work" },
];

function compatibilityCase(id: string): MarkdownCompatibilityCaseV1 {
  const found = MARKDOWN_COMPATIBILITY_V1.cases.find((item) => item.id === id);
  if (!found) throw new Error(`Missing MarkdownCompatibilityV1 case: ${id}`);
  return found;
}

/**
 * A contract fixture whose finished parse the syntax tree actually holds.
 *
 * Every construct this contract pins is read out of `syntaxTree(state)`, so a
 * truncated tree does not weaken a case — it deletes it, and
 * `expect(classNames).toEqual(expect.arrayContaining(...))` reports a compat
 * REGRESSION for a construct the parser simply had not reached. `LanguageState.
 * init` gives that parse 20 ms of wall clock
 * (`@codemirror/language/dist/index.js:539-545`), which a loaded machine can
 * spend before a one-line fixture is done. See `src/test/publishedParse.ts`,
 * which also explains why the `ensureSyntaxTree` call this replaced could not
 * close it: it advanced the parse context and left `syntaxTree` reading the
 * snapshot taken in the field's constructor.
 */
function state(source: string, anchors?: readonly number[]): EditorState {
  const logicalSource = loadSourceText(source).text;
  return withPublishedParse(
    EditorState.create({
      doc: logicalSource,
      selection: EditorSelection.create(
        (anchors ?? [logicalSource.length]).map((anchor) => EditorSelection.cursor(anchor)),
      ),
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
      ],
    }),
    logicalSource,
  );
}

function constructAnchor(item: MarkdownCompatibilityCaseV1, source: string): number {
  const candidates = item.expectedDecorations.some((name) => name.startsWith("nn-lp-task"))
    ? [source.indexOf("[") + 1]
    : item.expectedDecorations.some((name) => name.includes("wikilink") || name === "nn-lp-embed")
      ? [source.indexOf("[[") + 2]
      : item.expectedDecorations.includes("nn-lp-image")
        ? [source.indexOf("![") + 2]
        : item.expectedDecorations.some((name) => name.startsWith("nn-lp-table"))
          ? [source.indexOf("|") + 1]
          : [Math.floor(source.length / 2)];
  return Math.max(0, Math.min(source.length, candidates[0] ?? 0));
}

function assertParserBehavior(
  item: MarkdownCompatibilityCaseV1,
  editorState: EditorState,
): void {
  // The parse is guaranteed by `state` itself, which throws rather than hand
  // back a fixture the parser did not finish.
  const parserState = item.id === "narrow-viewport-bounded" ? state("# Visible") : editorState;
  const markdownDecorations = collectMarkdownPreview(parserState);
  const obsidianDecorations = collectObsidianPreview(parserState, INDEX, undefined, false);
  const allDecorations = [...markdownDecorations, ...obsidianDecorations];
  const classNames = allDecorations.map(({ className }) => className);

  expect(classNames).toEqual(expect.arrayContaining([...item.expectedDecorations]));
  for (const decoration of allDecorations) {
    expect(decoration.from).toBeGreaterThanOrEqual(0);
    expect(decoration.to).toBeLessThanOrEqual(editorState.doc.length);
    expect(decoration.to).toBeGreaterThanOrEqual(decoration.from);
  }

  const hasWidget = allDecorations.some(({ kind }) => kind === "widget");
  expect(item.supportLevel !== "sourceOnly" || !hasWidget).toBe(true);

  const table = markdownDecorations.find(({ className }) => className === "nn-lp-table");
  const expectsSemanticTable = item.expectedSemantics.includes("semantic-table");
  expect(
    !expectsSemanticTable
      || (table?.kind === "widget"
        && (table.table?.headers.length ?? 0) > 0
        && (table.table?.rows.length ?? 0) > 0),
  ).toBe(true);
  expect(
    item.id !== "gfm-table-escaped-pipe" || table?.table?.rows.flat().includes("a | b") === true,
  ).toBe(true);

  const wikilinkTrigger = findWikilinkTrigger(editorState.doc.toString(), editorState.doc.length);
  expect(!item.expectedSemantics.includes("wikilink-completion") || wikilinkTrigger !== null)
    .toBe(true);

  const frontmatter = sourceFrontmatterRange(editorState);
  expect(item.id !== "yaml-frontmatter-properties" || frontmatter?.from === 0).toBe(true);

  const recovered = safeCollectMarkdownPreview(editorState, undefined, () => {
    throw new Error("synthetic decoration failure");
  });
  const recoveryCorrect = recovered.decorations.length === 0
    && recovered.error === "Live preview is temporarily unavailable. Your source is unchanged."
    && editorState.doc.toString() === loadSourceText(item.source).text;
  expect(item.id !== "decoration-failure-recovery" || recoveryCorrect).toBe(true);

  // `viewport-bounded-decoration`: the collector decorates the requested window
  // and nothing else, across a 40 KB note whose only construct is at the very
  // end.
  //
  // Stated as "found the heading, strayed nowhere" rather than as a decoration
  // COUNT. The count this replaces (`<= 1`) was satisfied by finding nothing at
  // all, which is exactly what used to happen: with the fixture's parse
  // unpublished the tree stopped at `Work.InitViewport` (3,000 characters), the
  // heading at 40,000 was not in it, and the case passed against an empty
  // result. Now that `state` publishes the finished parse the window really does
  // hold two decorations — the `nn-lp-heading-1` mark and the revealed `#`
  // marker, the caret sitting in the heading — and a cap of one would have to be
  // raised to two, which measures today's decoration set instead of the bound
  // the case is named for.
  const headingStart = editorState.doc.toString().lastIndexOf("# Visible");
  const bounded = item.id === "narrow-viewport-bounded"
    ? collectMarkdownPreview(editorState, [{ from: headingStart, to: editorState.doc.length }])
    : [];
  const boundedCorrect = bounded.some(({ className }) => className === "nn-lp-heading-1")
    && bounded.every(({ from, to }) => from >= headingStart && to <= editorState.doc.length);
  expect(item.id !== "narrow-viewport-bounded" || boundedCorrect).toBe(true);

  const logicalSource = loadSourceText(item.source).text;
  const anchor = constructAnchor(item, logicalSource);
  const activeState = state(item.source, [anchor]);
  const activeDecorations = [
    ...collectMarkdownPreview(activeState),
    ...collectObsidianPreview(activeState, INDEX),
  ];
  const activeSourceVisible = !activeDecorations.some(
    ({ from, kind, to }) => kind === "widget" && anchor >= from && anchor < to,
  );
  expect(activeSourceVisible).toBe(true);
  expect(activeState.doc.toString()).toBe(logicalSource);

  const loaded = loadSourceText(item.source);
  const insertion = editorState.changes({ from: anchor, insert: "x" });
  const edited = applySourceChanges(loaded, insertion);
  const editedState = EditorState.create({ doc: edited.text });
  const removal = editedState.changes({ from: anchor, to: anchor + 1 });
  const restored = applySourceChanges(edited, removal);
  expect(serializeSourceText(restored)).toBe(item.expectedSaveResult);
  expect(editorState.sliceDoc()).toBe(logicalSource);

  const interactions = item.allowedInteractions;
  const hasTask = classNames.some((name) => name.startsWith("nn-lp-task"));
  const hasTable = classNames.some((name) => name.startsWith("nn-lp-table"));
  const hasInternalTarget = markdownDecorations.some(({ href }) => href?.endsWith(".md"))
    || obsidianDecorations.some(({ target }) => target !== undefined && target !== null);
  const hasTagTarget = obsidianDecorations.some(({ tag }) => tag !== undefined)
    || (item.id === "yaml-frontmatter-properties" && frontmatter?.from === 0);
  expect(!interactions.includes("toggleTask") || hasTask).toBe(true);
  expect(!interactions.includes("activateTableSource") || hasTable).toBe(true);
  expect(!interactions.includes("activateInternalLink") || hasInternalTarget).toBe(true);
  expect(!interactions.includes("searchTag") || hasTagTarget).toBe(true);
  expect(!interactions.includes("completeWikilink") || wikilinkTrigger !== null).toBe(true);
  expect(!interactions.includes("togglePropertiesSource") || frontmatter?.from === 0).toBe(true);
}

describe("MarkdownCompatibilityV1", () => {
  it("versions the complete approved NeuralNote Markdown subset with stable isolated cases", () => {
    expect(MARKDOWN_COMPATIBILITY_V1.schemaVersion).toBe("MarkdownCompatibilityV1");
    expect(MARKDOWN_COMPATIBILITY_V1.cases.map((item) => item.id)).toEqual(EXPECTED_CASE_IDS);
    expect(new Set(MARKDOWN_COMPATIBILITY_V1.cases.map((item) => item.id))).toHaveProperty(
      "size",
      EXPECTED_CASE_IDS.length,
    );
  });

  it.each(MARKDOWN_COMPATIBILITY_V1.cases)(
    "$id exercises its parser semantics, interaction contract, and exact source preservation",
    (item) => {
      expect(item.source).not.toBe("");
      expect(["livePreview", "sourceOnly", "inert"]).toContain(item.supportLevel);
      expect(item.expectedSaveResult).toBe(item.source);
      expect(item.expectedDecorations).toBeDefined();
      expect(item.expectedSemantics.length).toBeGreaterThan(0);
      expect(item.activeCaretBehavior).toMatch(/source|marker/i);
      expect(item.allowedInteractions).toContain("editSource");
      expect(item.navigation).toBeDefined();
      expect(item.projectSpec.path).toBe("specs/source-native-live-preview-editor.md");
      expect(item.projectSpec.section).not.toBe("");
      expect(item.obsidianReference.url).toBe("https://obsidian.md/help/syntax");
      expect(item.obsidianReference.category).not.toBe("");
      expect(serializeSourceText(loadSourceText(item.source))).toBe(item.expectedSaveResult);

      const editorState = state(item.source);
      assertParserBehavior(item, editorState);
    },
  );

  it.each(MARKDOWN_COMPATIBILITY_V1.cases)(
    "$id maps every allowed interaction to an explicit browser execution",
    (item) => {
      const executions = (item as MarkdownCompatibilityCaseV1 & {
        interactionExecutions?: Readonly<Record<string, string>>;
      }).interactionExecutions;

      expect(executions).toBeDefined();
      expect(Object.keys(executions ?? {}).sort()).toEqual(
        [...item.allowedInteractions].sort(),
      );
      expect(Object.values(executions ?? {}).every((execution) =>
        execution.startsWith("browser:"))).toBe(true);
    },
  );

  it("keeps unsupported and plugin-owned syntax literal and non-executing", () => {
    const sourceOnlyCases = MARKDOWN_COMPATIBILITY_V1.cases.filter(
      ({ supportLevel }) => supportLevel === "sourceOnly",
    );

    for (const item of sourceOnlyCases) {
      const decorations = collectMarkdownPreview(state(item.source));
      const obsidianDecorations = collectObsidianPreview(state(item.source), INDEX);
      expect(decorations.some(({ kind }) => kind === "widget")).toBe(false);
      expect(obsidianDecorations.some(({ kind }) => kind === "widget")).toBe(false);
      expect(item.navigation).toBe("none");
      expect(item.capabilities).toEqual({ network: "forbidden", nativeRead: "forbidden" });
    }
  });

  it("gives images and embeds accessible inert labels without URL-bearing decorations", () => {
    const markdownImageIds = [
      "image-standard-inert",
      "image-local-vault-inert",
      "image-remote-inert",
      "image-unsafe-scheme-inert",
      "image-missing-alt-fallback",
    ];
    for (const id of markdownImageIds) {
      const item = compatibilityCase(id);
      const images = collectMarkdownPreview(state(item.source))
        .filter(({ className }) => className === "nn-lp-image");
      expect(images).toHaveLength(1);
      expect(images[0]?.kind).toBe("widget");
      expect(images[0]?.label).toBe(item.accessibleLabel);
      expect(images[0]).not.toHaveProperty("href");
      expect(images[0]).not.toHaveProperty("src");
      expect(item.capabilities).toEqual({ network: "forbidden", nativeRead: "forbidden" });
    }

    for (const id of ["embed-image-inert", "embed-note-inert"]) {
      const item = compatibilityCase(id);
      const embeds = collectObsidianPreview(state(item.source), INDEX, undefined, false)
        .filter(({ className }) => className === "nn-lp-embed");
      expect(embeds).toHaveLength(1);
      expect(embeds[0]?.label).toBe(item.accessibleLabel);
      expect(embeds[0]?.target).toBeNull();
      expect(embeds[0]).not.toHaveProperty("href");
      expect(embeds[0]).not.toHaveProperty("src");
    }
  });

  it("reveals delimiter markers for selections touching different constructs", () => {
    const item = compatibilityCase("multiple-selections");
    const emphasis = item.source.indexOf("emphasis") + 2;
    const strong = item.source.indexOf("strong") + 2;
    const decorations = collectMarkdownPreview(state(item.source, [emphasis, strong]));

    expect(decorations.filter(({ className }) => className === "nn-lp-marker-active")).toHaveLength(4);
  });

  it("keeps tag-like text out of frontmatter, code, and link destinations", () => {
    const item = compatibilityCase("tag-exclusion-zones");
    const tags = collectObsidianPreview(state(item.source), INDEX)
      .filter(({ className }) => className === "nn-lp-tag")
      .map(({ tag }) => tag);

    expect(tags).toEqual(["#body"]);
  });
});
