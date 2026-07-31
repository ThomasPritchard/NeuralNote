import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { resolveWikilink, type NoteIndexEntry } from "./linkResolve";
import { inlineTagAt } from "./obsidianTag";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/**
 * CT-3 — the canonical projection of a table cell onto what the editor actually
 * paints, shared by the measurement path and the paint path.
 *
 * Measurement cannot use the raw cell source. `| **bold** |` carries four
 * asterisks the paint layer hides, and paints the six characters between them
 * heavier than the source font — two errors of opposite sign, content-dependent,
 * with no correction factor available. Three independent decoration sources run
 * over the same characters (the table `StateField`, `collectMarkdownPreview` and
 * `collectObsidianPreview`), so a measurement layer holding its own list of
 * hidden node names would drift from the paint layer and the measured width
 * would belong to a different string than the user sees. That failure mode is
 * column jitter, not an error, which is what makes duplicating it tempting and
 * wrong. This module is the one place that decides; everything else consumes it.
 *
 * **The plan is a TARGET, matching the CT-1 fixture.** At HEAD the preview
 * collector refuses to descend into a `Table` node, so a cell's inline markup is
 * painted literally in the revealed-source state. `sourceEditorTableContractFixture.ts`
 * freezes the cell text a drawn cell will show (`**DJ gig**` renders as
 * `DJ gig`), and this module produces exactly that.
 *
 * **Three disjoint categories cover every character of a cell**: painted as
 * itself (a `text` run), replaced by drawn chrome (a `widget` run), or hidden
 * outright (a {@link CellPaintPlan.hiddenRanges} entry). The three tile the
 * cell's span exactly, which is what lets the paint path derive its decorations
 * from the same object the measurement path measures.
 */

/** Which half of a table a cell sits in. Header cells paint at their own weight. */
export type CellPaintContext = "header" | "body";

export interface CellPaintRange {
  readonly from: number;
  readonly to: number;
}

/** A run of source painted as itself, or the chrome drawn in place of it. */
export type CellPaintRunKind = "text" | "widget";

export interface CellPaintRun {
  readonly kind: CellPaintRunKind;
  /** The characters this run puts on screen. For a widget, its drawn label. */
  readonly text: string;
  /** Mark classes covering this run, outermost first. */
  readonly classNames: readonly string[];
  /**
   * The source span this run stands for. Deliberately absent from
   * {@link CellPaintPlan.signature}: moving an identical cell must not change
   * its measured width.
   */
  readonly from: number;
  readonly to: number;
}

export interface CellPaintPlan {
  readonly context: CellPaintContext;
  /** Exactly what the paint layer renders, character for character. */
  readonly visibleText: string;
  readonly runs: readonly CellPaintRun[];
  /** Source spans that reach the screen as nothing at all. */
  readonly hiddenRanges: readonly CellPaintRange[];
  /**
   * Cache key for a measured width, as `(styleEpoch, signature)`. Derived from
   * the painted runs and the cell's context only — never from source offsets,
   * so an identical cell elsewhere in the note reuses the same measurement.
   */
  readonly signature: string;
}

export interface CellPaintPlanOptions {
  readonly context: CellPaintContext;
  /** Vault notes, for telling a resolved wikilink from an unresolved one. */
  readonly index?: readonly NoteIndexEntry[];
  /**
   * `false` while the editor is unfocused, matching `collectObsidianPreview`:
   * a wikilink then keeps its widget however the selection falls.
   */
  readonly selectionActive?: boolean;
}

/**
 * Node names whose source the paint layer drops while their construct is
 * inactive. THE list — `sourceEditorDecorationsPreview.ts` imports it rather
 * than keeping a second copy, which is the divergence CT-3 exists to prevent.
 */
export const HIDDEN_MARKER_NODES: ReadonlySet<string> = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
]);

/** Nodes whose interior is literal text, so no Obsidian syntax is read inside. */
export const CODE_MASKED_NODES: ReadonlySet<string> = new Set([
  "CodeBlock",
  "FencedCode",
  "InlineCode",
]);

/** Nodes whose interior never yields an inline tag. */
export const TAG_MASKED_NODES: ReadonlySet<string> = new Set([
  "Autolink",
  "CodeBlock",
  "Escape",
  "FencedCode",
  "HTMLTag",
  "Image",
  "InlineCode",
  "Link",
  "LinkLabel",
  "LinkReference",
  "URL",
]);

/** The mark class each inline construct paints over its own span. */
export const CELL_MARK_CLASS_BY_NODE: ReadonlyMap<string, string> = new Map([
  ["Emphasis", "nn-lp-emphasis"],
  ["StrongEmphasis", "nn-lp-strong"],
  ["Strikethrough", "nn-lp-strikethrough"],
  ["InlineCode", "nn-lp-inline-code"],
  ["Link", "nn-lp-link"],
]);

/** The class a revealed marker is painted with; monospace, so it measures wider. */
const REVEALED_MARKER_CLASS = "nn-lp-marker-active";

/** Whether any selection range puts the caret strictly inside `[from, to)`. */
export function caretInside(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) =>
    range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from,
  );
}

/**
 * As {@link caretInside}, but a caret resting exactly at `to` counts as inside.
 * Links and wikilinks reveal on the trailing edge so the source can be edited
 * from the position the caret naturally lands on after typing one.
 */
export function caretTouching(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) =>
    range.empty ? range.head >= from && range.head <= to : range.from < to && range.to > from,
  );
}

export interface InlineWikilink extends CellPaintRange {
  readonly embed: boolean;
  readonly rawTarget: string;
  /** What the paint layer draws in place of the source. */
  readonly label: string;
}

/** The label a wikilink paints: its alias, or its target's bare note name. */
function wikilinkLabel(rawTarget: string): string {
  const [beforeAlias, alias] = rawTarget.split("|", 2);
  if (alias?.trim()) return alias.trim();
  const note = (beforeAlias ?? rawTarget).split("#", 1)[0]?.trim() ?? rawTarget;
  const base = note.slice(note.lastIndexOf("/") + 1).replace(/\.(?:md|markdown|mdx)$/i, "");
  return base || rawTarget;
}

/**
 * Every `[[wikilink]]` in `source`, at document offsets. THE scanner —
 * `obsidianLivePreview.ts` uses it too, so the span the paint layer replaces and
 * the span this plan projects can never be two different answers.
 *
 * @param source - the text to scan
 * @param base - the document offset `source` starts at
 */
export function inlineWikilinks(source: string, base = 0): InlineWikilink[] {
  return [...source.matchAll(/(!)?\[\[([^\]\r\n]+)\]\]/g)].map((match) => ({
    from: base + match.index,
    to: base + match.index + match[0].length,
    embed: match[1] === "!",
    rawTarget: match[2],
    label: wikilinkLabel(match[2]),
  }));
}

/** The label an inactive image paints in place of its source. */
export function imageWidgetLabel(source: string): string {
  return `Image: ${/^!\[([^\]]*)\]/.exec(source)?.[1] || "image"}`;
}

interface MarkSpan extends CellPaintRange {
  readonly className: string;
}

interface WidgetSpan extends MarkSpan {
  readonly text: string;
}

interface CellSyntax {
  readonly marks: MarkSpan[];
  readonly hidden: CellPaintRange[];
  readonly widgets: WidgetSpan[];
  readonly codeSpans: CellPaintRange[];
  readonly tagMaskedSpans: CellPaintRange[];
}

function overlapsAny(span: CellPaintRange, ranges: readonly CellPaintRange[]): boolean {
  return ranges.some((range) => span.from < range.to && span.to > range.from);
}

/** Whether a construct shows its own source because the caret is in it. */
function constructRevealed(state: EditorState, construct: SyntaxNode): boolean {
  return construct.name === "Link"
    ? caretTouching(state, construct.from, construct.to)
    : caretInside(state, construct.from, construct.to);
}

function isLinkDestination(node: SyntaxNode): boolean {
  return node.name === "URL"
    && (node.parent?.name === "Link" || node.parent?.name === "Image");
}

/** What the Markdown tree alone says about a cell. */
function scanCellSyntax(state: EditorState, cell: CellPaintRange): CellSyntax {
  const syntax: CellSyntax = {
    marks: [], hidden: [], widgets: [], codeSpans: [], tagMaskedSpans: [],
  };

  syntaxTree(state).iterate({
    from: cell.from,
    to: cell.to,
    enter(ref) {
      const { name, from, to, node } = ref;
      if (to <= cell.from || from >= cell.to) return false;
      if (CODE_MASKED_NODES.has(name)) syntax.codeSpans.push({ from, to });
      if (TAG_MASKED_NODES.has(name)) syntax.tagMaskedSpans.push({ from, to });

      const markClass = CELL_MARK_CLASS_BY_NODE.get(name);
      if (markClass) {
        syntax.marks.push({ from, to, className: markClass });
        return true;
      }
      if (name === "Image" && !constructRevealed(state, node)) {
        syntax.widgets.push({
          from,
          to,
          className: "nn-lp-image",
          text: imageWidgetLabel(state.sliceDoc(from, to)),
        });
        return false;
      }
      if (HIDDEN_MARKER_NODES.has(name) || isLinkDestination(node)) {
        if (constructRevealed(state, node.parent ?? node)) {
          syntax.marks.push({ from, to, className: REVEALED_MARKER_CLASS });
        } else {
          syntax.hidden.push({ from, to });
        }
      }
      return true;
    },
  });
  return syntax;
}

function wikilinkWidget(link: InlineWikilink, index: readonly NoteIndexEntry[]): WidgetSpan {
  const target = resolveWikilink(link.rawTarget, [...index]);
  return {
    from: link.from,
    to: link.to,
    className: link.embed
      ? "nn-lp-embed"
      : target
        ? "nn-lp-wikilink-resolved"
        : "nn-lp-wikilink-unresolved",
    text: `${link.embed ? "Embed: " : ""}${link.label}`,
  };
}

/**
 * The Markdown tree's findings, plus what Obsidian's own syntax says.
 *
 * A DRAWN wikilink is one replacement over its whole span, so nothing the
 * Markdown tree found inside it reaches the screen and every overlapping span is
 * dropped. `![[Note]]` is why this is load-bearing rather than tidy: it also
 * parses as an `Image`, and two replacements over the same characters would
 * otherwise fight, painting `Image: [Note` where the user wrote an embed.
 *
 * A REVEALED wikilink is a mark, not a replacement, so it composes instead —
 * exactly as the two collectors compose over the same characters today.
 */
function withObsidianSpans(
  state: EditorState,
  cell: CellPaintRange,
  syntax: CellSyntax,
  options: CellPaintPlanOptions,
): CellSyntax {
  const source = state.sliceDoc(cell.from, cell.to);
  const links = inlineWikilinks(source, cell.from)
    .filter((link) => !overlapsAny(link, syntax.codeSpans));
  const revealed = (link: InlineWikilink) =>
    (options.selectionActive ?? true) && caretTouching(state, link.from, link.to);
  const drawn = links.filter((link) => !revealed(link));
  const survives = (span: CellPaintRange) => !overlapsAny(span, drawn);

  const marks = [
    ...syntax.marks.filter(survives),
    ...links.filter(revealed).map((link) => ({
      from: link.from,
      to: link.to,
      className: "nn-lp-wikilink-active",
    })),
  ];
  const merged: CellSyntax = {
    ...syntax,
    marks,
    hidden: syntax.hidden.filter(survives),
    widgets: [
      ...syntax.widgets.filter(survives),
      ...drawn.map((link) => wikilinkWidget(link, options.index ?? [])),
    ],
  };

  const masked = [...syntax.tagMaskedSpans, ...links];
  for (const hash of source.matchAll(/#/g)) {
    const from = cell.from + hash.index;
    if (from !== 0 && !/\s/u.test(state.sliceDoc(from - 1, from))) continue;
    const tag = inlineTagAt(source, hash.index);
    if (!tag) continue;
    const span = { from, to: from + tag.length };
    if (!overlapsAny(span, masked)) marks.push({ ...span, className: "nn-lp-tag" });
  }
  return merged;
}

/** Mark classes covering `[from, to)`, widest span first. */
function classesOver(marks: readonly MarkSpan[], from: number, to: number): string[] {
  return marks
    .filter((mark) => mark.from <= from && mark.to >= to)
    .sort((left, right) => (right.to - right.from) - (left.to - left.from) || left.from - right.from)
    .map((mark) => mark.className);
}

function covers(ranges: readonly CellPaintRange[], from: number, to: number): boolean {
  return ranges.some((range) => range.from <= from && range.to >= to);
}

/** Adjacent text runs with the same classes are one run, not several. */
function mergeAdjacent(runs: readonly CellPaintRun[]): CellPaintRun[] {
  const merged: CellPaintRun[] = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    const joinable = previous
      && previous.kind === "text"
      && run.kind === "text"
      && previous.to === run.from
      && previous.classNames.join(" ") === run.classNames.join(" ");
    if (joinable) {
      merged[merged.length - 1] = { ...previous, text: previous.text + run.text, to: run.to };
    } else {
      merged.push(run);
    }
  }
  return merged;
}

function paintRuns(state: EditorState, cell: CellPaintRange, syntax: CellSyntax): CellPaintRun[] {
  const stops = [...new Set([
    cell.from,
    cell.to,
    ...syntax.marks.flatMap((span) => [span.from, span.to]),
    ...syntax.hidden.flatMap((span) => [span.from, span.to]),
    ...syntax.widgets.flatMap((span) => [span.from, span.to]),
  ])]
    .filter((stop) => stop >= cell.from && stop <= cell.to)
    .sort((left, right) => left - right);

  const runs: CellPaintRun[] = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index]!;
    const to = stops[index + 1]!;
    const widget = syntax.widgets.find((span) => span.from === from);
    if (widget) {
      runs.push({
        kind: "widget",
        text: widget.text,
        classNames: [...classesOver(syntax.marks, widget.from, widget.to), widget.className],
        from: widget.from,
        to: widget.to,
      });
      continue;
    }
    if (covers(syntax.widgets, from, to) || covers(syntax.hidden, from, to)) continue;
    runs.push({
      kind: "text",
      text: state.sliceDoc(from, to),
      classNames: classesOver(syntax.marks, from, to),
      from,
      to,
    });
  }
  return mergeAdjacent(runs);
}

/** The cell's span minus everything the runs account for. */
function hiddenComplement(cell: CellPaintRange, runs: readonly CellPaintRun[]): CellPaintRange[] {
  const gaps: CellPaintRange[] = [];
  let position = cell.from;
  for (const run of runs) {
    if (run.from > position) gaps.push({ from: position, to: run.from });
    position = Math.max(position, run.to);
  }
  if (position < cell.to) gaps.push({ from: position, to: cell.to });
  return gaps;
}

/**
 * Length-prefixed rather than delimiter-joined. A cell may legitimately contain
 * any character, so no separator is safe, and two cells signing alike would
 * serve one of them the other's measured width — silently, as a wrong column.
 */
function planSignature(context: CellPaintContext, runs: readonly CellPaintRun[]): string {
  const parts = [
    context,
    ...runs.flatMap((run) => [run.kind, run.classNames.join(" "), run.text]),
  ];
  return parts.map((part) => `${part.length}:${part}`).join("");
}

/**
 * Project one table cell onto what the editor paints for it.
 *
 * @param state - the editor state the cell belongs to
 * @param cell - the cell's content span, as `TableColumnSlot` reports it
 * @param options - header/body context, plus what the Obsidian pass needs
 * @returns the visible text, its runs and classes, and the spans that vanish
 */
export function cellPaintPlan(
  state: EditorState,
  cell: CellPaintRange,
  options: CellPaintPlanOptions,
): CellPaintPlan {
  const syntax = withObsidianSpans(state, cell, scanCellSyntax(state, cell), options);
  const runs = paintRuns(state, cell, syntax);
  return {
    context: options.context,
    visibleText: runs.map((run) => run.text).join(""),
    runs,
    hiddenRanges: hiddenComplement(cell, runs),
    signature: planSignature(options.context, runs),
  };
}
