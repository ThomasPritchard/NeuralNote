import { syntaxTree } from "@codemirror/language";
import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { sourceFrontmatterRange } from "./sourceFrontmatterPreview";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

export type PreviewDecorationKind = "mark" | "replace" | "line" | "widget";

export interface PreviewDecoration {
  readonly from: number;
  readonly to: number;
  readonly kind: PreviewDecorationKind;
  readonly className: string;
  readonly label?: string;
  readonly checked?: boolean;
  readonly href?: string;
  readonly table?: PreviewTable;
}

export interface PreviewTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface VisibleRange {
  readonly from: number;
  readonly to: number;
}

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

export const refreshSourceEditorDecorations = StateEffect.define<null>();

const TABLE_SCAN_MARGIN = 2_048;
const INITIAL_TABLE_SCAN_LIMIT = 4_096;
const MAX_TABLE_PREVIEW_CHARS = 32_768;
const MAX_TABLE_PREVIEW_ROWS = 200;
const updateSourceEditorTableViewport = StateEffect.define<readonly VisibleRange[]>();

function mergeVisibleRanges(
  ranges: readonly VisibleRange[],
  docLength: number,
  margin = 0,
): VisibleRange[] {
  const ordered = ranges
    .map(({ from, to }) => ({
      from: Math.max(0, Math.min(docLength, from - margin)),
      to: Math.max(0, Math.min(docLength, to + margin)),
    }))
    .filter((range) => range.from <= range.to)
    .sort((left, right) => left.from - right.from);
  const merged: VisibleRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: Math.max(previous.to, range.to) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function insideVisibleRanges(from: number, to: number, ranges: readonly VisibleRange[]): boolean {
  return ranges.some((range) => from >= range.from && to <= range.to);
}

function intersectsVisibleRanges(from: number, to: number, ranges: readonly VisibleRange[]): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function active(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) =>
    range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from,
  );
}

function activeLink(state: EditorState, from: number, to: number): boolean {
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

class TextWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly className: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = this.className;
    element.append(document.createTextNode(this.label));
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class TaskWidget extends WidgetType {
  constructor(private readonly item: PreviewDecoration) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TaskWidget
      && other.item.from === this.item.from
      && other.item.to === this.item.to
      && other.item.className === this.item.className
      && other.item.label === this.item.label
      && other.item.checked === this.item.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = this.item.className;
    element.dataset.nnTaskFrom = String(this.item.from);
    element.setAttribute("role", "checkbox");
    element.setAttribute("aria-checked", String(Boolean(this.item.checked)));
    element.setAttribute("aria-label", this.item.label ?? "Toggle task");
    element.append(document.createTextNode(this.item.checked ? "✓" : ""));
    element.addEventListener("click", (event) => toggleTask(event, view));
    element.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") toggleTask(event, view);
    });
    return element;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class TableWidget extends WidgetType {
  constructor(private readonly item: PreviewDecoration) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "nn-lp-table-widget";
    const table = document.createElement("table");
    table.className = this.item.className;
    table.tabIndex = 0;
    table.setAttribute("aria-label", "Markdown table");
    table.title = "Click or press Enter to edit the Markdown source";

    const head = table.createTHead();
    const headerRow = head.insertRow();
    for (const label of this.item.table?.headers ?? []) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.append(document.createTextNode(label));
      headerRow.append(cell);
    }

    const body = table.createTBody();
    for (const values of this.item.table?.rows ?? []) {
      const row = body.insertRow();
      for (const value of values) {
        const cell = row.insertCell();
        cell.append(document.createTextNode(value));
      }
    }

    const activate = (event: Event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.item.from }, scrollIntoView: true });
      view.focus();
    };
    table.addEventListener("click", activate);
    table.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    });
    wrapper.append(table);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function toggleTask(event: Event, view: EditorView): boolean {
  const element = (event.target as Element | null)?.closest<HTMLElement>("[data-nn-task-from]");
  if (!element) return false;
  const from = Number(element.dataset.nnTaskFrom);
  if (!Number.isSafeInteger(from)) return false;
  event.preventDefault();
  const checked = /[xX]/.test(view.state.sliceDoc(from, from + 3));
  view.dispatch({
    changes: { from: from + 1, to: from + 2, insert: checked ? " " : "x" },
    selection: { anchor: from + 3 },
  });
  view.focus();
  return true;
}

interface SourceEditorDecorationOptions {
  readonly resolveLink?: (href: string) => string | null;
  readonly onOpenLink?: (relPath: string) => void;
}

function toDecorationSet(
  view: EditorView,
  onError: (message: string | null) => void,
  options: SourceEditorDecorationOptions,
): DecorationSet {
  const result = safeCollectMarkdownPreview(view.state, view.visibleRanges);
  onError(result.error);
  const ranges = result.decorations.filter((item) => !item.table).map((item) => {
    switch (item.kind) {
      case "line":
        return Decoration.line({ class: item.className }).range(item.from);
      case "replace":
        return Decoration.replace({}).range(item.from, item.to);
      case "widget":
        return Decoration.replace({
          widget: item.table
            ? new TableWidget(item)
            : item.checked === undefined
              ? new TextWidget(item.label ?? "", item.className)
              : new TaskWidget(item),
          inclusive: false,
        }).range(item.from, item.to);
      case "mark":
        {
          const linkActive = view.hasFocus && activeLink(view.state, item.from, item.to);
          const target = item.href && !linkActive ? options.resolveLink?.(item.href) : null;
          const headingLevel = /^nn-lp-heading-([1-6])$/.exec(item.className)?.[1];
          const attributes: Record<string, string> = {};
          if (headingLevel) {
            attributes.role = "heading";
            attributes["aria-level"] = headingLevel;
          }
          if (target) {
            attributes["data-nn-markdown-target"] = target;
            attributes.title = `Open ${target}`;
            attributes.role = "link";
            attributes.tabindex = "0";
            attributes["aria-keyshortcuts"] = "Enter";
          }
          return Decoration.mark({
            class: item.className,
            attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
          }).range(item.from, item.to);
        }
    }
  });
  return Decoration.set(ranges, true);
}

function tableDecorationSet(
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
): DecorationSet {
  if (visibleRanges.length === 0) return Decoration.none;
  const scanRanges = mergeVisibleRanges(visibleRanges, state.doc.length, TABLE_SCAN_MARGIN);
  const result = safeCollectMarkdownPreview(state, scanRanges);
  const ranges = result.decorations.flatMap((item) => item.table
    ? [Decoration.replace({
        widget: new TableWidget(item),
        inclusive: false,
        block: true,
      }).range(item.from, item.to)]
    : []);
  return Decoration.set(ranges, true);
}

interface TableDecorationState {
  readonly decorations: DecorationSet;
  readonly visibleRanges: readonly VisibleRange[];
}

const sourceEditorTableDecorations = StateField.define<TableDecorationState>({
  create(state) {
    const visibleRanges = [{ from: 0, to: Math.min(state.doc.length, INITIAL_TABLE_SCAN_LIMIT) }];
    return { decorations: tableDecorationSet(state, visibleRanges), visibleRanges };
  },
  update(value, transaction) {
    const viewport = transaction.effects.find((effect) => effect.is(updateSourceEditorTableViewport));
    let visibleRanges = viewport?.value ?? value.visibleRanges;
    if (transaction.docChanged && !viewport) {
      visibleRanges = visibleRanges.map(({ from, to }) => ({
        from: transaction.changes.mapPos(from, -1),
        to: transaction.changes.mapPos(to, 1),
      }));
    }
    if (!transaction.docChanged && !transaction.selection && !viewport) return value;
    return {
      visibleRanges,
      decorations: tableDecorationSet(transaction.state, visibleRanges),
    };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const sourceEditorTableViewport = ViewPlugin.fromClass(class {
  private rangeKey = "";

  constructor(view: EditorView) {
    this.schedule(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      this.schedule(update.view);
    }
  }

  private schedule(view: EditorView): void {
    view.requestMeasure({
      key: this,
      read: (measuredView) => mergeVisibleRanges(
        measuredView.visibleRanges,
        measuredView.state.doc.length,
      ),
      write: (ranges, measuredView) => {
        const key = ranges.map(({ from, to }) => `${from}:${to}`).join(",");
        if (key === this.rangeKey) return;
        this.rangeKey = key;
        // A measurement write runs inside CodeMirror's update cycle. Defer the
        // viewport effect so a sidebar resize cannot cause a nested update.
        queueMicrotask(() => {
          if (!measuredView.dom.isConnected) return;
          measuredView.dispatch({ effects: updateSourceEditorTableViewport.of(ranges) });
        });
      },
    });
  }
});

export function sourceEditorDecorations(
  onError: (message: string | null) => void,
  options: SourceEditorDecorationOptions = {},
): Extension {
  const keyboardLinkHandler = Prec.highest(EditorView.domEventHandlers({
    keydown(event) {
      if (
        event.key !== "Enter"
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
      ) return false;
      const element = (event.target as Element | null)?.closest<HTMLElement>(
        "[data-nn-markdown-target]",
      );
      const target = element?.dataset.nnMarkdownTarget;
      if (!target) return false;
      event.preventDefault();
      options.onOpenLink?.(target);
      return true;
    },
  }));
  const previewPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = toDecorationSet(view, onError, options);
      }

      update(update: ViewUpdate): void {
        const linksChanged = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshSourceEditorDecorations))
        );
        if (
          update.docChanged
          || update.viewportChanged
          || update.selectionSet
          || update.focusChanged
          || linksChanged
        ) {
          this.decorations = toDecorationSet(update.view, onError, options);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event) {
          if (event.button !== 0) return false;
          const element = (event.target as Element | null)?.closest<HTMLElement>(
            "[data-nn-markdown-target]",
          );
          const target = element?.dataset.nnMarkdownTarget;
          if (!target) return false;
          event.preventDefault();
          options.onOpenLink?.(target);
          return true;
        },
        click(event) {
          if (event.detail !== 0) return false;
          const element = (event.target as Element | null)?.closest<HTMLElement>(
            "[data-nn-markdown-target]",
          );
          const target = element?.dataset.nnMarkdownTarget;
          if (!target) return false;
          event.preventDefault();
          options.onOpenLink?.(target);
          return true;
        },
      },
    },
  );
  return [
    sourceEditorTableDecorations,
    sourceEditorTableViewport,
    keyboardLinkHandler,
    previewPlugin,
  ];
}
