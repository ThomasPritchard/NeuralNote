import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import { mergeVisibleRanges } from "./sourceEditorDecorationsRanges";
import { activeLink, safeCollectMarkdownPreview } from "./sourceEditorDecorationsPreview";
import { TableWidget, TaskWidget, TextWidget } from "./sourceEditorDecorationsWidgets";
import type { VisibleRange } from "./sourceEditorDecorationsTypes";

export type {
  PreviewDecoration,
  PreviewDecorationKind,
  PreviewTable,
  VisibleRange,
} from "./sourceEditorDecorationsTypes";
export {
  collectMarkdownPreview,
  openResolvedMarkdownLinkAtCaret,
  safeCollectMarkdownPreview,
} from "./sourceEditorDecorationsPreview";

export const refreshSourceEditorDecorations = StateEffect.define<null>();

const TABLE_SCAN_MARGIN = 2_048;
const INITIAL_TABLE_SCAN_LIMIT = 4_096;
const updateSourceEditorTableViewport = StateEffect.define<readonly VisibleRange[]>();

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
