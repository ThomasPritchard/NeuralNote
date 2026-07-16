import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { sourceFrontmatterRange } from "./sourceFrontmatterPreview";
import {
  insideVisibleRanges,
  intersectsVisibleRanges,
  mergeVisibleRanges,
} from "./sourceEditorDecorationsRanges";
import type { PreviewDecoration, PreviewTable, VisibleRange } from "./sourceEditorDecorationsTypes";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

const CONSTRUCT_NAMES = new Set([
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

const MARKER_NAMES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
]);

const MAX_TABLE_PREVIEW_CHARS = 32_768;
const MAX_TABLE_PREVIEW_ROWS = 200;

function active(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) =>
    range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from,
  );
}

export function activeLink(state: EditorState, from: number, to: number): boolean {
  return active(state, from, to) || state.selection.ranges.some((range) =>
    range.empty && range.head === to,
  );
}

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

const HIDDEN_TABLE_INLINE_NODES = new Set([
  "CodeMark",
  "EmphasisMark",
  "LinkMark",
  "StrikethroughMark",
]);

function renderedInlineText(state: EditorState, node: SyntaxNode): string {
  if (HIDDEN_TABLE_INLINE_NODES.has(node.name)) return "";
  if (node.name === "URL" && (node.parent?.name === "Link" || node.parent?.name === "Image")) {
    return "";
  }
  if (!node.firstChild) return state.sliceDoc(node.from, node.to);

  let text = "";
  let position = node.from;
  let child: SyntaxNode | null = node.firstChild;
  while (child) {
    if (child.from > position) text += state.sliceDoc(position, child.from);
    text += renderedInlineText(state, child);
    position = child.to;
    child = child.nextSibling;
  }
  if (position < node.to) text += state.sliceDoc(position, node.to);
  return text;
}

function tableCells(state: EditorState, row: SyntaxNode): string[] {
  const cells: string[] = [];
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableCell") cells.push(renderedInlineText(state, child).trim());
  }
  return cells;
}

function tablePreview(state: EditorState, table: SyntaxNode): PreviewTable | null {
  const header = table.getChild("TableHeader");
  if (!header) return null;
  const headers = tableCells(state, header);
  if (headers.length === 0) return null;
  const rows: string[][] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableRow") {
      if (rows.length >= MAX_TABLE_PREVIEW_ROWS) return null;
      rows.push(tableCells(state, child));
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
          : active(state, construct.from, construct.to)
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
        push(output, visibleRanges, active(state, from, to)
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
        const source = state.sliceDoc(from, to);
        const label = /^!\[([^\]]*)\]/.exec(source)?.[1] || "image";
        push(output, visibleRanges, {
          from,
          to,
          kind: "widget",
          className: "nn-lp-image",
          label: `Image: ${label}`,
        });
      } else if (name === "Table") {
        if (intersectsVisibleRanges(from, to, visibleRanges)) {
          const table = to - from <= MAX_TABLE_PREVIEW_CHARS ? tablePreview(state, node) : null;
          output.push(table && !active(state, from, to)
            ? { from, to, kind: "widget", className: "nn-lp-table", table }
            : { from, to, kind: "mark", className: "nn-lp-table-source" });
        }
        return false;
      } else if (MARKER_NAMES.has(name)) {
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
  } catch {
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
