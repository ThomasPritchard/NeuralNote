import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldGutter, foldKeymap } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
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
  serializeSourceText,
  SourcePreservationError,
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
import { formatSourceSelections } from "./sourceEditorFormatting";
import type { FormatAction } from "./markdownFormat";
import {
  refreshSourceTitlePlaceholder,
  sourceTitlePlaceholder,
} from "./sourceTitlePlaceholder";
import {
  refreshSourceFrontmatterPreview,
  sourceFrontmatterPreview,
} from "./sourceFrontmatterPreview";

export interface SourceNoteEditorProps {
  sessionKey: string;
  loadedHash: string;
  value: string;
  onChange: (value: string) => void;
  onPreservationError: (message: string | null) => void;
  onPreviewError?: (message: string | null) => void;
  reportError?: (message: string) => void;
  noteIndex?: readonly NoteIndexEntry[];
  onOpenLink?: (relPath: string) => void;
  onSearchTag?: (tag: string) => void;
  sourceRelPath?: string;
  derivedTitle?: string;
  frontmatter?: Record<string, unknown> | null;
  frontmatterRaw?: string | null;
  frontmatterError?: string | null;
}

const EMPTY_NOTE_INDEX: readonly NoteIndexEntry[] = [];

export function SourceNoteEditor({
  sessionKey,
  loadedHash,
  value,
  onChange,
  onPreservationError,
  onPreviewError,
  reportError,
  noteIndex = EMPTY_NOTE_INDEX,
  onOpenLink,
  onSearchTag,
  sourceRelPath = "",
  derivedTitle,
  frontmatter = null,
  frontmatterRaw = null,
  frontmatterError = null,
}: SourceNoteEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const ownershipRef = useRef({ sessionKey, onChange, onPreservationError });
  if (ownershipRef.current.sessionKey !== sessionKey) {
    ownershipRef.current = { sessionKey, onChange, onPreservationError };
  } else {
    ownershipRef.current.onChange = onChange;
    ownershipRef.current.onPreservationError = onPreservationError;
  }
  const ownedCallbacks = ownershipRef.current;
  const previewErrorRef = useRef(onPreviewError);
  const valueRef = useRef(value);
  const noteIndexRef = useRef(noteIndex);
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
      EditorState.allowMultipleSelections.of(true),
      foldGutter(),
      markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
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
      EditorView.lineWrapping,
      autocompletion({
        override: [(context) => createWikilinkCompletionSource(noteIndexRef.current)(context)],
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
      if (cancelled) void release();
      else unlisten = release;
    }).catch((error: unknown) => {
      console.error("failed to subscribe to source editor format actions:", error);
      reportErrorRef.current?.(
        "Format menu actions are unavailable — type Markdown syntax directly in the editor instead.",
      );
    });

    return () => {
      cancelled = true;
      if (unlisten) void unlisten();
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
