import { syntaxTree } from "@codemirror/language";
import { StateEffect, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

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

function insideVisibleRanges(from: number, to: number, ranges: readonly VisibleRange[]): boolean {
  return ranges.some((range) => from >= range.from && to <= range.to);
}

function active(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) =>
    range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from,
  );
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

export function collectMarkdownPreview(
  state: EditorState,
  visibleRanges: readonly VisibleRange[] = [{ from: 0, to: state.doc.length }],
): PreviewDecoration[] {
  const output: PreviewDecoration[] = [];

  syntaxTree(state).iterate({
    from: Math.min(...visibleRanges.map((range) => range.from)),
    to: Math.max(...visibleRanges.map((range) => range.to)),
    enter(ref) {
      const { node, name, from, to } = ref;
      const construct = enclosingConstruct(node);
      const constructActive = active(state, construct.from, construct.to);

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
        push(output, visibleRanges, { from, to, kind: "mark", className: "nn-lp-table" });
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
  const ranges = result.decorations.map((item) => {
    switch (item.kind) {
      case "line":
        return Decoration.line({ class: item.className }).range(item.from);
      case "replace":
        return Decoration.replace({}).range(item.from, item.to);
      case "widget":
        return Decoration.replace({
          widget: item.checked === undefined
            ? new TextWidget(item.label ?? "", item.className)
            : new TaskWidget(item),
          inclusive: false,
        }).range(item.from, item.to);
      case "mark":
        {
          const target = item.href ? options.resolveLink?.(item.href) : null;
          const headingLevel = /^nn-lp-heading-([1-6])$/.exec(item.className)?.[1];
          const attributes: Record<string, string> = {};
          if (headingLevel) {
            attributes.role = "heading";
            attributes["aria-level"] = headingLevel;
          }
          if (target) {
            attributes["data-nn-markdown-target"] = target;
            attributes.title = `Command/Control-click to open ${target}`;
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

export function sourceEditorDecorations(
  onError: (message: string | null) => void,
  options: SourceEditorDecorationOptions = {},
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = toDecorationSet(view, onError, options);
      }

      update(update: ViewUpdate): void {
        const linksChanged = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshSourceEditorDecorations))
        );
        if (update.docChanged || update.viewportChanged || update.selectionSet || linksChanged) {
          this.decorations = toDecorationSet(update.view, onError, options);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event) {
          if (!event.metaKey && !event.ctrlKey) return false;
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
}
