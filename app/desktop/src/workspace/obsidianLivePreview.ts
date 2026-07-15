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

import type { NoteIndexEntry } from "./linkResolve";
import { resolveWikilink } from "./linkResolve";
import type { PreviewDecoration, VisibleRange } from "./sourceEditorDecorations";

export interface ObsidianPreviewDecoration extends PreviewDecoration {
  readonly target?: string | null;
}

export const refreshObsidianPreview = StateEffect.define<null>();

function active(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) =>
    range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from,
  );
}

const SCAN_MARGIN = 2_048;

function boundedScanRanges(
  docLength: number,
  visibleRanges: readonly VisibleRange[],
): VisibleRange[] {
  const expanded = visibleRanges
    .map(({ from, to }) => ({
      from: Math.max(0, from - SCAN_MARGIN),
      to: Math.min(docLength, to + SCAN_MARGIN),
    }))
    .sort((left, right) => left.from - right.from);
  const merged: VisibleRange[] = [];
  for (const range of expanded) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: Math.max(previous.to, range.to) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function codeRanges(
  state: EditorState,
  scanRanges: readonly VisibleRange[],
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const scan of scanRanges) {
    syntaxTree(state).iterate({
      from: scan.from,
      to: scan.to,
      enter({ name, from, to }) {
        if (name === "InlineCode" || name === "FencedCode") ranges.push({ from, to });
      },
    });
  }
  return ranges;
}

function overlapsCode(from: number, to: number, ranges: readonly { from: number; to: number }[]): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function insideVisible(from: number, to: number, ranges: readonly VisibleRange[]): boolean {
  return ranges.some((range) => from >= range.from && to <= range.to);
}

function displayLabel(rawTarget: string): string {
  const [beforeAlias, alias] = rawTarget.split("|", 2);
  if (alias?.trim()) return alias.trim();
  const note = (beforeAlias ?? rawTarget).split("#", 1)[0]?.trim() ?? rawTarget;
  const base = note.slice(note.lastIndexOf("/") + 1).replace(/\.(?:md|markdown|mdx)$/i, "");
  return base || rawTarget;
}

export function collectObsidianPreview(
  state: EditorState,
  index: readonly NoteIndexEntry[],
  visibleRanges: readonly VisibleRange[] = [{ from: 0, to: state.doc.length }],
): ObsidianPreviewDecoration[] {
  const scanRanges = boundedScanRanges(state.doc.length, visibleRanges);
  const masked = codeRanges(state, scanRanges);
  const output: ObsidianPreviewDecoration[] = [];
  const wikilink = /(!)?\[\[([^\]\r\n]+)\]\]/g;

  for (const scan of scanRanges) {
    const source = state.sliceDoc(scan.from, scan.to);
    for (const match of source.matchAll(wikilink)) {
      const from = scan.from + match.index;
      const to = from + match[0].length;
      if (!insideVisible(from, to, visibleRanges) || overlapsCode(from, to, masked)) continue;
      const embed = match[1] === "!";
      const rawTarget = match[2];
      const target = resolveWikilink(rawTarget, [...index]);
      if (active(state, from, to)) {
        output.push({ from, to, kind: "mark", className: "nn-lp-wikilink-active", target });
      } else {
        output.push({
          from,
          to,
          kind: "widget",
          className: embed
            ? "nn-lp-embed"
            : target
              ? "nn-lp-wikilink-resolved"
              : "nn-lp-wikilink-unresolved",
          label: `${embed ? "Embed: " : ""}${displayLabel(rawTarget)}`,
          target: embed ? null : target,
        });
      }
    }

    const callouts = /^>\s*\[![A-Za-z0-9_-]+\][+-]?/gm;
    for (const callout of source.matchAll(callouts)) {
      const from = scan.from + callout.index;
      const to = from + callout[0].length;
      const realLineStart = from === 0 || state.sliceDoc(from - 1, from) === "\n";
      if (realLineStart && insideVisible(from, to, visibleRanges) && !overlapsCode(from, to, masked)) {
        output.push({ from, to, kind: "mark", className: "nn-lp-callout" });
      }
    }

    const blocks = /(?:^|\s)(\^[A-Za-z0-9-]+)\s*$/gm;
    for (const block of source.matchAll(blocks)) {
      const markerOffset = block[0].indexOf(block[1]);
      const from = scan.from + block.index + markerOffset;
      const to = from + block[1].length;
      const matchEnd = scan.from + block.index + block[0].length;
      const realLineEnd = matchEnd === state.doc.length || state.sliceDoc(matchEnd, matchEnd + 1) === "\n";
      if (realLineEnd && insideVisible(from, to, visibleRanges) && !overlapsCode(from, to, masked)) {
        output.push({ from, to, kind: "mark", className: "nn-lp-block-id" });
      }
    }
  }

  return output.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function openResolvedWikilinkAtCaret(
  index: readonly NoteIndexEntry[] | (() => readonly NoteIndexEntry[]),
  onOpenLink: (relPath: string) => void,
): (view: EditorView) => boolean {
  return (view) => {
    const caret = view.state.selection.main.head;
    const line = view.state.doc.lineAt(caret);
    const currentIndex = typeof index === "function" ? index() : index;
    const item = collectObsidianPreview(view.state, currentIndex, [{ from: line.from, to: line.to }])
      .find((candidate) => candidate.target && caret >= candidate.from && caret <= candidate.to);
    if (!item?.target) return false;
    onOpenLink(item.target);
    view.dispatch({ effects: EditorView.announce.of(`Opening ${item.target}`) });
    return true;
  };
}

class ObsidianWidget extends WidgetType {
  constructor(private readonly item: ObsidianPreviewDecoration) {
    super();
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = this.item.className;
    element.dataset.nnSourceFrom = String(this.item.from);
    if (this.item.target) {
      element.dataset.nnWikilinkTarget = this.item.target;
      element.title = `Command/Control-click to open ${this.item.target}`;
    }
    element.append(document.createTextNode(this.item.label ?? ""));
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function build(view: EditorView, index: readonly NoteIndexEntry[]): DecorationSet {
  const ranges = collectObsidianPreview(view.state, index, view.visibleRanges).map((item) =>
    item.kind === "widget"
      ? Decoration.replace({ widget: new ObsidianWidget(item), inclusive: false }).range(item.from, item.to)
      : Decoration.mark({ class: item.className }).range(item.from, item.to),
  );
  return Decoration.set(ranges, true);
}

export function obsidianLivePreview(
  index: readonly NoteIndexEntry[] | (() => readonly NoteIndexEntry[]),
  onOpenLink: (relPath: string) => void,
): Extension {
  const currentIndex = () => typeof index === "function" ? index() : index;
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view, currentIndex());
      }

      update(update: ViewUpdate): void {
        const indexChanged = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshObsidianPreview))
        );
        if (update.docChanged || update.viewportChanged || update.selectionSet || indexChanged) {
          this.decorations = build(update.view, currentIndex());
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const element = (event.target as Element | null)?.closest<HTMLElement>("[data-nn-source-from]");
          if (!element) return false;
          const from = Number(element.dataset.nnSourceFrom);
          const target = element.dataset.nnWikilinkTarget;
          if ((event.metaKey || event.ctrlKey) && target) {
            event.preventDefault();
            onOpenLink(target);
            return true;
          }
          if (Number.isSafeInteger(from)) {
            event.preventDefault();
            view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
            view.focus();
            return true;
          }
          return false;
        },
      },
    },
  );
}
