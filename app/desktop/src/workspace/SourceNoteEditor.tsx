import {
  defaultKeymap,
  history,
  historyKeymap,
  invertedEffects,
} from "@codemirror/commands";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldGutter, foldKeymap } from "@codemirror/language";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import * as api from "../lib/api";
import {
  acquireSourceEditorSession,
  updateSourceEditorSession,
  type SourceEditorSession,
} from "./sourceEditorSession";
import {
  applySourceChanges,
  serializeSourceRange,
  serializeSourceText,
  SourcePreservationError,
  type SourceText,
} from "./sourceText";
import {
  openResolvedMarkdownLinkAtCaret,
  refreshSourceEditorDecorations,
  sourceEditorDecorations,
} from "./sourceEditorDecorations";
import { resolveMarkdownLink, type NoteIndexEntry } from "./linkResolve";
import {
  obsidianLivePreview,
  openResolvedWikilinkAtCaret,
  openTagSearchAtCaret,
  refreshObsidianPreview,
} from "./obsidianLivePreview";
import { createWikilinkCompletionSource } from "./wikilinkCompletion";
import type { VaultTreeStatus } from "./useVaultTree";
import { formatSourceSelections } from "./sourceEditorFormatting";
import { tableKeymap } from "./sourceEditorTableCommands";
import type { FormatAction } from "./markdownFormat";
import {
  refreshSourceTitlePlaceholder,
  sourceTitlePlaceholder,
} from "./sourceTitlePlaceholder";
import {
  refreshSourceFrontmatterPreview,
  sourceFrontmatterPreview,
} from "./sourceFrontmatterPreview";
import { textMetricsPrimer } from "./sourceEditorTextMetrics";
import { tableCellMeasurement } from "./sourceEditorTableMeasurement";
import { tableScrollSync } from "./sourceEditorTableScrollSync";

export interface SourceNoteEditorProps {
  sessionKey: string;
  loadedHash: string;
  value: string;
  onChange: (value: string) => void;
  onPreservationError: (message: string | null) => void;
  onPreviewError?: (message: string | null) => void;
  reportError?: (message: string) => void;
  noteIndex?: readonly NoteIndexEntry[];
  /** Whether `noteIndex` is a completed vault read. An empty index that failed
   *  to read must say so in the `[[` popup rather than offer nothing (#209). */
  noteIndexStatus?: VaultTreeStatus;
  onOpenLink?: (relPath: string) => void;
  onSearchTag?: (tag: string) => void;
  sourceRelPath?: string;
  derivedTitle?: string;
  frontmatter?: Record<string, unknown> | null;
  frontmatterRaw?: string | null;
  frontmatterError?: string | null;
}

const EMPTY_NOTE_INDEX: readonly NoteIndexEntry[] = [];
const preserveExactSourceHistory = StateEffect.define<null>();
const restoreExactSourceHistory = StateEffect.define<SourceText>();

function exactSourceHistory(source: () => SourceText) {
  return invertedEffects.of((transaction) => {
    const preservesSource = transaction.effects.some((effect) =>
      effect.is(preserveExactSourceHistory) || effect.is(restoreExactSourceHistory));
    return preservesSource ? [restoreExactSourceHistory.of(source())] : [];
  });
}

function exactSourceClipboard(source: () => SourceText) {
  function writeSelection(event: ClipboardEvent, view: EditorView): boolean {
    if (!event.clipboardData || view.state.selection.ranges.every((range) => range.empty)) {
      return false;
    }
    const currentSource = source();
    const selectedSource = view.state.selection.ranges
      .map((range) => serializeSourceRange(currentSource, range.from, range.to))
      .join("\n");
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectedSource);
    return true;
  }

  return EditorView.domEventHandlers({
    copy(event, view) {
      return writeSelection(event, view);
    },
    cut(event, view) {
      if (!writeSelection(event, view)) return false;
      view.dispatch(
        view.state.replaceSelection(""),
        {
          effects: preserveExactSourceHistory.of(null),
          userEvent: "delete.cut",
          scrollIntoView: true,
        },
      );
      return true;
    },
  });
}

export function SourceNoteEditor({
  sessionKey,
  loadedHash,
  value,
  onChange,
  onPreservationError,
  onPreviewError,
  reportError,
  noteIndex = EMPTY_NOTE_INDEX,
  noteIndexStatus = "ready",
  onOpenLink,
  onSearchTag,
  sourceRelPath = "",
  derivedTitle,
  frontmatter = null,
  frontmatterRaw = null,
  frontmatterError = null,
}: Readonly<SourceNoteEditorProps>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const ownershipRef = useRef({ sessionKey, onChange, onPreservationError });
  if (ownershipRef.current.sessionKey === sessionKey) {
    ownershipRef.current.onChange = onChange;
    ownershipRef.current.onPreservationError = onPreservationError;
  } else {
    ownershipRef.current = { sessionKey, onChange, onPreservationError };
  }
  const ownedCallbacks = ownershipRef.current;
  const previewErrorRef = useRef(onPreviewError);
  const valueRef = useRef(value);
  const noteIndexRef = useRef(noteIndex);
  const noteIndexStatusRef = useRef(noteIndexStatus);
  const openLinkRef = useRef(onOpenLink);
  const searchTagRef = useRef(onSearchTag);
  const sourceRelPathRef = useRef(sourceRelPath);
  const derivedTitleRef = useRef(derivedTitle);
  const reportErrorRef = useRef(reportError);
  const frontmatterRef = useRef(frontmatter);
  const frontmatterRawRef = useRef(frontmatterRaw);
  const frontmatterErrorRef = useRef(frontmatterError);
  previewErrorRef.current = onPreviewError;
  valueRef.current = value;
  noteIndexRef.current = noteIndex;
  noteIndexStatusRef.current = noteIndexStatus;
  openLinkRef.current = onOpenLink;
  searchTagRef.current = onSearchTag;
  sourceRelPathRef.current = sourceRelPath;
  derivedTitleRef.current = derivedTitle;
  reportErrorRef.current = reportError;
  frontmatterRef.current = frontmatter;
  frontmatterRawRef.current = frontmatterRaw;
  frontmatterErrorRef.current = frontmatterError;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let session: SourceEditorSession;
    const extensions = [
      history(),
      exactSourceHistory(() => session.source),
      EditorState.allowMultipleSelections.of(true),
      exactSourceClipboard(() => session.source),
      foldGutter(),
      markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
      // Declared ahead of the decorations that consume them, because that is the
      // dependency direction: `textMetricsPrimer` keeps the measurement probe
      // primed for this view's lifetime, and `tableCellMeasurement` is the only
      // provider of the facet the table render plan reads. Register neither and
      // every table column silently falls back to a character-count width.
      textMetricsPrimer,
      tableCellMeasurement,
      sourceFrontmatterPreview(
        () => frontmatterRef.current,
        () => frontmatterRawRef.current !== null && frontmatterErrorRef.current === null,
        () => frontmatterRawRef.current,
        () => searchTagRef.current,
      ),
      sourceEditorDecorations(
        (message) => previewErrorRef.current?.(message),
        {
          resolveLink: (href) => resolveMarkdownLink(
            href,
            [...noteIndexRef.current],
            sourceRelPathRef.current,
          ),
          onOpenLink: (relPath) => openLinkRef.current?.(relPath),
        },
      ),
      sourceTitlePlaceholder(() => derivedTitleRef.current),
      drawSelection(),
      // After both of the things it repairs: the row lines `sourceEditorDecorations`
      // stamps, which are the scroll containers it keeps on one offset, and the
      // caret `drawSelection()` paints outside them, which it re-derives once a
      // row has moved under it.
      tableScrollSync,
      EditorView.lineWrapping,
      autocompletion({
        override: [
          (context) =>
            createWikilinkCompletionSource(
              noteIndexRef.current,
              noteIndexStatusRef.current,
            )(context),
        ],
        activateOnTyping: true,
        selectOnOpen: true,
      }),
      obsidianLivePreview(
        () => noteIndexRef.current,
        (relPath) => openLinkRef.current?.(relPath),
        (tag) => searchTagRef.current?.(tag),
      ),
      keymap.of([
        {
          key: "Enter",
          run: openTagSearchAtCaret((tag) => searchTagRef.current?.(tag)),
        },
        {
          key: "Mod-Enter",
          run: openTagSearchAtCaret((tag) => searchTagRef.current?.(tag)),
        },
        {
          key: "Mod-Enter",
          run: openResolvedWikilinkAtCaret(
            () => noteIndexRef.current,
            (relPath) => openLinkRef.current?.(relPath),
          ),
        },
        {
          key: "Mod-Enter",
          run: openResolvedMarkdownLinkAtCaret(
            (href) => resolveMarkdownLink(
              href,
              [...noteIndexRef.current],
              sourceRelPathRef.current,
            ),
            (relPath) => openLinkRef.current?.(relPath),
          ),
        },
        ...completionKeymap,
        // After completionKeymap so an open wikilink popup keeps Enter, and
        // before defaultKeymap so Enter steps down a column instead of breaking
        // the table. Each command returns false outside a table, so Tab still
        // moves focus everywhere else in the editor.
        // The bindings themselves live beside the commands they run, so their
        // order is testable against the real array rather than a restatement of
        // it. See `sourceEditorTableKeymap.test.ts`.
        ...tableKeymap,
        ...foldKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.contentAttributes.of({
        "aria-label": "Note content",
        "aria-multiline": "true",
        spellcheck: "true",
      }),
    ];
    session = acquireSourceEditorSession(sessionKey, loadedHash, valueRef.current, extensions);

    const view = new EditorView({
      state: session.state,
      parent: host,
      dispatchTransactions(transactions, editorView) {
        let source = session.source;
        try {
          for (const transaction of transactions) {
            if (transaction.docChanged) source = applySourceChanges(source, transaction.changes);
            const restoredSource = transaction.effects.find((effect) =>
              effect.is(restoreExactSourceHistory));
            if (restoredSource?.is(restoreExactSourceHistory)) {
              serializeSourceText(restoredSource.value);
              if (restoredSource.value.text !== transaction.newDoc.toString()) {
                throw new SourcePreservationError(
                  "Cannot restore exact source history: the snapshot does not match the editor document.",
                );
              }
              source = restoredSource.value;
            }
          }
          editorView.update(transactions);
          session = {
            ...session,
            state: editorView.state,
            source,
            preservationError: null,
          };
          updateSourceEditorSession(sessionKey, session);
          ownedCallbacks.onPreservationError(null);
          if (transactions.some((transaction) => transaction.docChanged)) {
            ownedCallbacks.onChange(serializeSourceText(source));
          }
        } catch (error) {
          editorView.update(transactions);
          const message =
            error instanceof SourcePreservationError
              ? error.message
              : "NeuralNote could not preserve this note's line endings. Saving is blocked.";
          session = {
            ...session,
            state: editorView.state,
            preservationError: message,
          };
          updateSourceEditorSession(sessionKey, session);
          if (transactions.some((transaction) => transaction.docChanged)) {
            ownedCallbacks.onChange(editorView.state.doc.toString());
          }
          ownedCallbacks.onPreservationError(message);
        }
      },
    });
    viewRef.current = view;
    view.scrollDOM.scrollTop = session.scrollTop;

    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void api.onMenu((event) => {
      if (!event.action.startsWith("format-") || !view.hasFocus) return;
      view.dispatch(formatSourceSelections(view.state, event.action as FormatAction));
      view.focus();
    }).then((release) => {
      // Unmounted before the subscription resolved: release it immediately so
      // the listener can't outlive this view. `release` returns void, so there
      // is nothing to await here.
      if (cancelled) release();
      else unlisten = release;
    }).catch((error: unknown) => {
      console.error("failed to subscribe to source editor format actions:", error);
      reportErrorRef.current?.(
        "Format menu actions are unavailable — type Markdown syntax directly in the editor instead.",
      );
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      updateSourceEditorSession(sessionKey, {
        ...session,
        state: view.state,
        scrollTop: view.scrollDOM.scrollTop,
      });
      if (viewRef.current === view) viewRef.current = null;
      view.destroy();
    };
  }, [loadedHash, ownedCallbacks, sessionKey]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        refreshObsidianPreview.of(null),
        refreshSourceEditorDecorations.of(null),
      ],
    });
  }, [noteIndex, sourceRelPath]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshSourceTitlePlaceholder.of(null) });
  }, [derivedTitle]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshSourceFrontmatterPreview.of(null) });
  }, [frontmatter, frontmatterError, frontmatterRaw]);

  return <div ref={hostRef} className="nn-source-editor" />;
}
