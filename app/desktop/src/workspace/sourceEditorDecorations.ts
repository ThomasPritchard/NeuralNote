import { syntaxTree } from "@codemirror/language";
import {
  Facet,
  Prec,
  type Range,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import { mergeVisibleRanges } from "./sourceEditorDecorationsRanges";
import { activeLink, safeCollectMarkdownPreview } from "./sourceEditorDecorationsPreview";
import { createPreviewErrorReporter } from "./sourceEditorPreviewErrorReporter";
import type { CellPaintPlan } from "./sourceEditorCellPaintPlan";
import {
  TableCellWidget,
  TableChromeWidget,
  TableWidget,
  TaskWidget,
  TextWidget,
} from "./sourceEditorDecorationsWidgets";
import {
  drawsCellChrome,
  hiddenTableDelimiters,
  tableDelimiterGuard,
} from "./sourceEditorTableDelimiterGuard";
import {
  tableModelAt,
  tableRenderPlan,
  type TableRenderCell,
} from "./sourceEditorTableModel";
import { revealedTableSource } from "./sourceEditorTableReveal";
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

/**
 * Whether a newer syntax tree arrived between these two states.
 *
 * Every decoration in this file is derived from the tree, and the tree arrives
 * LATE. `LanguageState.init` parses only the first `Work.InitViewport` (3,000)
 * characters, and abandons even that slice once `Work.Apply` (20 ms of wall
 * clock) is spent — so a busy machine, or simply a note longer than 3,000
 * characters, opens with a tree that stops short of the content below. CodeMirror
 * finishes the job on an idle callback and announces it with a transaction that
 * changes no document, moves no selection and carries no effect of ours
 * (`@codemirror/language/dist/index.js:540-545, 601-624`).
 *
 * Without this the cached decorations outlive the tree they were derived from:
 * a table past the first slice stays raw pipes, and every heading, emphasis and
 * wikilink below it stays literal, until the user happens to type.
 */
function reparsed(before: EditorState, after: EditorState): boolean {
  return syntaxTree(before) !== syntaxTree(after);
}

const TABLE_SCAN_MARGIN = 2_048;
const INITIAL_TABLE_SCAN_LIMIT = 4_096;
const updateSourceEditorTableViewport = StateEffect.define<readonly VisibleRange[]>();

interface SourceEditorDecorationOptions {
  readonly resolveLink?: (href: string) => string | null;
  readonly onOpenLink?: (relPath: string) => void;
}

function toDecorationSet(
  view: EditorView,
  reportInlineError: (message: string | null) => void,
  options: SourceEditorDecorationOptions,
): DecorationSet {
  const result = safeCollectMarkdownPreview(view.state, view.visibleRanges);
  reportInlineError(result.error);
  // A table is the `StateField`'s to decorate, in both of its states: as drawn
  // cells, or — when it is too large to draw — as the literal source backdrop.
  // Emitting a table-wide mark from here as well would wrap every row line's
  // children in one element, and a grid has exactly one item to place after that.
  const ranges = result.decorations.filter((item) => !item.table && !item.tableSource).map((item) => {
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

/**
 * Where a table-decoration failure is reported. A `StateField` cannot see the
 * extension's callbacks, so the sink is supplied through the state itself.
 */
export const tablePreviewErrorSink = Facet.define<(message: string | null) => void>();

const TABLE_DECORATION_ERROR =
  "Table preview is temporarily unavailable. Your source is unchanged.";

/**
 * CT-4's measurement probe, as a facet so the `StateField` can reach it — a
 * field is defined once at module scope and never sees an extension's closure.
 *
 * The probe is P3a's; this is the seam it lands in. Until one is registered,
 * every column measures `null`, which CT-4 defines as "not primed yet" and the
 * render plan answers with character-width tracks rather than an error.
 */
export const tableCellMetrics = Facet.define<(plan: CellPaintPlan) => number | null>();

/**
 * Re-derive every drawn table's tracks from measurements taken afresh.
 *
 * The widths a track was stamped from belong to a style generation
 * (`sourceEditorTextMetrics.ts`'s epoch), and that generation moves when a
 * webfont settles or the typography changes — neither of which is a document
 * change, a selection change or a viewport change, so nothing above would
 * otherwise ask this field for a new answer. A webfont landing after first paint
 * would leave every column sized against the fallback face until the next
 * keystroke.
 *
 * It carries no changes. `sourceEditorTableMeasurement.ts` is what dispatches it.
 */
export const refreshSourceEditorTableMetrics = StateEffect.define<null>();

/**
 * The two decoration sets a table produces, kept apart because they need
 * opposite precedence.
 *
 * `structure` holds the block widget, the row lines and the drawn chrome, and
 * runs at ordinary precedence. `cells` holds the per-cell marks and runs BELOW
 * the preview plugins (`Prec.low`), because the lowest-precedence mark is the
 * OUTERMOST element: promote it and every inner mark boundary splits the cell
 * into a second element, which the grid then places as a second item in the
 * column (`@codemirror/view/dist/index.js:242-248`).
 */
interface TableDecorations {
  readonly structure: DecorationSet;
  readonly cells: DecorationSet;
}

/** The same two sets before they are sorted into range sets. */
interface TableDecorationRanges {
  readonly structure: readonly Range<Decoration>[];
  readonly cells: readonly Range<Decoration>[];
}

const NO_TABLE_DECORATIONS: TableDecorations = {
  structure: Decoration.none,
  cells: Decoration.none,
};

function tableDecorationSet(
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
): TableDecorations {
  if (visibleRanges.length === 0) return NO_TABLE_DECORATIONS;
  try {
    const scanRanges = mergeVisibleRanges(visibleRanges, state.doc.length, TABLE_SCAN_MARGIN);
    const result = safeCollectMarkdownPreview(state, scanRanges);
    const structure: Range<Decoration>[] = [];
    const cells: Range<Decoration>[] = [];
    for (const item of result.decorations) {
      if (item.table) {
        structure.push(Decoration.replace({
          widget: new TableWidget(item),
          inclusive: false,
          block: true,
        }).range(item.from, item.to));
      } else if (item.tableSource) {
        const drawn = tableRanges(state, item);
        structure.push(...drawn.structure);
        cells.push(...drawn.cells);
      }
    }
    reportTableError(state, result.error);
    return {
      structure: Decoration.set(structure, true),
      cells: Decoration.set(cells, true),
    };
  } catch (error) {
    // Spec rule 6: a decoration failure removes the decoration and leaves the
    // source editable. Without this the throw escapes through `state.update()`,
    // which CodeMirror evaluates as an ARGUMENT to `dispatchTransactions` — so
    // the editor's own try/catch never sees it, the keystroke is lost, and from
    // `StateField.create` the editor fails to mount at all.
    //
    // The banner says the same thing for every cause, so the cause itself only
    // survives if it is logged here: a `RangeError` off a decoration boundary
    // and an out-of-memory are one message to the user and two different bugs.
    console.error("table decoration failed:", error);
    reportTableError(state, TABLE_DECORATION_ERROR);
    return NO_TABLE_DECORATIONS;
  }
}

/**
 * Deferred so a report never re-enters React from inside a transaction, which
 * is the same hazard the viewport plugin's `queueMicrotask` guards against.
 */
function reportTableError(state: EditorState, message: string | null): void {
  const sinks = state.facet(tablePreviewErrorSink);
  if (sinks.length === 0) return;
  queueMicrotask(() => {
    for (const sink of sinks) sink(message);
  });
}

/**
 * Draw one table as a grid of cells: a `Decoration.line` per row carrying the
 * track list, drawn chrome over every hidden delimiter, and a per-cell mark at
 * an explicit column.
 *
 * Nothing here can change a byte. The chrome replaces source that stays in the
 * document, and an empty cell is a zero-length insertion of DOM, not of text.
 *
 * A table too large to draw keeps its pipes and gets the source backdrop
 * instead. `drawsCellChrome` owns that bound for the atomic ranges and the
 * transaction filter too: painting a delimiter the filter does not protect
 * reopens the corruption path, and protecting one the user can plainly see
 * refuses a legitimate edit.
 */
function tableRanges(state: EditorState, table: VisibleRange): TableDecorationRanges {
  const model = tableModelAt(state, table.from);
  if (!model || !drawsCellChrome(state, model)) {
    return {
      structure: [],
      cells: [Decoration.mark({ class: "nn-lp-table-source" }).range(table.from, table.to)],
    };
  }

  const plan = tableRenderPlan(state, model, { measureCell: state.facet(tableCellMetrics)[0] });
  const tracks = { style: `--nn-table-tracks: ${plan.trackTemplate}` };
  return {
    structure: plan.rows.flatMap((row) => [
      Decoration.line({ class: row.className, attributes: tracks }).range(row.lineFrom),
      ...row.chrome.map((chrome) => Decoration.replace({
        widget: new TableChromeWidget(chrome.kind, chrome.gridColumn),
        inclusive: false,
      }).range(chrome.from, chrome.to)),
    ]),
    cells: plan.rows.flatMap((row) => row.cells.map(cellRange)),
  };
}

/**
 * One cell, as the only decoration that can carry its content.
 *
 * The mark is INCLUSIVE, which is load-bearing rather than a default. A
 * non-inclusive mark opens at `startSide` 5e8 while a non-inclusive replace
 * opens at 5e8-1 (`@codemirror/view/dist/index.js:268-278`), so a replacement
 * covering the cell — every `[[wikilink]]` that fills one — sorts BEFORE the
 * mark opens: measured, the cell element is then never built at all and the
 * widget becomes an unplaced item in a column of its own. That is the same
 * boundary-sorting bug this phase removes at table scale, one level down.
 */
function cellRange(cell: TableRenderCell): Range<Decoration> {
  const attributes = { style: `grid-column: ${cell.column}` };
  if (cell.kind === "content") {
    return Decoration.mark({ class: "nn-lp-cell", inclusive: true, attributes })
      .range(cell.from, cell.to);
  }
  // `side: 1` puts the widget after an inclusive cell mark closing at the same
  // offset — which is exactly where a filler sits — and before the trailing
  // chrome, so the closing edge stays the row's last stamped child.
  return Decoration.widget({
    widget: new TableCellWidget(cell.kind, String(cell.column)),
    side: 1,
  }).range(cell.from);
}

/**
 * The hidden delimiters of every table in `visibleRanges`, as atomic ranges.
 *
 * `EditorView.atomicRanges` is a facet of `(view) => RangeSet`, so the ranges
 * have to be derived from the viewport rather than from the caret: an
 * `EditorState` has no viewport, and keying on `state.selection.main.head` left
 * every other table on screen unprotected.
 *
 * It refuses nothing. For a non-empty range `deleteBy` runs
 * `from = skipAtomic(from, false); to = skipAtomic(to, true)`
 * (`@codemirror/commands/dist/index.js:1173-1180`), which EXPANDS a deletion to
 * the atomic boundaries rather than declining it — so what stops a cross-cell
 * edit is `tableDelimiterGuard`, not this.
 */
export function tableAtomicRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
): DecorationSet {
  if (visibleRanges.length === 0) return Decoration.none;
  const scanRanges = mergeVisibleRanges(visibleRanges, state.doc.length, TABLE_SCAN_MARGIN);
  return Decoration.set(
    hiddenTableDelimiters(state, scanRanges).flatMap((table) =>
      table.delimiters.map((delimiter) =>
        Decoration.replace({}).range(delimiter.from, delimiter.to))),
    true,
  );
}

interface TableDecorationState extends TableDecorations {
  readonly visibleRanges: readonly VisibleRange[];
}

const sourceEditorTableDecorations = StateField.define<TableDecorationState>({
  create(state) {
    const visibleRanges = [{ from: 0, to: Math.min(state.doc.length, INITIAL_TABLE_SCAN_LIMIT) }];
    return { ...tableDecorationSet(state, visibleRanges), visibleRanges };
  },
  update(value, transaction) {
    const viewport = transaction.effects.find((effect) => effect.is(updateSourceEditorTableViewport));
    const remeasure = transaction.effects.some((effect) =>
      effect.is(refreshSourceEditorTableMetrics));
    let visibleRanges = viewport?.value ?? value.visibleRanges;
    if (transaction.docChanged && !viewport) {
      visibleRanges = visibleRanges.map(({ from, to }) => ({
        from: transaction.changes.mapPos(from, -1),
        to: transaction.changes.mapPos(to, 1),
      }));
    }
    if (
      !transaction.docChanged
      && !transaction.selection
      && !viewport
      && !remeasure
      && !reparsed(transaction.startState, transaction.state)
    ) return value;
    return { ...tableDecorationSet(transaction.state, visibleRanges), visibleRanges };
  },
  // Two providers over ONE field, at two precedences. A block decoration may not
  // come from a plugin (`@codemirror/view/dist/index.js:2743`), so demoting the
  // whole field is not available: the cells are demoted, the block widget is not.
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.structure),
    Prec.low(EditorView.decorations.from(field, (value) => value.cells)),
  ],
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

/** The note a rendered Markdown link under `event` resolves to, if any. */
function markdownTargetAt(event: Event): string | undefined {
  return (event.target as Element | null)
    ?.closest<HTMLElement>("[data-nn-markdown-target]")
    ?.dataset.nnMarkdownTarget;
}

export function sourceEditorDecorations(
  onError: (message: string | null) => void,
  options: SourceEditorDecorationOptions = {},
): Extension {
  const report = createPreviewErrorReporter(onError);
  const reportInline = (message: string | null): void => { report("inline", message); };
  const openTargetAt = (event: Event): boolean => {
    const target = markdownTargetAt(event);
    if (!target) return false;
    event.preventDefault();
    options.onOpenLink?.(target);
    return true;
  };
  const keyboardLinkHandler = Prec.highest(EditorView.domEventHandlers({
    keydown(event) {
      if (
        event.key !== "Enter"
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
      ) return false;
      return openTargetAt(event);
    },
  }));
  const previewPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = toDecorationSet(view, reportInline, options);
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
          || reparsed(update.startState, update.state)
        ) {
          this.decorations = toDecorationSet(update.view, reportInline, options);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event) {
          return event.button === 0 && openTargetAt(event);
        },
        click(event) {
          return event.detail === 0 && openTargetAt(event);
        },
      },
    },
  );
  return [
    tablePreviewErrorSink.of((message) => { report("table", message); }),
    sourceEditorTableDecorations,
    sourceEditorTableViewport,
    // Integrity travels with the decorations that create the hazard: this array
    // is already consumed at `SourceNoteEditor.tsx:139`, and `EditorView.announce`
    // is rendered by CodeMirror, so neither needs anything of the component.
    // Registered with the guard that reads it: `drawsCellChrome` asks this
    // field whether a table is showing its literal source, and a table the user
    // can see whole must not have its delimiters painted over, made atomic, or
    // protected against editing.
    revealedTableSource,
    tableDelimiterGuard,
    EditorView.atomicRanges.of((view) => tableAtomicRanges(view.state, view.visibleRanges)),
    keyboardLinkHandler,
    previewPlugin,
  ];
}
