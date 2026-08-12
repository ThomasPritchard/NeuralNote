// oxlint-disable eslint/max-lines -- This is a frozen CONTRACT corpus: the
// Markdown compatibility matrix, one entry per construct. A 500-line cap
// forces decomposition, which is the right pressure on production code and
// the wrong pressure here — splitting a contract by line count scatters it
// across files and makes "is this construct covered?" harder to answer. Remove
// this directive if the corpus is ever restructured into real modules.
export type MarkdownSupportLevelV1 = "livePreview" | "sourceOnly" | "inert";
export type MarkdownActiveCaretBehaviorV1 =
  | "reveal source markers for the active construct"
  | "reveal complete source while keeping the construct inert"
  | "keep literal source visible and editable";
export type MarkdownAllowedInteractionV1 =
  | "editSource"
  | "copySource"
  | "cutSource"
  | "pasteSource"
  | "undo"
  | "redo"
  | "toggleTask"
  | "activateTableSource"
  | "activateInternalLink"
  | "searchTag"
  | "completeWikilink"
  | "togglePropertiesSource";
export type MarkdownBrowserExecutionV1 =
  | "browser:chromium-webkit:source-edit-copy"
  | "browser:chromium-webkit:clipboard-history"
  | "browser:chromium-webkit:task-toggle"
  | "browser:chromium-webkit:table-source-activation"
  | "browser:chromium-webkit:internal-link-pointer"
  | "browser:chromium-webkit:internal-link-enter"
  | "browser:chromium-webkit:internal-link-mod-enter"
  | "browser:chromium-webkit:tag-pointer"
  | "browser:chromium-webkit:tag-enter"
  | "browser:chromium-webkit:tag-mod-enter"
  | "browser:chromium-webkit:properties-source-and-tag"
  | "browser:chromium-webkit:wikilink-completion"
  | "browser:chromium-webkit:wikilink-alias-edit"
  | "browser:chromium-webkit:wikilink-fragment-edit";
export type MarkdownNavigationV1 =
  | "none"
  | "guardedVaultNote"
  | "tagSearch"
  | "guardedVaultNoteOrTagSearch";

export interface MarkdownCompatibilityCaseV1 {
  readonly id: string;
  readonly source: string;
  readonly supportLevel: MarkdownSupportLevelV1;
  readonly expectedDecorations: readonly string[];
  readonly expectedSemantics: readonly string[];
  readonly activeCaretBehavior: MarkdownActiveCaretBehaviorV1;
  readonly expectedSaveResult: string;
  readonly allowedInteractions: readonly MarkdownAllowedInteractionV1[];
  readonly interactionExecutions: Readonly<
    Partial<Record<MarkdownAllowedInteractionV1, MarkdownBrowserExecutionV1>>
  >;
  readonly navigation: MarkdownNavigationV1;
  readonly capabilities: {
    readonly network: "forbidden";
    readonly nativeRead: "forbidden";
  };
  readonly accessibleLabel?: string;
  readonly projectSpec: {
    readonly path: "specs/source-native-live-preview-editor.md";
    readonly section: string;
  };
  readonly obsidianReference: {
    readonly url: "https://obsidian.md/help/syntax";
    readonly category: string;
  };
}

export interface MarkdownCompatibilityV1 {
  readonly schemaVersion: "MarkdownCompatibilityV1";
  readonly referenceCheckedOn: "2026-07-31";
  readonly scope: "approved-neuralnote-subset";
  readonly cases: readonly MarkdownCompatibilityCaseV1[];
}

interface CaseInputV1 {
  readonly id: string;
  readonly source: string;
  readonly supportLevel: MarkdownSupportLevelV1;
  readonly expectedDecorations?: readonly string[];
  readonly expectedSemantics: readonly string[];
  readonly activeCaretBehavior?: MarkdownActiveCaretBehaviorV1;
  readonly allowedInteractions?: readonly MarkdownAllowedInteractionV1[];
  readonly navigation?: MarkdownNavigationV1;
  readonly accessibleLabel?: string;
  readonly projectSection: string;
  readonly obsidianCategory: string;
}

const SOURCE_INTERACTIONS = ["editSource", "copySource"] as const;
const EXACT_CUT_INTERACTIONS = [...SOURCE_INTERACTIONS, "cutSource"] as const;
const FORBIDDEN_DIRECT_CAPABILITIES = {
  network: "forbidden",
  nativeRead: "forbidden",
} as const;

const DEFAULT_BROWSER_EXECUTION: Readonly<
  Record<MarkdownAllowedInteractionV1, MarkdownBrowserExecutionV1>
> = {
  editSource: "browser:chromium-webkit:source-edit-copy",
  copySource: "browser:chromium-webkit:source-edit-copy",
  cutSource: "browser:chromium-webkit:clipboard-history",
  pasteSource: "browser:chromium-webkit:clipboard-history",
  undo: "browser:chromium-webkit:clipboard-history",
  redo: "browser:chromium-webkit:clipboard-history",
  toggleTask: "browser:chromium-webkit:task-toggle",
  activateTableSource: "browser:chromium-webkit:table-source-activation",
  activateInternalLink: "browser:chromium-webkit:internal-link-pointer",
  searchTag: "browser:chromium-webkit:tag-pointer",
  completeWikilink: "browser:chromium-webkit:wikilink-completion",
  togglePropertiesSource: "browser:chromium-webkit:properties-source-and-tag",
};

/** Cases that execute an interaction differently from the table above — the
 *  same interaction driven by a different gesture (Enter, Mod-Enter) or over a
 *  different construct. Keyed `interaction/caseId`; the separator keeps a key
 *  from ever colliding with an `Object.prototype` member name.
 *
 *  The key's interaction half is a template-literal type, so a stale or misspelt
 *  interaction is a compile error here exactly as it was under the if-ladder
 *  this table replaced. */
const BROWSER_EXECUTION_OVERRIDES: Readonly<
  Partial<Record<`${MarkdownAllowedInteractionV1}/${string}`, MarkdownBrowserExecutionV1>>
> = {
  "activateInternalLink/enter-activation": "browser:chromium-webkit:internal-link-enter",
  "activateInternalLink/mod-enter-activation": "browser:chromium-webkit:internal-link-mod-enter",
  "searchTag/yaml-frontmatter-properties": "browser:chromium-webkit:properties-source-and-tag",
  "searchTag/enter-activation": "browser:chromium-webkit:tag-enter",
  "searchTag/mod-enter-activation": "browser:chromium-webkit:tag-mod-enter",
  "completeWikilink/wikilink-completion-alias": "browser:chromium-webkit:wikilink-alias-edit",
  "completeWikilink/wikilink-fragment-continuation": "browser:chromium-webkit:wikilink-fragment-edit",
};

function browserExecutionFor(
  caseId: string,
  interaction: MarkdownAllowedInteractionV1,
): MarkdownBrowserExecutionV1 {
  return BROWSER_EXECUTION_OVERRIDES[`${interaction}/${caseId}`]
    ?? DEFAULT_BROWSER_EXECUTION[interaction];
}

function browserExecutionsFor(
  caseId: string,
  interactions: readonly MarkdownAllowedInteractionV1[],
): MarkdownCompatibilityCaseV1["interactionExecutions"] {
  return Object.fromEntries(
    interactions.map((interaction) => [interaction, browserExecutionFor(caseId, interaction)]),
  );
}

/** What the caret reveals for a construct at each support level, unless the case
 *  states its own. */
const DEFAULT_ACTIVE_CARET_BEHAVIOR: Readonly<
  Record<MarkdownSupportLevelV1, MarkdownActiveCaretBehaviorV1>
> = {
  livePreview: "reveal source markers for the active construct",
  inert: "reveal complete source while keeping the construct inert",
  sourceOnly: "keep literal source visible and editable",
};

function defineCase(input: CaseInputV1): MarkdownCompatibilityCaseV1 {
  const allowedInteractions = input.allowedInteractions ?? SOURCE_INTERACTIONS;
  return {
    id: input.id,
    source: input.source,
    supportLevel: input.supportLevel,
    expectedDecorations: input.expectedDecorations ?? [],
    expectedSemantics: input.expectedSemantics,
    activeCaretBehavior:
      input.activeCaretBehavior ?? DEFAULT_ACTIVE_CARET_BEHAVIOR[input.supportLevel],
    expectedSaveResult: input.source,
    allowedInteractions,
    interactionExecutions: browserExecutionsFor(input.id, allowedInteractions),
    navigation: input.navigation ?? "none",
    capabilities: FORBIDDEN_DIRECT_CAPABILITIES,
    accessibleLabel: input.accessibleLabel,
    projectSpec: {
      path: "specs/source-native-live-preview-editor.md",
      section: input.projectSection,
    },
    obsidianReference: {
      url: "https://obsidian.md/help/syntax",
      category: input.obsidianCategory,
    },
  };
}

const livePreview = (
  input: Omit<CaseInputV1, "supportLevel">,
): MarkdownCompatibilityCaseV1 => defineCase({ ...input, supportLevel: "livePreview" });

const sourceOnly = (
  input: Omit<CaseInputV1, "supportLevel">,
): MarkdownCompatibilityCaseV1 => defineCase({ ...input, supportLevel: "sourceOnly" });

const inert = (
  input: Omit<CaseInputV1, "supportLevel">,
): MarkdownCompatibilityCaseV1 => defineCase({ ...input, supportLevel: "inert" });

const DECORATIONS = "Live-preview decorations";
const PRESERVATION = "Source preservation and persistence > Exact text and line endings";
const LINKS = "Live-preview decorations > Wikilinks and embeds";
const SECURITY = "Security and trust boundaries";
const INTERACTION = "Accessibility and interaction";

const BASIC = "Basic formatting syntax";
const LARGE_TABLE_SOURCE = [
  "| Key | Value |",
  "| --- | --- |",
  ...Array.from({ length: 201 }, (_, index) => `| ${index} | value ${index} |`),
].join("\n");
const NARROW_VIEWPORT_SOURCE = `${"outside\n".repeat(5_000)}# Visible`;

export const MARKDOWN_COMPATIBILITY_V1: MarkdownCompatibilityV1 = {
  schemaVersion: "MarkdownCompatibilityV1",
  referenceCheckedOn: "2026-07-31",
  scope: "approved-neuralnote-subset",
  cases: [
    livePreview({
      id: "paragraph-separation",
      source: "First paragraph.\n\nSecond paragraph.",
      expectedSemantics: ["paragraph", "paragraph-separation"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Paragraphs`,
    }),
    ...Array.from({ length: 6 }, (_, index) => livePreview({
      id: `atx-heading-h${index + 1}`,
      source: `${"#".repeat(index + 1)} Heading ${index + 1}`,
      expectedDecorations: [`nn-lp-heading-${index + 1}`],
      expectedSemantics: [`heading-level-${index + 1}`],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Headings`,
    })),
    livePreview({
      id: "setext-heading-h1",
      source: "Primary\n=======",
      expectedDecorations: ["nn-lp-heading-1"],
      expectedSemantics: ["heading-level-1"],
      projectSection: DECORATIONS,
      obsidianCategory: "CommonMark > Setext headings",
    }),
    livePreview({
      id: "setext-heading-h2",
      source: "Secondary\n---------",
      expectedDecorations: ["nn-lp-heading-2"],
      expectedSemantics: ["heading-level-2"],
      projectSection: DECORATIONS,
      obsidianCategory: "CommonMark > Setext headings",
    }),
    livePreview({
      id: "emphasis-asterisk",
      source: "*emphasis*",
      expectedDecorations: ["nn-lp-emphasis"],
      expectedSemantics: ["emphasis"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Bold, italics, highlights`,
    }),
    livePreview({
      id: "emphasis-underscore",
      source: "_emphasis_",
      expectedDecorations: ["nn-lp-emphasis"],
      expectedSemantics: ["emphasis"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Bold, italics, highlights`,
    }),
    livePreview({
      id: "strong-asterisk",
      source: "**strong**",
      expectedDecorations: ["nn-lp-strong"],
      expectedSemantics: ["strong-emphasis"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Bold, italics, highlights`,
    }),
    livePreview({
      id: "strong-underscore",
      source: "__strong__",
      expectedDecorations: ["nn-lp-strong"],
      expectedSemantics: ["strong-emphasis"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Bold, italics, highlights`,
    }),
    livePreview({
      id: "nested-bold-italic",
      source: "**bold and _nested italic_** plus ***both***",
      expectedDecorations: ["nn-lp-strong", "nn-lp-emphasis"],
      expectedSemantics: ["nested-strong-emphasis"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Bold, italics, highlights`,
    }),
    livePreview({
      id: "strikethrough",
      source: "~~removed~~",
      expectedDecorations: ["nn-lp-strikethrough"],
      expectedSemantics: ["strikethrough"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Bold, italics, highlights`,
    }),
    livePreview({
      id: "inline-code-embedded-backtick",
      source: "inline ``code with a backtick ` inside``",
      expectedDecorations: ["nn-lp-inline-code"],
      expectedSemantics: ["inline-code"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Code > Inline code`,
    }),
    livePreview({
      id: "ordered-list-period",
      source: "1. First\n2. Second",
      expectedDecorations: ["nn-lp-list-marker"],
      expectedSemantics: ["ordered-list"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Lists`,
    }),
    livePreview({
      id: "ordered-list-parenthesis",
      source: "1) First\n2) Second",
      expectedDecorations: ["nn-lp-list-marker"],
      expectedSemantics: ["ordered-list"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Lists`,
    }),
    ...(["-", "*", "+"] as const).map((marker, index) => livePreview({
      id: `unordered-list-${["hyphen", "asterisk", "plus"][index]}`,
      source: `${marker} First\n${marker} Second`,
      expectedDecorations: ["nn-lp-list-marker"],
      expectedSemantics: ["unordered-list"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Lists`,
    })),
    livePreview({
      id: "nested-mixed-lists",
      source: "1. Parent\n   - Child\n     1) Grandchild",
      expectedDecorations: ["nn-lp-list-marker"],
      expectedSemantics: ["nested-list", "mixed-list"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Lists > Nesting lists`,
    }),
    livePreview({
      id: "task-unchecked",
      source: "- [ ] Open task",
      expectedDecorations: ["nn-lp-task"],
      expectedSemantics: ["task-checkbox-unchecked"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "toggleTask"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Lists > Task lists`,
    }),
    livePreview({
      id: "task-checked",
      source: "- [x] Completed task",
      expectedDecorations: ["nn-lp-task nn-lp-task-checked"],
      expectedSemantics: ["task-checkbox-checked"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "toggleTask"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Lists > Task lists`,
    }),
    livePreview({
      id: "blockquote",
      source: "> Quoted text",
      expectedDecorations: ["nn-lp-blockquote"],
      expectedSemantics: ["blockquote"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Quotes`,
    }),
    ...([
      ["asterisks", "***"],
      ["hyphens", "---"],
      ["underscores", "___"],
      ["spaced-asterisks", "* * *"],
      ["spaced-hyphens", "- - -"],
      ["spaced-underscores", "_ _ _"],
    ] as const).map(([name, source]) => livePreview({
      id: `horizontal-rule-${name}`,
      source,
      expectedDecorations: ["nn-lp-thematic-break"],
      expectedSemantics: ["thematic-break"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Horizontal rule`,
    })),
    livePreview({
      id: "fenced-code-backticks",
      source: "```ts\nconst value = 1;\n```",
      expectedDecorations: ["nn-lp-fenced-code"],
      expectedSemantics: ["fenced-code"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Code > Code blocks`,
    }),
    livePreview({
      id: "fenced-code-tildes",
      source: "~~~ts\nconst value = 1;\n~~~",
      expectedDecorations: ["nn-lp-fenced-code"],
      expectedSemantics: ["fenced-code"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Code > Code blocks`,
    }),
    livePreview({
      id: "fenced-code-nested-longer-outer",
      source: "````md\n```js\nconsole.log('nested');\n```\n````",
      expectedDecorations: ["nn-lp-fenced-code"],
      expectedSemantics: ["nested-fenced-code"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Code > Nesting code blocks`,
    }),
    livePreview({
      id: "markdown-internal-link",
      source: "[Deep Work](Areas/Deep%20Work.md)",
      expectedDecorations: ["nn-lp-link"],
      expectedSemantics: ["internal-markdown-link"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateInternalLink"],
      navigation: "guardedVaultNote",
      projectSection: LINKS,
      obsidianCategory: `${BASIC} > Internal links`,
    }),
    livePreview({
      id: "markdown-external-link",
      source: "[Obsidian Help](https://help.obsidian.md)",
      expectedDecorations: ["nn-lp-link"],
      expectedSemantics: ["external-link-label", "non-navigating"],
      projectSection: LINKS,
      obsidianCategory: `${BASIC} > External links`,
    }),
    inert({
      id: "markdown-unsafe-link",
      source: "[unsafe](javascript:alert)",
      expectedDecorations: ["nn-lp-link"],
      expectedSemantics: ["unsafe-link", "inert"],
      projectSection: SECURITY,
      obsidianCategory: `${BASIC} > External links`,
    }),
    livePreview({
      id: "gfm-table-alignment-inline",
      source: "| Left | Right |\n| :--- | ---: |\n| *em* | **strong** |",
      expectedDecorations: ["nn-lp-table"],
      expectedSemantics: ["table", "column-headers", "alignment-markers", "inline-cell-formatting"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateTableSource"],
      projectSection: DECORATIONS,
      obsidianCategory: "Advanced formatting syntax > Tables",
    }),
    livePreview({
      id: "gfm-table-escaped-pipe",
      source: "| Expression | Result |\n| --- | --- |\n| a \\| b | literal pipe |",
      expectedDecorations: ["nn-lp-table"],
      expectedSemantics: ["table", "escaped-table-pipe"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateTableSource"],
      projectSection: DECORATIONS,
      obsidianCategory: "Advanced formatting syntax > Tables",
    }),
    livePreview({
      id: "wikilink",
      source: "[[Areas/Deep Work]]",
      expectedDecorations: ["nn-lp-wikilink-resolved"],
      expectedSemantics: ["wikilink"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateInternalLink"],
      navigation: "guardedVaultNote",
      projectSection: LINKS,
      obsidianCategory: "Internal links > Supported formats",
    }),
    livePreview({
      id: "wikilink-alias",
      source: "[[Areas/Deep Work|focus session]]",
      expectedDecorations: ["nn-lp-wikilink-resolved"],
      expectedSemantics: ["wikilink", "alias-label"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateInternalLink"],
      navigation: "guardedVaultNote",
      projectSection: LINKS,
      obsidianCategory: "Internal links > Change the link display text",
    }),
    livePreview({
      id: "wikilink-heading-fragment",
      source: "[[Daily#Review]]",
      expectedDecorations: ["nn-lp-wikilink-resolved"],
      expectedSemantics: ["wikilink", "heading-fragment"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateInternalLink"],
      navigation: "guardedVaultNote",
      projectSection: LINKS,
      obsidianCategory: "Internal links > Link to a heading in a note",
    }),
    livePreview({
      id: "wikilink-block-fragment",
      source: "[[Daily#^evidence-id]]",
      expectedDecorations: ["nn-lp-wikilink-resolved"],
      expectedSemantics: ["wikilink", "block-fragment"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateInternalLink"],
      navigation: "guardedVaultNote",
      projectSection: LINKS,
      obsidianCategory: "Internal links > Link to a block in a note",
    }),
    livePreview({
      id: "wikilink-resolved",
      source: "[[Daily]]",
      expectedDecorations: ["nn-lp-wikilink-resolved"],
      expectedSemantics: ["resolved-wikilink"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateInternalLink"],
      navigation: "guardedVaultNote",
      projectSection: LINKS,
      obsidianCategory: "Internal links",
    }),
    livePreview({
      id: "wikilink-unresolved",
      source: "[[Missing note]]",
      expectedDecorations: ["nn-lp-wikilink-unresolved"],
      expectedSemantics: ["unresolved-wikilink", "non-navigating"],
      projectSection: LINKS,
      obsidianCategory: "Internal links",
    }),
    ...([
      ["nested", "#inbox/to-read"],
      ["unicode", "#café"],
      ["emoji", "#🧠notes"],
    ] as const).map(([name, source]) => livePreview({
      id: `inline-tag-${name}`,
      source,
      expectedDecorations: ["nn-lp-tag"],
      expectedSemantics: ["inline-tag", name],
      allowedInteractions: [...SOURCE_INTERACTIONS, "searchTag"],
      navigation: "tagSearch",
      projectSection: DECORATIONS,
      obsidianCategory: `Tags > ${name === "nested" ? "Nested tags" : "Tag format"}`,
    })),
    livePreview({
      id: "callout-marker",
      source: "> [!NOTE] Exact source\n> Callout body.",
      expectedDecorations: ["nn-lp-callout"],
      expectedSemantics: ["callout-marker", "blockquote"],
      projectSection: DECORATIONS,
      obsidianCategory: "Callouts",
    }),
    livePreview({
      id: "block-id",
      source: "Evidence paragraph. ^evidence-id",
      expectedDecorations: ["nn-lp-block-id"],
      expectedSemantics: ["block-id"],
      projectSection: DECORATIONS,
      obsidianCategory: "Internal links > Link to a block in a note",
    }),
    livePreview({
      id: "yaml-frontmatter-properties",
      source: "---\ntitle: Exact source\ntags: [compatibility, '#nested/tag']\n---\nBody",
      expectedSemantics: ["yaml-frontmatter", "reversible-properties"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "togglePropertiesSource", "searchTag"],
      projectSection: "Architecture > One source-backed editor",
      obsidianCategory: "Properties > Property format",
    }),
    livePreview({
      id: "marker-reveal-boundaries",
      source: "before **strong** after",
      expectedDecorations: ["nn-lp-strong"],
      expectedSemantics: ["inactive-markers-hidden", "active-markers-revealed-before-inside-after"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Bold, italics, highlights`,
    }),
    livePreview({
      id: "multiple-selections",
      source: "*emphasis* and **strong**",
      expectedDecorations: ["nn-lp-emphasis", "nn-lp-strong"],
      expectedSemantics: ["multiple-active-constructs"],
      projectSection: DECORATIONS,
      obsidianCategory: `${BASIC} > Bold, italics, highlights`,
    }),
    livePreview({
      id: "clipboard-history-source",
      source: "Copy **exact Markdown**, cut it, paste it, undo, then redo.",
      expectedDecorations: ["nn-lp-strong"],
      expectedSemantics: ["source-clipboard", "source-history"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "cutSource", "pasteSource", "undo", "redo"],
      projectSection: INTERACTION,
      obsidianCategory: `${BASIC} > Bold, italics, highlights`,
    }),
    livePreview({
      id: "task-toggle-marker-only",
      source: "- [ ] Preserve the rest of this task",
      expectedDecorations: ["nn-lp-task"],
      expectedSemantics: ["task-checkbox", "marker-only-toggle"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "toggleTask", "undo", "redo"],
      projectSection: INTERACTION,
      obsidianCategory: `${BASIC} > Lists > Task lists`,
    }),
    livePreview({
      id: "table-preview-source-switch",
      source: "| Header |\n| --- |\n| Value |",
      expectedDecorations: ["nn-lp-table"],
      expectedSemantics: ["semantic-table", "exact-source-on-activation"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateTableSource"],
      projectSection: DECORATIONS,
      obsidianCategory: "Advanced formatting syntax > Tables",
    }),
    livePreview({
      id: "wikilink-completion",
      source: "[[Deep",
      expectedSemantics: ["wikilink-completion", "partially-typed-source"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "completeWikilink"],
      projectSection: LINKS,
      obsidianCategory: "Internal links > Link to a file",
    }),
    livePreview({
      id: "wikilink-completion-alias",
      source: "[[Areas/Deep Work|focus",
      expectedSemantics: ["wikilink-completion", "alias-editing"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "completeWikilink"],
      projectSection: LINKS,
      obsidianCategory: "Internal links > Change the link display text",
    }),
    livePreview({
      id: "wikilink-fragment-continuation",
      source: "[[Daily#Rev",
      expectedSemantics: ["wikilink-completion", "fragment-editing"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "completeWikilink"],
      projectSection: LINKS,
      obsidianCategory: "Internal links > Link to a heading in a note",
    }),
    livePreview({
      id: "pointer-activation",
      source: "[[Daily]] and #review",
      expectedDecorations: ["nn-lp-wikilink-resolved", "nn-lp-tag"],
      expectedSemantics: ["pointer-activation"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateInternalLink", "searchTag"],
      navigation: "guardedVaultNoteOrTagSearch",
      projectSection: INTERACTION,
      obsidianCategory: "Internal links; Tags",
    }),
    livePreview({
      id: "enter-activation",
      source: "[[Daily]] and #review",
      expectedDecorations: ["nn-lp-wikilink-resolved", "nn-lp-tag"],
      expectedSemantics: ["keyboard-enter-activation"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateInternalLink", "searchTag"],
      navigation: "guardedVaultNoteOrTagSearch",
      projectSection: INTERACTION,
      obsidianCategory: "Internal links; Tags",
    }),
    livePreview({
      id: "mod-enter-activation",
      source: "[[Daily]] and #review",
      expectedDecorations: ["nn-lp-wikilink-resolved", "nn-lp-tag"],
      expectedSemantics: ["keyboard-mod-enter-activation"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "activateInternalLink", "searchTag"],
      navigation: "guardedVaultNoteOrTagSearch",
      projectSection: INTERACTION,
      obsidianCategory: "Internal links; Tags",
    }),
    sourceOnly({
      id: "escaped-markdown-literal",
      source: String.raw`\*literal emphasis\* and \#literal-tag and 1\. literal list`,
      expectedSemantics: ["escaped-literal-source"],
      projectSection: SECURITY,
      obsidianCategory: `${BASIC} > Escaping Markdown Syntax`,
    }),
    sourceOnly({
      id: "malformed-partial-constructs",
      source: "#unterminated *emphasis and [link and ```",
      expectedSemantics: ["malformed-literal-source", "editable"],
      projectSection: "Failure handling",
      obsidianCategory: BASIC,
    }),
    livePreview({
      id: "tag-exclusion-zones",
      source: "---\ntags: [#yaml]\n---\n`#code` [label](Note.md#fragment)\nA real #body tag",
      expectedDecorations: ["nn-lp-tag"],
      expectedSemantics: ["tag-exclusion-frontmatter-code-link", "inline-tag"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "searchTag"],
      navigation: "tagSearch",
      projectSection: DECORATIONS,
      obsidianCategory: "Tags > Tag format",
    }),
    livePreview({
      id: "large-table-source-fallback",
      source: LARGE_TABLE_SOURCE,
      expectedDecorations: ["nn-lp-table-source"],
      expectedSemantics: ["editable-table-source", "bounded-widget-fallback"],
      projectSection: "Performance and packaging gates",
      obsidianCategory: "Advanced formatting syntax > Tables",
    }),
    livePreview({
      id: "narrow-viewport-bounded",
      source: NARROW_VIEWPORT_SOURCE,
      expectedDecorations: ["nn-lp-heading-1"],
      expectedSemantics: ["viewport-bounded-decoration"],
      projectSection: "Performance and packaging gates",
      obsidianCategory: `${BASIC} > Headings`,
    }),
    livePreview({
      id: "decoration-failure-recovery",
      source: "# Source survives decoration failure",
      expectedSemantics: ["recoverable-preview-error", "original-source-visible"],
      projectSection: "Failure handling",
      obsidianCategory: `${BASIC} > Headings`,
    }),
    sourceOnly({
      id: "no-op-byte-identity",
      source: "No-op open and close.\n",
      expectedSemantics: ["byte-for-byte-identity"],
      projectSection: PRESERVATION,
      obsidianCategory: `${BASIC} > Paragraphs`,
    }),
    ...([
      ["lf", "one\ntwo\n"],
      ["crlf", "one\r\ntwo\r\n"],
      ["cr", "one\rtwo\r"],
      ["mixed", "one\r\ntwo\nthree\rfour"],
    ] as const).map(([name, source]) => sourceOnly({
      id: `line-endings-${name}`,
      source,
      expectedSemantics: [`${name}-line-endings`, "byte-for-byte-identity"],
      allowedInteractions: EXACT_CUT_INTERACTIONS,
      projectSection: PRESERVATION,
      obsidianCategory: `${BASIC} > Paragraphs > Line breaks`,
    })),
    sourceOnly({
      id: "byte-order-mark",
      source: "\uFEFF# BOM heading\n",
      expectedSemantics: ["byte-order-mark", "byte-for-byte-identity"],
      allowedInteractions: EXACT_CUT_INTERACTIONS,
      projectSection: PRESERVATION,
      obsidianCategory: `${BASIC} > Headings`,
    }),
    sourceOnly({
      id: "tabs",
      source: "\tTabbed source\n\t- preserved",
      expectedSemantics: ["tabs", "byte-for-byte-identity"],
      projectSection: PRESERVATION,
      obsidianCategory: `${BASIC} > Lists > Nesting lists`,
    }),
    sourceOnly({
      id: "trailing-spaces",
      source: "Hard break  \nNext line  ",
      expectedSemantics: ["trailing-spaces", "byte-for-byte-identity"],
      projectSection: PRESERVATION,
      obsidianCategory: `${BASIC} > Paragraphs > Line breaks`,
    }),
    sourceOnly({
      id: "unicode",
      source: "café 漢字 🧠 e\u0301",
      expectedSemantics: ["unicode", "byte-for-byte-identity"],
      allowedInteractions: EXACT_CUT_INTERACTIONS,
      projectSection: PRESERVATION,
      obsidianCategory: `${BASIC} > Paragraphs`,
    }),
    inert({
      id: "image-standard-inert",
      source: "![Architecture diagram](diagram.png)",
      expectedDecorations: ["nn-lp-image"],
      expectedSemantics: ["accessible-inert-image-label"],
      accessibleLabel: "Image: Architecture diagram",
      projectSection: LINKS,
      obsidianCategory: `${BASIC} > External images`,
    }),
    inert({
      id: "image-local-vault-inert",
      source: "![Local attachment](Attachments/private.png)",
      expectedDecorations: ["nn-lp-image"],
      expectedSemantics: ["accessible-inert-image-label", "no-native-read"],
      accessibleLabel: "Image: Local attachment",
      projectSection: LINKS,
      obsidianCategory: "Embed files > Embed an image in a note",
    }),
    inert({
      id: "image-remote-inert",
      source: "![Remote](https://example.test/private.png)",
      expectedDecorations: ["nn-lp-image"],
      expectedSemantics: ["accessible-inert-image-label", "no-network-request"],
      accessibleLabel: "Image: Remote",
      projectSection: LINKS,
      obsidianCategory: `${BASIC} > External images`,
    }),
    inert({
      id: "image-unsafe-scheme-inert",
      source: "![Unsafe](javascript:alert)",
      expectedDecorations: ["nn-lp-image"],
      expectedSemantics: ["accessible-inert-image-label", "no-dom-url"],
      accessibleLabel: "Image: Unsafe",
      projectSection: SECURITY,
      obsidianCategory: `${BASIC} > External images`,
    }),
    inert({
      id: "embed-image-inert",
      source: "![[Attachments/photo.png]]",
      expectedDecorations: ["nn-lp-embed"],
      expectedSemantics: ["accessible-inert-embed-label", "no-native-read"],
      accessibleLabel: "Embed: photo.png",
      projectSection: LINKS,
      obsidianCategory: "Embed files > Embed an image in a note",
    }),
    inert({
      id: "embed-note-inert",
      source: "![[Areas/Deep Work.md]]",
      expectedDecorations: ["nn-lp-embed"],
      expectedSemantics: ["accessible-inert-embed-label", "no-transclusion"],
      accessibleLabel: "Embed: Deep Work",
      projectSection: LINKS,
      obsidianCategory: "Embed files > Embed a note in another note",
    }),
    inert({
      id: "image-active-source",
      source: "![Alt text](asset.png)",
      expectedDecorations: ["nn-lp-image"],
      expectedSemantics: ["complete-source-on-active-caret", "inert"],
      accessibleLabel: "Image: Alt text",
      projectSection: LINKS,
      obsidianCategory: `${BASIC} > External images`,
    }),
    inert({
      id: "image-edit-history-source",
      source: "![Editable](asset.png)",
      expectedDecorations: ["nn-lp-image"],
      expectedSemantics: ["exact-source-copy-edit-undo-save", "inert"],
      allowedInteractions: [...SOURCE_INTERACTIONS, "cutSource", "pasteSource", "undo", "redo"],
      accessibleLabel: "Image: Editable",
      projectSection: LINKS,
      obsidianCategory: `${BASIC} > External images`,
    }),
    inert({
      id: "image-missing-alt-fallback",
      source: "![](missing.png)",
      expectedDecorations: ["nn-lp-image"],
      expectedSemantics: ["stable-accessible-fallback", "inert"],
      accessibleLabel: "Image: image",
      projectSection: LINKS,
      obsidianCategory: `${BASIC} > External images`,
    }),
    sourceOnly({
      id: "raw-html-source-only",
      source: "<button onclick=\"alert('x')\">Run</button>",
      expectedSemantics: ["literal-raw-html", "non-executing"],
      projectSection: SECURITY,
      obsidianCategory: "Obsidian Flavored Markdown > Markdown inside HTML",
    }),
    sourceOnly({
      id: "mdx-source-only",
      source: "export const value = run()\n\n# MDX source",
      expectedSemantics: ["literal-mdx", "non-executing"],
      projectSection: SECURITY,
      obsidianCategory: "Unsupported extension > MDX",
    }),
    sourceOnly({
      id: "jsx-source-only",
      source: "<Component onClick={() => run()} />",
      expectedSemantics: ["literal-jsx", "non-executing"],
      projectSection: SECURITY,
      obsidianCategory: "Unsupported extension > JSX",
    }),
    sourceOnly({
      id: "inline-math-source-only",
      source: String.raw`Euler wrote $e^{i\pi} + 1 = 0$.`,
      expectedSemantics: ["literal-inline-math", "non-executing"],
      projectSection: SECURITY,
      obsidianCategory: "Advanced formatting syntax > Math",
    }),
    sourceOnly({
      id: "block-math-source-only",
      source: "$$\ne^{i\\pi} + 1 = 0\n$$",
      expectedSemantics: ["literal-block-math", "non-executing"],
      projectSection: SECURITY,
      obsidianCategory: "Advanced formatting syntax > Math",
    }),
    sourceOnly({
      id: "footnotes-source-only",
      source: "A claim[^evidence].\n\n[^evidence]: Exact source.",
      expectedSemantics: ["literal-footnote-source", "editable"],
      projectSection: SECURITY,
      obsidianCategory: `${BASIC} > Footnotes`,
    }),
    sourceOnly({
      id: "dataview-source-only",
      source: "```dataview\nTABLE file.name FROM #project\n```",
      expectedSemantics: ["literal-plugin-fence", "non-executing"],
      projectSection: SECURITY,
      obsidianCategory: "Community plugin syntax > Dataview",
    }),
    sourceOnly({
      id: "dataviewjs-source-only",
      source: "```dataviewjs\ndv.paragraph(app.vault.getFiles())\n```",
      expectedSemantics: ["literal-plugin-fence", "non-executing"],
      projectSection: SECURITY,
      obsidianCategory: "Community plugin syntax > DataviewJS",
    }),
    sourceOnly({
      id: "mermaid-source-only",
      source: "```mermaid\ngraph TD\nA --> B\n```",
      expectedSemantics: ["literal-plugin-fence", "non-executing"],
      projectSection: SECURITY,
      obsidianCategory: "Advanced formatting syntax > Diagram",
    }),
    sourceOnly({
      id: "plugin-fence-source-only",
      source: "```unknown-plugin\nrun: privileged-action\n```",
      expectedSemantics: ["literal-plugin-fence", "non-executing"],
      projectSection: SECURITY,
      obsidianCategory: "Community plugin syntax > Unknown code fence",
    }),
    sourceOnly({
      id: "obsidian-highlight-source-only",
      source: "==highlight stays exact source==",
      expectedSemantics: ["literal-obsidian-highlight", "editable"],
      projectSection: "Failure handling",
      obsidianCategory: `${BASIC} > Bold, italics, highlights`,
    }),
    sourceOnly({
      id: "obsidian-comment-source-only",
      source: "Visible %%comment remains in source%% text.",
      expectedSemantics: ["literal-obsidian-comment", "editable"],
      projectSection: "Failure handling",
      obsidianCategory: `${BASIC} > Comments`,
    }),
    sourceOnly({
      id: "unknown-plugin-source-only",
      source: "{{plugin:run dangerous=true}}",
      expectedSemantics: ["literal-unknown-plugin-syntax", "non-executing"],
      projectSection: SECURITY,
      obsidianCategory: "Community plugin syntax > Unknown",
    }),
    sourceOnly({
      id: "malformed-callout-source-only",
      source: "> [!note Missing bracket\n> Body remains source.",
      expectedSemantics: ["literal-malformed-callout", "editable"],
      projectSection: "Failure handling",
      obsidianCategory: "Callouts",
    }),
    sourceOnly({
      id: "malformed-embed-source-only",
      source: "![[Unclosed embed",
      expectedSemantics: ["literal-malformed-embed", "editable"],
      projectSection: "Failure handling",
      obsidianCategory: "Embed files",
    }),
    sourceOnly({
      id: "malformed-link-source-only",
      source: "[Unclosed link](Daily.md",
      expectedSemantics: ["literal-malformed-link", "editable"],
      projectSection: "Failure handling",
      obsidianCategory: `${BASIC} > Internal links`,
    }),
    sourceOnly({
      id: "malformed-table-source-only",
      source: "| A | B |\n| -- | not a delimiter |\n| C | D |",
      expectedSemantics: ["literal-malformed-table", "editable"],
      projectSection: "Failure handling",
      obsidianCategory: "Advanced formatting syntax > Tables",
    }),
    sourceOnly({
      id: "reference-link-source-only",
      source: "[Daily reference][daily]\n\n[daily]: Daily.md",
      expectedSemantics: ["reference-link-source", "editable"],
      projectSection: "Test-first implementation contract",
      obsidianCategory: "CommonMark > Reference links",
    }),
    sourceOnly({
      id: "autolink-source-only",
      source: "<https://example.test/path>",
      expectedSemantics: ["autolink-source", "editable"],
      projectSection: "Test-first implementation contract",
      obsidianCategory: "CommonMark > Autolinks",
    }),
    sourceOnly({
      id: "hard-break-source-only",
      source: "First line  \nSecond line",
      expectedSemantics: ["hard-break-source", "editable"],
      projectSection: PRESERVATION,
      obsidianCategory: `${BASIC} > Paragraphs > Line breaks`,
    }),
    sourceOnly({
      id: "indented-code-source-only",
      source: "    const exact = 'source';",
      expectedSemantics: ["indented-code-source", "editable"],
      projectSection: "Test-first implementation contract",
      obsidianCategory: `${BASIC} > Code > Code blocks`,
    }),
  ],
};
