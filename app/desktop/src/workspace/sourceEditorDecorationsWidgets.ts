import { EditorView, WidgetType } from "@codemirror/view";

import type { PreviewDecoration } from "./sourceEditorDecorationsTypes";
import { tableModelAt, type TableDelimiterKind } from "./sourceEditorTableModel";

/**
 * Drawn chrome in place of a hidden cell delimiter. The source keeps its pipes;
 * this only changes what is painted, so copy, cut and save still yield exactly
 * the Markdown on disk.
 */
export class TableChromeWidget extends WidgetType {
  constructor(
    private readonly kind: TableDelimiterKind,
    private readonly padColumns: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TableChromeWidget
      && other.kind === this.kind
      && other.padColumns === this.padColumns;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = `nn-lp-cell-chrome nn-lp-cell-chrome-${this.kind}`;
    element.setAttribute("aria-hidden", "true");
    if (this.padColumns > 0) {
      // Column padding lives here rather than in its own widget: a widget at the
      // boundary of a replaced range is never painted.
      element.style.setProperty("--nn-cell-pad", `${this.padColumns}ch`);
    }
    return element;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class TextWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly className: string,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TextWidget
      && other.label === this.label
      && other.className === this.className;
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

export class TaskWidget extends WidgetType {
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

export class TableWidget extends WidgetType {
  constructor(private readonly item: PreviewDecoration) {
    super();
  }

  /**
   * Without this, `WidgetType.eq` defaults to false and the whole table is torn
   * down and rebuilt — every row, cell and event listener — on every doc,
   * selection or viewport change. That is once per keystroke anywhere in the
   * note, however far from the table.
   */
  eq(other: WidgetType): boolean {
    return other instanceof TableWidget
      && other.item.from === this.item.from
      && other.item.to === this.item.to
      && other.item.className === this.item.className
      && tableShapeKey(other.item) === tableShapeKey(this.item);
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
      const anchor = this.caretTarget(view, event.target as Element | null);
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
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

  /**
   * Source offset for the cell the pointer landed on. Without this every
   * activation dropped the caret at the start of the table, so clicking a value
   * in the last row lost your place entirely.
   */
  private caretTarget(view: EditorView, target: Element | null): number {
    const model = tableModelAt(view.state, this.item.from);
    if (!model) return this.item.from;

    const cell = target?.closest("th, td");
    const header = model.rows.find((row) => row.kind === "header");
    if (!cell) return header?.slots[0]?.to ?? this.item.from;

    const isHeader = cell.tagName === "TH";
    const bodyRows = model.rows.filter((row) => row.kind === "body");
    const rowElement = cell.closest("tr");
    const row = isHeader
      ? header
      : bodyRows[rowElement instanceof HTMLTableRowElement ? rowElement.sectionRowIndex : 0];
    if (!row) return this.item.from;

    // DOM cellIndex and model column are DIFFERENT coordinate spaces. The
    // rendered table is built from TableCell nodes, and the parser emits none
    // for an empty cell, so `| x |  | z |` renders two cells against three
    // slots. Index the rendered cells against the slots that carry content, or
    // clicking "z" lands the caret in the empty cell before it.
    const index = cell instanceof HTMLTableCellElement ? cell.cellIndex : 0;
    const rendered = row.slots.filter((slot) => slot.from !== slot.to);
    return rendered[index]?.to ?? row.slots[index]?.to ?? row.from;
  }
}

/** Cheap structural identity: the rendered text, which is all the DOM shows. */
function tableShapeKey(item: PreviewDecoration): string {
  const table = item.table;
  if (!table) return "";
  return [table.headers.join("\u0000"), ...table.rows.map((row) => row.join("\u0000"))]
    .join("\u0001");
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
