import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { sourceFrontmatterRange } from "./sourceFrontmatterPreview";
import {
  caretInside,
  caretTouching,
  cellPaintPlan,
  HIDDEN_MARKER_NODES,
  imageWidgetLabel,
  type CellPaintContext,
} from "./sourceEditorCellPaintPlan";
import {
  insideVisibleRanges,
  intersectsVisibleRanges,
  mergeVisibleRanges,
} from "./sourceEditorDecorationsRanges";
import type { PreviewDecoration, PreviewTable, VisibleRange } from "./sourceEditorDecorationsTypes";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/**
 * The constructs a marker's active state is resolved against. A name missing
 * here does not fail loudly: {@link enclosingConstruct} simply keeps climbing,
 * and `caretInside` against the `Document` node is true wherever the caret is —
 * so the construct's markers stay on screen for ever. `Autolink` was missing,
 * which is why `<https://example.org>` kept its angle brackets in a drawn cell
 * while `cellPaintPlan` (and so the column's measured track, and the read-only
 * table widget) dropped them.
 */
const CONSTRUCT_NAMES = new Set([
  "Autolink",
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "InlineCode",
  "Link",
  "Image",
  "FencedCode",
  "SetextHeading1",
  "SetextHeading2",
]);

export const MAX_TABLE_PREVIEW_CHARS = 32_768;
export const MAX_TABLE_PREVIEW_ROWS = 200;

/**
 * A link reveals its source from its trailing edge too, which is exactly
 * {@link caretTouching}. Kept as a named re-export because
 * `sourceEditorDecorations.ts` reads better calling it `activeLink`, and that
 * file belongs to another wave.
 */
export const activeLink = caretTouching;

function headingLineActive(state: EditorState, from: number, to: number): boolean {
  const firstLine = state.doc.lineAt(from).number;
  const lastLine = state.doc.lineAt(to).number;
  return state.selection.ranges.some((range) => {
    const headLine = state.doc.lineAt(range.head).number;
    return headLine >= firstLine && headLine <= lastLine;
  });
}

function enclosingConstruct(node: SyntaxNode): SyntaxNode {
  let current: SyntaxNode | null = node;
  while (current?.parent && !CONSTRUCT_NAMES.has(current.name) && !/^ATXHeading[1-6]$/.test(current.name)) {
    current = current.parent;
  }
  return current ?? node;
}

function push(
  output: PreviewDecoration[],
  ranges: readonly VisibleRange[],
  item: PreviewDecoration,
): void {
  if (insideVisibleRanges(item.from, item.to, ranges)) output.push(item);
}

function completeFencedCode(node: SyntaxNode): boolean {
  let marks = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeMark") marks += 1;
  }
  return marks >= 2;
}

/**
 * The rendered text of one row's cells, read off {@link cellPaintPlan} — the
 * SAME projection the drawn cells and the measurement probe use (CT-3). This
 * used to walk the tree against its own list of hidden node names, which is the
 * divergence G3 forbids: that list had never heard of a wikilink, so
 * `[[Roadmap]]` rendered as `[Roadmap]` here and as `Roadmap` everywhere else.
 */
function tableCells(state: EditorState, row: SyntaxNode, context: CellPaintContext): string[] {
  const cells: string[] = [];
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name !== "TableCell") continue;
    cells.push(cellPaintPlan(state, { from: child.from, to: child.to }, { context }).visibleText.trim());
  }
  return cells;
}

function tablePreview(state: EditorState, table: SyntaxNode): PreviewTable | null {
  const header = table.getChild("TableHeader");
  if (!header) return null;
  const headers = tableCells(state, header, "header");
  if (headers.length === 0) return null;
  const rows: string[][] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableRow") {
      if (rows.length >= MAX_TABLE_PREVIEW_ROWS) return null;
      rows.push(tableCells(state, child, "body"));
    }
  }
  return { headers, rows };
}

export function collectMarkdownPreview(
  state: EditorState,
  visibleRanges: readonly VisibleRange[] = [{ from: 0, to: state.doc.length }],
): PreviewDecoration[] {
  const output: PreviewDecoration[] = [];
  const frontmatter = sourceFrontmatterRange(state);
  const scanRanges = mergeVisibleRanges(visibleRanges, state.doc.length);

  for (const scanRange of scanRanges) {
    syntaxTree(state).iterate({
      from: scanRange.from,
      to: scanRange.to,
      enter(ref) {
      const { node, name, from, to } = ref;
      if (frontmatter && from >= frontmatter.from && to <= frontmatter.to) return false;
      const construct = enclosingConstruct(node);
      const headingConstruct = /^ATXHeading[1-6]$/.test(construct.name)
        || /^SetextHeading[12]$/.test(construct.name);
      const constructActive = (
        construct.name === "Link"
          ? activeLink(state, construct.from, construct.to)
          : caretInside(state, construct.from, construct.to)
      )
        || (headingConstruct && headingLineActive(state, construct.from, construct.to));

      if (/^ATXHeading[1-6]$/.test(name)) {
        const level = name.at(-1);
        push(output, visibleRanges, { from, to, kind: "mark", className: `nn-lp-heading-${level}` });
      } else if (/^SetextHeading[12]$/.test(name)) {
        push(output, visibleRanges, {
          from,
          to,
          kind: "mark",
          className: `nn-lp-heading-${name.at(-1)}`,
        });
      } else if (name === "Emphasis") {
        push(output, visibleRanges, { from, to, kind: "mark", className: "nn-lp-emphasis" });
      } else if (name === "StrongEmphasis") {
        push(output, visibleRanges, { from, to, kind: "mark", className: "nn-lp-strong" });
      } else if (name === "Strikethrough") {
        push(output, visibleRanges, { from, to, kind: "mark", className: "nn-lp-strikethrough" });
      } else if (name === "InlineCode") {
        push(output, visibleRanges, { from, to, kind: "mark", className: "nn-lp-inline-code" });
      } else if (name === "ListMark") {
        push(output, visibleRanges, { from, to, kind: "mark", className: "nn-lp-list-marker" });
      } else if (name === "TaskMarker") {
        const checked = /[xX]/.test(state.sliceDoc(from, to));
        push(output, visibleRanges, caretInside(state, from, to)
          ? { from, to, kind: "mark", className: "nn-lp-task-active", checked }
          : {
              from,
              to,
              kind: "widget",
              className: checked ? "nn-lp-task nn-lp-task-checked" : "nn-lp-task",
              label: checked ? "Mark task incomplete" : "Mark task complete",
              checked,
            });
      } else if (name === "Blockquote") {
        push(output, visibleRanges, { from, to, kind: "mark", className: "nn-lp-blockquote" });
      } else if (name === "HorizontalRule") {
        push(output, visibleRanges, {
          from,
          to,
          kind: "mark",
          className: constructActive ? "nn-lp-marker-active" : "nn-lp-thematic-break",
        });
      } else if (name === "FencedCode" && completeFencedCode(node)) {
        push(output, visibleRanges, { from, to, kind: "mark", className: "nn-lp-fenced-code" });
      } else if (name === "Link") {
        const url = node.getChild("URL");
        push(output, visibleRanges, {
          from,
          to,
          kind: "mark",
          className: "nn-lp-link",
          href: url ? state.sliceDoc(url.from, url.to) : undefined,
        });
      } else if (name === "URL" && construct.name === "Link") {
        push(output, visibleRanges, {
          from,
          to,
          kind: constructActive ? "mark" : "replace",
          className: constructActive ? "nn-lp-marker-active" : "nn-lp-marker",
        });
      } else if (name === "Image" && !constructActive) {
        push(output, visibleRanges, {
          from,
          to,
          kind: "widget",
          className: "nn-lp-image",
          label: imageWidgetLabel(state.sliceDoc(from, to)),
        });
      } else if (name === "Table") {
        if (!intersectsVisibleRanges(from, to, visibleRanges)) return false;
        // Only the INACTIVE arm renders `table`, and projecting a 180-row
        // table's cells costs ~3.5ms — on the keystroke path, for a value the
        // active arm throws away. The result is unchanged either way: a null
        // `table` already fell through to the source mark.
        const drawn = !caretInside(state, from, to) && to - from <= MAX_TABLE_PREVIEW_CHARS;
        const table = drawn ? tablePreview(state, node) : null;
        if (table) {
          output.push({ from, to, kind: "widget", className: "nn-lp-table", table });
          // The widget replaces the table's source WHOLE, so no character inside
          // it reaches the screen and decorating the interior is pure cost.
          return false;
        }
        output.push({ from, to, kind: "mark", className: "nn-lp-table-source", tableSource: true });
        // Descend. This arm paints the cells' OWN source — as drawn grid cells
        // when the caret is inside, as the literal backdrop when the table is
        // too large to draw — so a cell's inline markup has to be decorated
        // exactly as the same markup is anywhere else in the note. Refusing to
        // was G3: `cellPaintPlan` projects `**Urgent**` as `Urgent` and sizes the
        // column to it, while the screen kept the asterisks and the cell spilled
        // over its column rule into the neighbour. Pinned by "paints exactly the
        // text its own paint plan projects" in `sourceEditorDecorations.test.ts`.
        //
        // The descent is bounded by the ITERATION rather than by the table's
        // size: `iterate` only enters nodes overlapping `scanRange`, and `push`
        // drops anything outside `visibleRanges`. "descends no further than the
        // requested visible range" (`sourceEditorDecorations.test.ts`) is what
        // goes red if either stops holding.
        return true;
      } else if (HIDDEN_MARKER_NODES.has(name)) {
        const parent = enclosingConstruct(node);
        if (parent.name === "FencedCode" && !completeFencedCode(parent)) return;
        push(output, visibleRanges, {
          from,
          to,
          kind: constructActive ? "mark" : "replace",
          className: constructActive ? "nn-lp-marker-active" : "nn-lp-marker",
        });
      }
      },
    });
  }

  return output;
}

export function safeCollectMarkdownPreview(
  state: EditorState,
  visibleRanges?: readonly VisibleRange[],
  collect: typeof collectMarkdownPreview = collectMarkdownPreview,
): { decorations: PreviewDecoration[]; error: string | null } {
  try {
    return { decorations: collect(state, visibleRanges), error: null };
  } catch (error) {
    // The banner reads the same for every cause, so the cause only survives if
    // it is logged: a `RangeError` off a decoration boundary and an
    // out-of-memory are one message to the user and two different bugs.
    console.error("markdown live preview failed:", error);
    return {
      decorations: [],
      error: "Live preview is temporarily unavailable. Your source is unchanged.",
    };
  }
}

export function openResolvedMarkdownLinkAtCaret(
  resolveLink: (href: string) => string | null,
  onOpenLink: (relPath: string) => void,
): (view: EditorView) => boolean {
  return (view) => {
    const caret = view.state.selection.main.head;
    let node = syntaxTree(view.state).resolveInner(caret, -1);
    while (node.parent && node.name !== "Link") node = node.parent;
    if (node.name !== "Link") return false;
    const url = node.getChild("URL");
    if (!url) return false;
    const target = resolveLink(view.state.sliceDoc(url.from, url.to));
    if (!target) return false;
    onOpenLink(target);
    view.dispatch({ effects: EditorView.announce.of(`Opening ${target}`) });
    return true;
  };
}
