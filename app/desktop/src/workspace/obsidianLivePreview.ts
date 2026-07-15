import { syntaxTree } from "@codemirror/language";
import { Prec, StateEffect, type EditorState, type Extension } from "@codemirror/state";
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
import { sourceFrontmatterRange } from "./sourceFrontmatterPreview";
import { inlineTagAt } from "./obsidianTag";

export interface ObsidianPreviewDecoration extends PreviewDecoration {
  readonly target?: string | null;
  readonly tag?: string;
}

export const refreshObsidianPreview = StateEffect.define<null>();

function active(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) =>
    range.empty ? range.head >= from && range.head <= to : range.from < to && range.to > from,
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

const TAG_MASKED_NODES = new Set([
  "Autolink",
  "CodeBlock",
  "Escape",
  "FencedCode",
  "HTMLTag",
  "Image",
  "InlineCode",
  "Link",
  "LinkLabel",
  "LinkReference",
  "URL",
]);
const PREVIEW_MASKED_NODES = new Set(["CodeBlock", "FencedCode", "InlineCode"]);

function syntaxMaskedRanges(
  state: EditorState,
  scanRanges: readonly VisibleRange[],
  nodeNames: ReadonlySet<string>,
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const scan of scanRanges) {
    syntaxTree(state).iterate({
      from: scan.from,
      to: scan.to,
      enter({ name, from, to }) {
        if (nodeNames.has(name)) ranges.push({ from, to });
      },
    });
  }
  const frontmatter = sourceFrontmatterRange(state);
  if (frontmatter) ranges.push({ from: frontmatter.from, to: frontmatter.to });
  return ranges;
}

function overlapsMasked(from: number, to: number, ranges: readonly { from: number; to: number }[]): boolean {
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
  selectionActive = true,
): ObsidianPreviewDecoration[] {
  const scanRanges = boundedScanRanges(state.doc.length, visibleRanges);
  const previewMasked = syntaxMaskedRanges(state, scanRanges, PREVIEW_MASKED_NODES);
  const tagMasked = syntaxMaskedRanges(state, scanRanges, TAG_MASKED_NODES);
  const output: ObsidianPreviewDecoration[] = [];
  const wikilink = /(!)?\[\[([^\]\r\n]+)\]\]/g;

  for (const scan of scanRanges) {
    const source = state.sliceDoc(scan.from, scan.to);
    for (const match of source.matchAll(wikilink)) {
      const from = scan.from + match.index;
      const to = from + match[0].length;
      tagMasked.push({ from, to });
      if (!insideVisible(from, to, visibleRanges) || overlapsMasked(from, to, previewMasked)) continue;
      const embed = match[1] === "!";
      const rawTarget = match[2];
      const target = resolveWikilink(rawTarget, [...index]);
      if (selectionActive && active(state, from, to)) {
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
      if (realLineStart && insideVisible(from, to, visibleRanges) && !overlapsMasked(from, to, previewMasked)) {
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
      if (realLineEnd && insideVisible(from, to, visibleRanges) && !overlapsMasked(from, to, previewMasked)) {
        output.push({ from, to, kind: "mark", className: "nn-lp-block-id" });
      }
    }

    for (const hash of source.matchAll(/#/g)) {
      const from = scan.from + hash.index;
      const previous = from === 0 ? "" : state.sliceDoc(from - 1, from);
      if (from !== 0 && !/\s/u.test(previous)) continue;
      const tag = inlineTagAt(source, hash.index);
      if (!tag) continue;
      const to = from + tag.length;
      if (
        insideVisible(from, to, visibleRanges) &&
        !overlapsMasked(from, to, tagMasked)
      ) {
        output.push({ from, to, kind: "mark", className: "nn-lp-tag", tag });
      }
    }
  }

  return output.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function openTagSearchAtCaret(
  onSearchTag: (tag: string) => void,
): (view: EditorView) => boolean {
  return (view) => {
    const caret = view.state.selection.main.head;
    const line = view.state.doc.lineAt(caret);
    const item = collectObsidianPreview(view.state, [], [{ from: line.from, to: line.to }])
      .find((candidate) => candidate.tag && caret >= candidate.from && caret <= candidate.to);
    if (!item?.tag) return false;
    view.dispatch({ effects: EditorView.announce.of(`Searching for ${item.tag}`) });
    queueMicrotask(() => onSearchTag(item.tag!));
    return true;
  };
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
      element.title = `Open ${this.item.target}`;
      element.setAttribute("role", "link");
      element.tabIndex = 0;
      element.setAttribute("aria-keyshortcuts", "Enter");
    }
    element.append(document.createTextNode(this.item.label ?? ""));
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function build(view: EditorView, index: readonly NoteIndexEntry[]): DecorationSet {
  const ranges = collectObsidianPreview(
    view.state,
    index,
    view.visibleRanges,
    view.hasFocus,
  ).map((item) =>
    item.kind === "widget"
      ? Decoration.replace({ widget: new ObsidianWidget(item), inclusive: false }).range(item.from, item.to)
      : Decoration.mark({
          class: item.className,
          attributes: item.tag
            ? {
              "data-nn-tag": item.tag,
                role: "link",
                "aria-label": `Search for ${item.tag}`,
                "aria-keyshortcuts": "Meta+Enter Control+Enter",
                title: `Search for ${item.tag}`,
              }
            : undefined,
        }).range(item.from, item.to),
  );
  return Decoration.set(ranges, true);
}

export function obsidianLivePreview(
  index: readonly NoteIndexEntry[] | (() => readonly NoteIndexEntry[]),
  onOpenLink: (relPath: string) => void,
  onSearchTag: (tag: string) => void,
): Extension {
  const currentIndex = () => typeof index === "function" ? index() : index;
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
        "[data-nn-wikilink-target]",
      );
      const target = element?.dataset.nnWikilinkTarget;
      if (!target) return false;
      event.preventDefault();
      onOpenLink(target);
      return true;
    },
  }));
  const previewPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view, currentIndex());
      }

      update(update: ViewUpdate): void {
        const indexChanged = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshObsidianPreview))
        );
        if (
          update.docChanged
          || update.viewportChanged
          || update.selectionSet
          || update.focusChanged
          || indexChanged
        ) {
          this.decorations = build(update.view, currentIndex());
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const tagElement = (event.target as Element | null)?.closest<HTMLElement>("[data-nn-tag]");
          const tag = tagElement?.dataset.nnTag;
          if (event.button === 0 && tag) {
            event.preventDefault();
            queueMicrotask(() => onSearchTag(tag));
            return true;
          }
          const element = (event.target as Element | null)?.closest<HTMLElement>("[data-nn-source-from]");
          if (!element) return false;
          const from = Number(element.dataset.nnSourceFrom);
          const target = element.dataset.nnWikilinkTarget;
          if (event.button === 0 && target) {
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
        click(event) {
          if (event.detail !== 0) return false;
          const element = (event.target as Element | null)?.closest<HTMLElement>(
            "[data-nn-wikilink-target]",
          );
          const target = element?.dataset.nnWikilinkTarget;
          if (!target) return false;
          event.preventDefault();
          onOpenLink(target);
          return true;
        },
      },
    },
  );
  return [keyboardLinkHandler, previewPlugin];
}
