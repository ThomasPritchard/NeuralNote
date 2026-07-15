import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

import { createFrontmatterPropertiesDom } from "./FrontmatterProperties";

const FRONTMATTER_SCAN_LIMIT = 65_536;
type SearchTag = (tag: string) => void;

export interface FrontmatterRange {
  readonly from: number;
  readonly to: number;
  readonly propertiesAt: number;
}

const revealSourceFrontmatter = StateEffect.define<FrontmatterRange>();
const finishSourceFrontmatter = StateEffect.define<null>();
export const refreshSourceFrontmatterPreview = StateEffect.define<null>();

export function sourceFrontmatterRange(state: EditorState): FrontmatterRange | null {
  const bomOffset = state.doc.sliceString(0, 1) === "\uFEFF" ? 1 : 0;
  const first = state.doc.lineAt(bomOffset);
  if (state.sliceDoc(bomOffset, first.to) !== "---") return null;

  const maxPosition = Math.min(state.doc.length, FRONTMATTER_SCAN_LIMIT);
  let lineNumber = first.number + 1;
  while (lineNumber <= state.doc.lines) {
    const line = state.doc.line(lineNumber);
    if (line.from > maxPosition) return null;
    if (state.sliceDoc(line.from, line.to) === "---" || state.sliceDoc(line.from, line.to) === "...") {
      const to = line.to < state.doc.length ? line.to + 1 : line.to;
      return { from: 0, to, propertiesAt: propertiesPosition(state, to) };
    }
    lineNumber += 1;
  }
  return null;
}

export function sourceFrontmatterRaw(state: EditorState): string | null {
  const range = sourceFrontmatterRange(state);
  if (!range) return null;
  const source = state.sliceDoc(range.from, range.to).replace(/^\uFEFF/u, "");
  const lines = source.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 2) return null;
  lines.shift();
  lines.pop();
  return lines.join("\n");
}

function propertiesPosition(state: EditorState, bodyStart: number): number {
  let line = state.doc.lineAt(Math.min(bodyStart, state.doc.length));
  while (line.number <= state.doc.lines && state.sliceDoc(line.from, line.to).trim() === "") {
    if (line.number === state.doc.lines) return bodyStart;
    line = state.doc.line(line.number + 1);
  }

  const text = state.sliceDoc(line.from, line.to);
  if (/^ {0,3}#(?:[ \t]+|$)/.test(text)) return line.to;
  if (line.number < state.doc.lines) {
    const underline = state.doc.line(line.number + 1);
    if (/^ {0,3}=+[ \t]*$/.test(state.sliceDoc(underline.from, underline.to))) {
      return underline.to;
    }
  }
  return bodyStart;
}

class FrontmatterWidget extends WidgetType {
  constructor(
    private readonly frontmatter: Record<string, unknown>,
    private readonly range: FrontmatterRange,
    private readonly onSearchTag: () => SearchTag | undefined,
    private readonly stale: boolean,
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const section = document.createElement("section");
    section.className = "nn-source-properties";
    if (this.stale) {
      const status = document.createElement("p");
      status.className = "nn-source-properties-status";
      status.setAttribute("role", "status");
      status.append(document.createTextNode(
        "Properties changed. Save the note to refresh this preview.",
      ));
      section.append(status);
    } else if (Object.keys(this.frontmatter).length > 0) {
      section.append(createFrontmatterPropertiesDom(
        document,
        this.frontmatter,
        this.onSearchTag(),
      ));
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nn-source-properties-edit";
    button.setAttribute("aria-label", "Edit note properties");
    button.append(document.createTextNode("Edit YAML"));
    const activate = (event: Event) => {
      event.preventDefault();
      view.dispatch({
        effects: revealSourceFrontmatter.of(this.range),
        selection: { anchor: Math.min(this.range.from + 4, this.range.to) },
        scrollIntoView: true,
      });
      view.focus();
    };
    button.addEventListener("click", activate);
    section.append(button);
    return section;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class RawFrontmatterControlsWidget extends WidgetType {
  constructor(private readonly foldBlocked: boolean) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const section = document.createElement("section");
    section.className = "nn-source-properties-raw-controls";
    if (this.foldBlocked) {
      const alert = document.createElement("p");
      alert.className = "nn-source-properties-status";
      alert.setAttribute("role", "alert");
      alert.append(document.createTextNode(
        "Restore the frontmatter delimiters before returning to Properties.",
      ));
      section.append(alert);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nn-source-properties-edit";
    button.setAttribute("aria-label", "Done editing note properties");
    button.append(document.createTextNode("Done"));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const range = sourceFrontmatterRange(view.state);
      view.dispatch({
        effects: finishSourceFrontmatter.of(null),
        ...(range ? { selection: { anchor: range.to } } : {}),
      });
      view.focus();
    });
    section.append(button);
    return section;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

type FrontmatterMode = "preview" | "editing" | "stale";

function build(
  state: EditorState,
  frontmatter: Record<string, unknown> | null,
  hasValidFrontmatter: boolean,
  mode: FrontmatterMode,
  foldBlocked: boolean,
  onSearchTag: () => SearchTag | undefined,
): DecorationSet {
  if (mode === "editing") {
    return Decoration.set([
      Decoration.widget({
        widget: new RawFrontmatterControlsWidget(foldBlocked),
        block: true,
        side: -1,
      }).range(0),
    ]);
  }
  const range = sourceFrontmatterRange(state);
  if (!hasValidFrontmatter || !range) {
    return Decoration.none;
  }
  return Decoration.set([
    Decoration.replace({ block: true, inclusive: false }).range(range.from, range.to),
    Decoration.widget({
      widget: new FrontmatterWidget(
        frontmatter ?? {},
        range,
        onSearchTag,
        mode === "stale",
      ),
      block: true,
      side: 1,
    }).range(range.propertiesAt),
  ], true);
}

interface FrontmatterPreviewState {
  readonly decorations: DecorationSet;
  readonly mode: FrontmatterMode;
  readonly foldBlocked: boolean;
}

export function sourceFrontmatterPreview(
  frontmatter: () => Record<string, unknown> | null,
  hasValidFrontmatter: () => boolean,
  frontmatterRaw: () => string | null,
  onSearchTag: () => SearchTag | undefined,
): Extension {
  return StateField.define<FrontmatterPreviewState>({
    create(state) {
      const range = sourceFrontmatterRange(state);
      const valid = hasValidFrontmatter();
      const currentRaw = sourceFrontmatterRaw(state);
      const savedRaw = frontmatterRaw();
      const synchronized = valid && currentRaw === savedRaw;
      const mode: FrontmatterMode = synchronized || !range ? "preview" : "stale";
      return {
        decorations: build(
          state,
          frontmatter(),
          hasValidFrontmatter(),
          mode,
          false,
          onSearchTag,
        ),
        mode,
        foldBlocked: false,
      };
    },
    update(value, transaction) {
      let { mode, foldBlocked } = value;
      if (transaction.effects.some((effect) => effect.is(refreshSourceFrontmatterPreview))) {
        const range = sourceFrontmatterRange(transaction.state);
        const valid = hasValidFrontmatter();
        const synchronized = valid
          && sourceFrontmatterRaw(transaction.state) === frontmatterRaw();
        if (mode === "editing") {
          foldBlocked = !range;
        } else if (synchronized) {
          mode = "preview";
          foldBlocked = false;
        } else {
          mode = valid && range ? "stale" : "preview";
          foldBlocked = false;
        }
      }
      if (transaction.effects.some((effect) => effect.is(revealSourceFrontmatter))) {
        mode = "editing";
        foldBlocked = false;
      }
      if (transaction.effects.some((effect) => effect.is(finishSourceFrontmatter))) {
        const range = sourceFrontmatterRange(transaction.state);
        if (!range) {
          mode = "editing";
          foldBlocked = true;
        } else {
          mode = sourceFrontmatterRaw(transaction.state) === frontmatterRaw()
            ? "preview"
            : "stale";
          foldBlocked = false;
        }
      }
      if (transaction.docChanged && mode !== "editing") {
        const range = sourceFrontmatterRange(transaction.state);
        const valid = hasValidFrontmatter();
        const synchronized = valid
          && sourceFrontmatterRaw(transaction.state) === frontmatterRaw();
        mode = synchronized || !range ? "preview" : "stale";
        foldBlocked = false;
      }
      return {
        mode,
        foldBlocked,
        decorations: build(
          transaction.state,
          frontmatter(),
          hasValidFrontmatter(),
          mode,
          foldBlocked,
          onSearchTag,
        ),
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}
