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
import {
  caretTouching,
  CODE_MASKED_NODES,
  inlineWikilinks,
  TAG_MASKED_NODES,
} from "./sourceEditorCellPaintPlan";
import type { PreviewDecoration, VisibleRange } from "./sourceEditorDecorations";
import { sourceFrontmatterRange } from "./sourceFrontmatterPreview";
import { inlineTagAt } from "./obsidianTag";

export interface ObsidianPreviewDecoration extends PreviewDecoration {
  readonly target?: string | null;
  readonly tag?: string;
}

export const refreshObsidianPreview = StateEffect.define<null>();

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

/**
 * Constructs that own their entire span, so a `[[wikilink]]` nested strictly
 * inside one is the enclosing construct's business to paint. Without this, an
 * image or link wrapping a wikilink draws two widgets over the same characters.
 */
const WIKILINK_CONTAINER_NODES = new Set(["Image", "Link"]);

/**
 * Whether a newer syntax tree arrived between these two states.
 *
 * CodeMirror announces the parse it finished on an idle callback with a
 * transaction that changes no document, moves no selection and carries no
 * effect of ours, so nothing else in `update` below notices it. Without this the
 * ranges masked as unparsed would stay blank until the user happened to type.
 * `sourceEditorDecorations.ts` keeps the same guard, and documents it at length.
 */
function reparsed(before: EditorState, after: EditorState): boolean {
  return syntaxTree(before) !== syntaxTree(after);
}

function syntaxMaskedRanges(
  state: EditorState,
  scanRanges: readonly VisibleRange[],
  nodeNames: ReadonlySet<string>,
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const tree = syntaxTree(state);
  for (const scan of scanRanges) {
    tree.iterate({
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

/**
 * The tail of the document nothing has parsed yet, masked for the render path.
 *
 * Past the end of the tree every masking node is missing simply because nothing
 * has parsed there: `LanguageState.init` covers only the first 3,000 characters,
 * abandons even that slice once its 20 ms of wall clock is spent, and leaves the
 * rest to an idle callback (`@codemirror/language/dist/index.js:540-545`).
 *
 * The decorations here are found by scanning TEXT and suppressed by finding a
 * node over them, so an absent node reads as "not masked" — the one direction in
 * which a late tree paints something wrong rather than nothing at all, and it
 * put a `#tag` inside an unparsed fenced block (issue #129). What has not been
 * parsed is therefore masked until it has been; `reparsed` above repaints as
 * soon as the tree catches up.
 *
 * {@link decorationAtCaret} declines this mask deliberately — see the reasoning
 * there.
 */
function unparsedTail(state: EditorState): VisibleRange[] {
  const parsedTo = syntaxTree(state).length;
  return parsedTo < state.doc.length ? [{ from: parsedTo, to: state.doc.length }] : [];
}

function overlapsMasked(from: number, to: number, ranges: readonly { from: number; to: number }[]): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function enclosedByMaskedContainer(
  from: number,
  to: number,
  ranges: readonly { from: number; to: number }[],
): boolean {
  return ranges.some((range) =>
    range.from <= from
    && range.to >= to
    && (range.from < from || range.to > to)
  );
}

function insideVisible(from: number, to: number, ranges: readonly VisibleRange[]): boolean {
  return ranges.some((range) => from >= range.from && to <= range.to);
}

interface PreviewScanOptions {
  readonly visibleRanges: readonly VisibleRange[];
  readonly selectionActive: boolean;
  /**
   * Ranges masked only because the parser has not reached them yet. Kept out of
   * the exported signature on purpose: a render path that forgot it repaints
   * issue #129, and a command path that took it edits the note (see
   * {@link decorationAtCaret}). Neither caller should be choosing.
   */
  readonly unparsedMask: readonly VisibleRange[];
}

function collectPreview(
  state: EditorState,
  index: readonly NoteIndexEntry[],
  { visibleRanges, selectionActive, unparsedMask }: PreviewScanOptions,
): ObsidianPreviewDecoration[] {
  const scanRanges = boundedScanRanges(state.doc.length, visibleRanges);
  const masked = (nodeNames: ReadonlySet<string>) =>
    [...syntaxMaskedRanges(state, scanRanges, nodeNames), ...unparsedMask];
  const codeMasked = masked(CODE_MASKED_NODES);
  const wikilinkContainers = masked(WIKILINK_CONTAINER_NODES);
  const tagMasked = masked(TAG_MASKED_NODES);
  const output: ObsidianPreviewDecoration[] = [];

  for (const scan of scanRanges) {
    const source = state.sliceDoc(scan.from, scan.to);
    // `inlineWikilinks` and the label it carries are CT-3's, so the span this
    // replaces and the span `cellPaintPlan` projects are one answer, not two.
    for (const { from, to, embed, rawTarget, label } of inlineWikilinks(source, scan.from)) {
      tagMasked.push({ from, to });
      if (
        !insideVisible(from, to, visibleRanges)
        || overlapsMasked(from, to, codeMasked)
        || enclosedByMaskedContainer(from, to, wikilinkContainers)
      ) continue;
      const target = resolveWikilink(rawTarget, [...index]);
      if (selectionActive && caretTouching(state, from, to)) {
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
          label: `${embed ? "Embed: " : ""}${label}`,
          target: embed ? null : target,
        });
      }
    }

    const callouts = /^>\s*\[![A-Za-z0-9_-]+\][+-]?/gm;
    for (const callout of source.matchAll(callouts)) {
      const from = scan.from + callout.index;
      const to = from + callout[0].length;
      const realLineStart = from === 0 || state.sliceDoc(from - 1, from) === "\n";
      if (realLineStart && insideVisible(from, to, visibleRanges) && !overlapsMasked(from, to, codeMasked)) {
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
      if (realLineEnd && insideVisible(from, to, visibleRanges) && !overlapsMasked(from, to, codeMasked)) {
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

/**
 * What to paint, for the render path.
 *
 * Masks the tail nothing has parsed yet, so an unfinished parse renders nothing
 * over the constructs it has not reached rather than the wrong thing (issue
 * #129). Every caller that draws goes through here, precisely so none of them
 * has to remember that.
 */
export function collectObsidianPreview(
  state: EditorState,
  index: readonly NoteIndexEntry[],
  visibleRanges: readonly VisibleRange[] = [{ from: 0, to: state.doc.length }],
  selectionActive = true,
): ObsidianPreviewDecoration[] {
  return collectPreview(state, index, {
    visibleRanges,
    selectionActive,
    unparsedMask: unparsedTail(state),
  });
}

/**
 * The matching decoration under the caret, scanning the caret's line only.
 *
 * Declines {@link unparsedTail} on purpose, and that is the whole reason this
 * exists apart from {@link collectObsidianPreview}. The two paths fail closed in
 * opposite directions: suppressing a decoration draws nothing and is safe, but a
 * command that finds nothing returns `false`, and CodeMirror then runs the next
 * binding for that key. Bare Enter is bound to {@link openTagSearchAtCaret}
 * ahead of `insertNewlineAndIndent` (`SourceNoteEditor.tsx`), so masking the
 * caret's own line would not decline the action — it would insert a newline into
 * the user's note. Text alone answers for one line the user is already pointing
 * at.
 */
function decorationAtCaret(
  state: EditorState,
  index: readonly NoteIndexEntry[],
  matches: (candidate: ObsidianPreviewDecoration) => boolean,
): ObsidianPreviewDecoration | undefined {
  const caret = state.selection.main.head;
  const line = state.doc.lineAt(caret);
  return collectPreview(state, index, {
    visibleRanges: [{ from: line.from, to: line.to }],
    selectionActive: true,
    unparsedMask: [],
  }).find((candidate) => caret >= candidate.from && caret <= candidate.to && matches(candidate));
}

export function openTagSearchAtCaret(
  onSearchTag: (tag: string) => void,
): (view: EditorView) => boolean {
  return (view) => {
    const item = decorationAtCaret(view.state, [], (candidate) => Boolean(candidate.tag));
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
    const currentIndex = typeof index === "function" ? index() : index;
    const item = decorationAtCaret(
      view.state,
      currentIndex,
      (candidate) => Boolean(candidate.target),
    );
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
                "aria-keyshortcuts": "Enter Meta+Enter Control+Enter",
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
          || reparsed(update.startState, update.state)
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
