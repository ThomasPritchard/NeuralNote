import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type StateEffectType,
  type Transaction,
} from "@codemirror/state";
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

/** The saved note's frontmatter as the editor last parsed it. The document is
 *  compared against this to decide whether the rendered preview has gone
 *  stale — both halves are reads of the same saved state, so they travel
 *  together. */
interface SavedFrontmatter {
  readonly isValid: () => boolean;
  readonly raw: () => string | null;
}

interface PreviewMode {
  readonly mode: FrontmatterMode;
  readonly foldBlocked: boolean;
}

interface FrontmatterPreviewState extends PreviewMode {
  readonly decorations: DecorationSet;
}

/** Does the document's YAML still match the frontmatter the editor parsed? */
function isSynchronized(state: EditorState, saved: SavedFrontmatter): boolean {
  return saved.isValid() && sourceFrontmatterRaw(state) === saved.raw();
}

/** The mode a settled document implies. A note with no frontmatter block has
 *  nothing to preview; one whose YAML has drifted from the parsed copy shows
 *  the stale notice instead. */
function settledMode(state: EditorState, saved: SavedFrontmatter): FrontmatterMode {
  if (sourceFrontmatterRange(state) === null) return "preview";
  return isSynchronized(state, saved) ? "preview" : "stale";
}

/** A refresh lands after a save, once the parsed frontmatter has caught up with
 *  the document. An open raw-editing session stays open — it only learns
 *  whether the delimiters are back and it may fold. */
function refreshedState(
  current: PreviewMode,
  state: EditorState,
  saved: SavedFrontmatter,
): PreviewMode {
  if (current.mode === "editing") {
    return { mode: "editing", foldBlocked: sourceFrontmatterRange(state) === null };
  }
  if (isSynchronized(state, saved)) return { mode: "preview", foldBlocked: false };
  const previewable = saved.isValid() && sourceFrontmatterRange(state) !== null;
  return { mode: previewable ? "stale" : "preview", foldBlocked: false };
}

/** Leaving the raw editor. With the delimiters gone there is nothing to fold
 *  back into, so the session is held open and the blocking notice shown. */
function finishedState(state: EditorState, saved: SavedFrontmatter): PreviewMode {
  if (sourceFrontmatterRange(state) === null) {
    return { mode: "editing", foldBlocked: true };
  }
  return {
    mode: sourceFrontmatterRaw(state) === saved.raw() ? "preview" : "stale",
    foldBlocked: false,
  };
}

/** Does this transaction carry `effect`? */
function carries<T>(transaction: Transaction, effect: StateEffectType<T>): boolean {
  return transaction.effects.some((candidate) => candidate.is(effect));
}

export function sourceFrontmatterPreview(
  frontmatter: () => Record<string, unknown> | null,
  hasValidFrontmatter: () => boolean,
  frontmatterRaw: () => string | null,
  onSearchTag: () => SearchTag | undefined,
): Extension {
  const saved: SavedFrontmatter = { isValid: hasValidFrontmatter, raw: frontmatterRaw };
  return StateField.define<FrontmatterPreviewState>({
    create(state) {
      const mode = settledMode(state, saved);
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
      let next: PreviewMode = value;
      if (carries(transaction, refreshSourceFrontmatterPreview)) {
        next = refreshedState(next, transaction.state, saved);
      }
      if (carries(transaction, revealSourceFrontmatter)) {
        next = { mode: "editing", foldBlocked: false };
      }
      if (carries(transaction, finishSourceFrontmatter)) {
        next = finishedState(transaction.state, saved);
      }
      if (transaction.docChanged && next.mode !== "editing") {
        next = { mode: settledMode(transaction.state, saved), foldBlocked: false };
      }
      return {
        mode: next.mode,
        foldBlocked: next.foldBlocked,
        decorations: build(
          transaction.state,
          frontmatter(),
          hasValidFrontmatter(),
          next.mode,
          next.foldBlocked,
          onSearchTag,
        ),
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}
