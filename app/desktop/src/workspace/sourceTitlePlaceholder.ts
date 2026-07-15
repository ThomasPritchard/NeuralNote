import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

import { sourceTitleInsertion, sourceTitleMode } from "./sourceDocumentTitle";

const TITLE_SCAN_LIMIT = 65_536;

export const refreshSourceTitlePlaceholder = StateEffect.define<null>();

function leadingSource(state: EditorState): string {
  return state.sliceDoc(0, Math.min(state.doc.length, TITLE_SCAN_LIMIT));
}

function activateTitle(
  view: EditorView,
  insertion: NonNullable<ReturnType<typeof sourceTitleInsertion>>,
): boolean {
  view.dispatch({
    changes: { from: insertion.from, insert: insertion.insert },
    selection: { anchor: insertion.caret },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

class SourceTitleWidget extends WidgetType {
  constructor(
    private readonly title: string,
    private readonly insertion: NonNullable<ReturnType<typeof sourceTitleInsertion>>,
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const heading = document.createElement("h1");
    heading.className = "nn-source-title-placeholder-heading";
    const element = document.createElement("button");
    element.type = "button";
    element.className = "nn-source-title-placeholder";
    element.setAttribute("aria-label", `Edit title: ${this.title}`);
    element.append(document.createTextNode(this.title));
    element.addEventListener("click", () => activateTitle(view, this.insertion));
    heading.append(element);
    return heading;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function build(state: EditorState, title: string | undefined): DecorationSet {
  if (!title || sourceTitleMode(leadingSource(state)) !== "placeholder") {
    return Decoration.none;
  }
  const insertion = sourceTitleInsertion(leadingSource(state), title, {
    documentLength: state.doc.length,
  });
  if (insertion === null) return Decoration.none;
  const lineStart = state.doc.lineAt(Math.min(insertion.from, state.doc.length)).from;
  const position = insertion.from === state.doc.length || lineStart === insertion.from
    ? insertion.from
    : 0;
  return Decoration.set([
    Decoration.widget({
      widget: new SourceTitleWidget(title, insertion),
      block: true,
      side: -1,
    }).range(position),
  ]);
}

export function sourceTitlePlaceholder(title: () => string | undefined): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => build(state, title()),
    update(decorations, transaction) {
      const titleChanged = transaction.effects.some((effect) =>
        effect.is(refreshSourceTitlePlaceholder)
      );
      return transaction.docChanged || titleChanged
        ? build(transaction.state, title())
        : decorations;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
