import { EditorView, WidgetType } from "@codemirror/view";

import type { PreviewDecoration } from "./sourceEditorDecorationsTypes";
import { tableModelAt, type TablePadFill } from "./sourceEditorTableModel";

/**
 * Visual column padding for a table the caret is inside. It is an insertion
 * widget with no document range, so the source keeps its exact bytes: opening a
 * table never marks the note dirty.
 */
export class TablePadWidget extends WidgetType {
  constructor(
    private readonly width: number,
    private readonly fill: TablePadFill,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TablePadWidget
      && other.width === this.width
      && other.fill === this.fill;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = this.fill === "dash"
      ? "nn-lp-table-pad nn-lp-table-pad-dash"
      : "nn-lp-table-pad";
    element.setAttribute("aria-hidden", "true");
    element.append(
      document.createTextNode((this.fill === "dash" ? "-" : " ").repeat(this.width)),
    );
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
