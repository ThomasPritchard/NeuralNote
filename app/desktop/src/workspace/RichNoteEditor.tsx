import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  MDXEditor,
  applyBlockType$,
  applyFormat$,
  codeBlockPlugin,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  openLinkEditDialog$,
  quotePlugin,
  realmPlugin,
  thematicBreakPlugin,
  useCodeBlockEditorContext,
  type CodeBlockEditorDescriptor,
  type CodeBlockEditorProps,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import * as api from "../lib/api";
import {
  preflightMountedRichDocument,
  richLinkIsSafe,
  type RichSourceDocument,
} from "./richEditorAdapter";
import { resolveMarkdownLink, type NoteIndexEntry } from "./linkResolve";

interface FormatController {
  format: (action: api.MenuAction) => void;
}

interface RichNoteEditorProps {
  document: RichSourceDocument;
  body: string;
  sourceRelPath: string;
  onBodyChange: (body: string) => void;
  onFallback: (message: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  noteIndex?: NoteIndexEntry[];
  onOpenLink?: (relPath: string) => void;
  reportError?: (message: string) => void;
}

function PlainCodeEditor({
  code,
  language,
  focusEmitter,
}: Readonly<CodeBlockEditorProps>) {
  const { setCode } = useCodeBlockEditorContext();
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => focusEmitter.subscribe(() => textarea.current?.focus()), [focusEmitter]);
  return (
    <textarea
      ref={textarea}
      value={code}
      onChange={(event) => setCode(event.target.value)}
      spellCheck={false}
      aria-label={language ? `${language} code block` : "Code block"}
      className="nn-mono min-h-24 w-full resize-y rounded-md border border-border bg-card/70 p-4 text-[0.8125rem] leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
    />
  );
}

const plainCodeDescriptor: CodeBlockEditorDescriptor = {
  priority: 0,
  match: () => true,
  Editor: PlainCodeEditor,
};

const commandBridgePlugin = realmPlugin<{
  register: (controller: FormatController) => void;
}>({
  postInit(realm, params) {
    params?.register({
      format(action) {
        switch (action) {
          case "format-bold":
            realm.pub(applyFormat$, "bold");
            break;
          case "format-italic":
            realm.pub(applyFormat$, "italic");
            break;
          case "format-h1":
          case "format-h2":
          case "format-h3":
            realm.pub(applyBlockType$, action.slice(-2) as "h1" | "h2" | "h3");
            break;
          case "format-link":
            realm.pub(openLinkEditDialog$, undefined);
            break;
          default:
            break;
        }
      },
    });
  },
});

function restoreTerminalLf(markdown: string, terminalLf: boolean): string {
  return terminalLf ? `${markdown.replace(/\n+$/, "")}\n` : markdown;
}

export function RichNoteEditor({
  document: source,
  body,
  sourceRelPath,
  onBodyChange,
  onFallback,
  onUndo,
  onRedo,
  noteIndex = [],
  onOpenLink,
  reportError,
}: Readonly<RichNoteEditorProps>) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const formatRef = useRef<FormatController>(null);
  const [overlayContainer] = useState(() => {
    const container = globalThis.document.createElement("div");
    container.className = "nn-rich-editor-overlays";
    return container;
  });
  const [editorReady, setEditorReady] = useState(false);
  const [editorMounted, setEditorMounted] = useState(false);
  const syncingRef = useRef(true);
  const terminalLfRef = useRef(
    source.body.endsWith("\n") && !source.body.endsWith("\n\n"),
  );
  const lastBodyRef = useRef(body);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;
  const noteIndexRef = useRef(noteIndex);
  noteIndexRef.current = noteIndex;
  const sourceRelPathRef = useRef(sourceRelPath);
  sourceRelPathRef.current = sourceRelPath;
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;

  const plugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin({ validateUrl: richLinkIsSafe }),
      // The preview is portaled outside our wrapper. MDXEditor prevents its
      // default navigation before calling us; only an existing, validated
      // vault-relative Markdown target may cross the in-app navigation seam.
      linkDialogPlugin({
        onClickLinkCallback: (url) => {
          if (!richLinkIsSafe(url)) return;
          const relPath = resolveMarkdownLink(
            url,
            noteIndexRef.current,
            sourceRelPathRef.current,
          );
          if (relPath !== null) onOpenLinkRef.current?.(relPath);
        },
      }),
      codeBlockPlugin({ codeBlockEditorDescriptors: [plainCodeDescriptor] }),
      markdownShortcutPlugin(),
      commandBridgePlugin({
        register: (controller) => {
          formatRef.current = controller;
        },
      }),
    ],
    [],
  );

  const assignEditor = useCallback((editor: MDXEditorMethods | null) => {
    editorRef.current = editor;
    setEditorMounted(editor !== null);
  }, []);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editorMounted || !editor) return;
    wrapperRef.current
      ?.querySelector<HTMLElement>('[contenteditable="true"]')
      ?.setAttribute("aria-label", "Note content");
    syncingRef.current = true;
    setEditorReady(false);
    let cancelled = false;
    void preflightMountedRichDocument(editor, source).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        onFallbackRef.current(result.message);
        return;
      }
      terminalLfRef.current = result.terminalLf;
      const latestBody = bodyRef.current;
      lastBodyRef.current = latestBody;
      const editableBody = result.terminalLf
        ? latestBody.replace(/\n$/, "")
        : latestBody;
      if (editor.getMarkdown() !== editableBody) {
        editor.setMarkdown(editableBody);
      }
      setEditorReady(true);
      queueMicrotask(() => {
        syncingRef.current = false;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [editorMounted, source]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editorReady || !editor || body === lastBodyRef.current) return;
    syncingRef.current = true;
    lastBodyRef.current = body;
    editor.setMarkdown(terminalLfRef.current ? body.replace(/\n$/, "") : body);
    queueMicrotask(() => {
      syncingRef.current = false;
    });
  }, [body, editorReady]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    globalThis.document.body.append(overlayContainer);
    // Cancel anchor navigation after MDXEditor has handled the interaction.
    // The dedicated overlay host keeps this scoped to this editor's portaled UI.
    const keepLinksInApp = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a")) {
        event.preventDefault();
      }
    };
    wrapper.addEventListener("click", keepLinksInApp);
    wrapper.addEventListener("auxclick", keepLinksInApp);
    wrapper.addEventListener("contextmenu", keepLinksInApp);
    overlayContainer.addEventListener("click", keepLinksInApp);
    overlayContainer.addEventListener("auxclick", keepLinksInApp);
    overlayContainer.addEventListener("contextmenu", keepLinksInApp);
    return () => {
      wrapper.removeEventListener("click", keepLinksInApp);
      wrapper.removeEventListener("auxclick", keepLinksInApp);
      wrapper.removeEventListener("contextmenu", keepLinksInApp);
      overlayContainer.removeEventListener("click", keepLinksInApp);
      overlayContainer.removeEventListener("auxclick", keepLinksInApp);
      overlayContainer.removeEventListener("contextmenu", keepLinksInApp);
      overlayContainer.remove();
    };
  }, [overlayContainer]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void api
      .onMenu((event) => {
        if (!event.action.startsWith("format-")) return;
        const wrapper = wrapperRef.current;
        if (!wrapper?.contains(globalThis.document.activeElement)) return;
        formatRef.current?.format(event.action);
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        console.error("failed to subscribe rich editor to format actions:", error);
        reportError?.(
          "Format menu actions are unavailable — keyboard formatting still works in the note.",
        );
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reportError]);

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    if (event.shiftKey) onRedo();
    else onUndo();
  };

  return (
    <div
      ref={wrapperRef}
      className="nn-rich-editor relative min-h-0 flex-1 overflow-y-auto rounded-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background"
      aria-busy={!editorReady}
      onKeyDownCapture={onKeyDownCapture}
      onBeforeInputCapture={(event) => {
        const inputType = (event.nativeEvent as InputEvent).inputType;
        if (inputType !== "historyUndo" && inputType !== "historyRedo") return;
        event.preventDefault();
        if (inputType === "historyUndo") onUndo();
        else onRedo();
      }}
    >
      {!editorReady && (
        <p className="absolute inset-x-6 top-6 text-sm text-muted-foreground" role="status">
          Checking Markdown compatibility…
        </p>
      )}
      <MDXEditor
        ref={assignEditor}
        markdown=""
        plugins={plugins}
        overlayContainer={overlayContainer}
        suppressHtmlProcessing
        suppressSharedHistory
        trim={false}
        spellCheck
        className={editorReady ? "min-h-full" : "invisible min-h-full"}
        contentEditableClassName="nn-rich-editor-content"
        placeholder="Start writing…"
        toMarkdownOptions={{ bullet: "-", rule: "-" }}
        onChange={(markdown) => {
          if (syncingRef.current || !editorReady) return;
          const nextBody = restoreTerminalLf(markdown, terminalLfRef.current);
          if (nextBody === lastBodyRef.current) return;
          lastBodyRef.current = nextBody;
          onBodyChange(nextBody);
        }}
        onError={() => {
          onFallback(
            "The rich editor could not parse this draft safely. Your text is kept in raw Markdown.",
          );
        }}
      />
    </div>
  );
}
