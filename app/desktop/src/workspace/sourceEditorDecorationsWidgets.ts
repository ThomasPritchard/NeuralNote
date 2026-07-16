import { EditorView, WidgetType } from "@codemirror/view";

import type { PreviewDecoration } from "./sourceEditorDecorationsTypes";

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
