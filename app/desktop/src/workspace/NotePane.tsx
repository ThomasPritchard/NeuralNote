// The main column: a toolbar (breadcrumb · save) with an in-place editor
// beneath. Owns the empty / loading / error presentation for
// the active note. State lives in the useOpenNote hook passed down from
// Workspace; the active-note tab itself lives in the window titlebar.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  FileText,
  Loader2,
  RotateCw,
  Save,
} from "lucide-react";
import * as api from "../lib/api";
import { cn } from "../lib/cn";
import { Editor } from "./Editor";
import type { NoteIndexEntry } from "./linkResolve";
import { NoteDocumentFrame, Reader, withoutRepeatedLeadingTitle } from "./Reader";
import type { OpenNote } from "./useOpenNote";

const RichNoteEditor = lazy(() =>
  import("./RichNoteEditor").then((module) => ({
    default: module.RichNoteEditor,
  })),
);

interface NotePaneProps {
  open: OpenNote;
  /** Vault note index — wikilink resolution (reader) + `[[` autocomplete (editor). */
  noteIndex?: NoteIndexEntry[];
  /** Open another vault note by relPath (the workspace's guarded open). */
  onOpenLink?: (relPath: string) => void;
  /** Surface a degraded-capability message (the store's reportError) —
   *  threaded through to the editor's menu subscription. */
  reportError?: (message: string) => void;
}

function SaveAnnouncements({
  notePath,
  dirty,
  saving,
  saveError,
  conflict,
}: Readonly<{
  notePath: string;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  conflict: boolean;
}>) {
  const [saveStatus, setSaveStatus] = useState("");
  const previousPathRef = useRef(notePath);
  const previousSavingRef = useRef(false);

  useEffect(() => {
    const noteChanged = previousPathRef.current !== notePath;
    if (noteChanged) {
      previousPathRef.current = notePath;
      previousSavingRef.current = false;
      setSaveStatus("");
    }

    if (saving) {
      setSaveStatus("Saving…");
    } else if (
      !noteChanged &&
      previousSavingRef.current &&
      !saveError &&
      !conflict
    ) {
      setSaveStatus("Saved.");
    } else if (dirty || saveError || conflict) {
      setSaveStatus("");
    }

    previousSavingRef.current = saving;
  }, [conflict, dirty, notePath, saveError, saving]);

  return (
    <>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {saveStatus}
      </p>
      <p aria-live="assertive" aria-atomic="true" className="sr-only">
        {saveError ? `Couldn't save: ${saveError}` : ""}
      </p>
    </>
  );
}

function RichSaveNotices({ open }: Readonly<{ open: OpenNote }>) {
  return (
    <>
      {open.conflict && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[0.75rem] text-warning"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            This note changed on disk since you opened it. Your edits are kept here.
          </span>
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={open.reload}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RotateCw className="size-3.5" aria-hidden /> Reload (discard edits)
            </button>
            <button
              type="button"
              onClick={() => void open.overwrite()}
              className="inline-flex items-center gap-1.5 rounded-md bg-warning/90 px-2.5 py-1 font-medium text-black transition-colors hover:bg-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning"
            >
              <Save className="size-3.5" aria-hidden /> Overwrite
            </button>
          </span>
        </div>
      )}
      {open.saveError && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[0.75rem] text-destructive">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="leading-snug">Couldn&apos;t save: {open.saveError}</span>
        </div>
      )}
    </>
  );
}

function TextNoteBody({
  open,
  noteIndex,
  onOpenLink,
  reportError,
}: Readonly<Required<Pick<NotePaneProps, "open">> & Omit<NotePaneProps, "open">>) {
  const note = open.note!;
  const rich = open.richDocument;
  const loadKeyRef = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const fallbackReason =
    open.richError ??
    (rich?.disposition.kind === "raw" ? rich.disposition.reason.message : null);
  const richReady = rich?.disposition.kind === "rich";
  const visibleBody = richReady ? open.richBody : open.draft;
  const richBodyOwnsDerivedTitle =
    richReady &&
    withoutRepeatedLeadingTitle(visibleBody, note.title) !== visibleBody;

  useEffect(() => {
    if (rich || open.richError) return;
    const loadKey = `${note.path}:${note.contentHash}`;
    if (loadKeyRef.current === loadKey) return;
    loadKeyRef.current = loadKey;
    let cancelled = false;
    void api.readRichNote(note.path).then(
      (document) => {
        if (!cancelled) openRef.current.setRichDocument(document);
      },
      (error: unknown) => {
        if (!cancelled) openRef.current.setRichError(api.errorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [note.contentHash, note.path, open.richError, rich]);

  const continueRaw = useCallback(
    (message: string) => openRef.current.setRichError(message),
    [],
  );

  return (
    <NoteDocumentFrame
      note={note}
      onOpenLink={onOpenLink}
      suppressTitle={richBodyOwnsDerivedTitle}
    >
      {fallbackReason && (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[0.75rem] text-warning"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{fallbackReason} Continue in raw Markdown; your source is unchanged.</span>
        </div>
      )}
      {richReady && <RichSaveNotices open={open} />}
      <div className="flex min-h-[50vh] flex-col">
        {richReady ? (
          <Suspense
            fallback={
              <p role="status" className="text-sm text-muted-foreground">
                Loading rich editor…
              </p>
            }
          >
            <RichNoteEditor
              document={rich}
              body={open.richBody}
              sourceRelPath={note.relPath}
              onBodyChange={open.setRichBody}
              onFallback={continueRaw}
              onUndo={open.undoRich}
              onRedo={open.redoRich}
              noteIndex={noteIndex}
              onOpenLink={onOpenLink}
              reportError={reportError}
            />
          </Suspense>
        ) : rich === null && fallbackReason === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking Markdown compatibility…
          </p>
        ) : (
          <Editor
            key={note.path}
            value={open.draft}
            onChange={open.setDraft}
            saveError={open.saveError}
            conflict={open.conflict}
            onOverwrite={() => void open.overwrite()}
            onReload={open.reload}
            noteIndex={noteIndex}
            reportError={reportError}
          />
        )}
      </div>
    </NoteDocumentFrame>
  );
}

export function NotePane({
  open,
  noteIndex,
  onOpenLink,
  reportError,
}: Readonly<NotePaneProps>) {
  if (!open.path) {
    return (
      <main className="grid flex-1 place-items-center bg-background">
        <div className="flex max-w-xs flex-col items-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-xl bg-card text-muted-foreground ring-1 ring-inset ring-border">
            <FileText className="size-5" aria-hidden />
          </span>
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
            Select a note from the sidebar, or create one to begin.
          </p>
        </div>
      </main>
    );
  }

  if (open.loading) {
    return (
      <main className="grid flex-1 place-items-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Loading note" />
      </main>
    );
  }

  if (open.error || !open.note) {
    return (
      <main className="grid flex-1 place-items-center bg-background px-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <AlertTriangle className="size-6 text-destructive" aria-hidden />
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
            {open.error ?? "This note couldn't be opened."}
          </p>
          <button
            type="button"
            onClick={open.reload}
            className="inline-flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-[0.8125rem] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <RotateCw className="size-3.5" aria-hidden /> Retry
          </button>
        </div>
      </main>
    );
  }

  const note = open.note;
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <SaveAnnouncements
        notePath={note.path}
        dirty={open.dirty}
        saving={open.saving}
        saveError={open.saveError}
        conflict={open.conflict}
      />
      {/* Toolbar — breadcrumb + view controls. Its border-b separates it from
          the note body; the hairline above is the titlebar's own border-b. */}
      <div className="flex h-(--note-toolbar-height) shrink-0 items-center justify-between gap-3 border-b border-border px-5 text-[0.75rem] text-muted-foreground">
        <div className="min-w-0 truncate" title={note.relPath}>
          {note.relPath}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!note.binary && (
            /* TODO(conflict-save-affordance): disable toolbar Save while
               open.conflict is true; Reload and Overwrite must be the only
               resolution actions. Add a focused regression. */
            <button
              type="button"
              onClick={() => void open.save()}
              disabled={!open.dirty || open.saving}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[0.75rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                !open.dirty || open.saving
                  ? "cursor-not-allowed bg-muted/50 text-muted-foreground"
                  : "bg-primary text-primary-foreground hover:opacity-90",
              )}
            >
              {open.saving ? (
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Save className="size-3.5" aria-hidden />
              )}
              {open.saving ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>

      {/* Encoding warning — pane-level so it shows in BOTH read and edit mode.
          It matters most in edit mode, where saving would bake in replacement characters. */}
      {note.lossyText && (
        <div className="flex shrink-0 items-start gap-2 border-b border-warning/30 bg-warning/10 px-5 py-2 text-[0.75rem] text-warning">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="leading-snug">
            This note isn&apos;t valid UTF-8, so some characters couldn&apos;t be read
            and show as <code>{"\uFFFD"}</code>. Fix them before saving — saving replaces the
            unreadable characters permanently.
          </span>
        </div>
      )}

      {note.binary ? (
        <Reader note={note} noteIndex={noteIndex} onOpenLink={onOpenLink} />
      ) : (
        <TextNoteBody
          open={open}
          noteIndex={noteIndex}
          onOpenLink={onOpenLink}
          reportError={reportError}
        />
      )}
    </main>
  );
}
