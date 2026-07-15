// The main column: a toolbar (breadcrumb · save) with an in-place editor
// beneath. Owns the empty / loading / error presentation for
// the active note. State lives in the useOpenNote hook passed down from
// Workspace; the active-note tab itself lives in the window titlebar.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  FileText,
  Loader2,
  RotateCw,
  Save,
} from "lucide-react";
import { cn } from "../lib/cn";
import type { NoteIndexEntry } from "./linkResolve";
import { NoteDocumentFrame, Reader } from "./Reader";
import { sourceTitleMode } from "./sourceDocumentTitle";
import type { OpenNote } from "./useOpenNote";

const SourceNoteEditor = lazy(() =>
  import("./SourceNoteEditor").then((module) => ({
    default: module.SourceNoteEditor,
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

function SaveNotices({ open }: Readonly<{ open: OpenNote }>) {
  return (
    <>
      {/* Deletion outranks the on-disk conflict notice: once the file is gone
          there's no newer disk version to reconcile, so the "changed on disk"
          alert would be contradictory. Show the deletion notice instead. */}
      {open.externalDeleted && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[0.75rem] text-warning"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="leading-snug">
            This note was deleted on disk. Your copy is kept here — save to restore it.
          </span>
        </div>
      )}
      {!open.externalDeleted && open.conflict && (
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
  const [previewError, setPreviewError] = useState<string | null>(null);
  const titleMode = sourceTitleMode(open.draft, {
    frontmatterError: Boolean(note.frontmatterError),
  });

  return (
    <NoteDocumentFrame
      note={note}
      onOpenLink={onOpenLink}
      suppressTitle={titleMode !== "external"}
    >
      <SaveNotices open={open} />
      {open.preservationError && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[0.75rem] text-destructive"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{open.preservationError}</span>
        </div>
      )}
      {previewError && (
        <div role="status" className="mb-4 text-[0.75rem] text-muted-foreground">
          Live preview is temporarily unavailable: {previewError}
        </div>
      )}
      <div className="flex min-h-[50vh] flex-col">
        <Suspense
          fallback={
            <p role="status" className="text-sm text-muted-foreground">
              Loading source editor…
            </p>
          }
        >
          <SourceNoteEditor
            sessionKey={open.sessionKey ?? note.path}
            loadedHash={open.sessionHash ?? note.contentHash}
            value={open.draft}
            onChange={open.setDraft}
            onPreservationError={open.setPreservationError}
            onPreviewError={setPreviewError}
            reportError={reportError}
            noteIndex={noteIndex}
            onOpenLink={onOpenLink}
            sourceRelPath={note.relPath}
            derivedTitle={titleMode === "placeholder" ? note.title : undefined}
          />
        </Suspense>
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
            <button
              type="button"
              onClick={() => void open.save()}
              disabled={!open.dirty || open.saving || open.conflict || Boolean(open.preservationError)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[0.75rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                !open.dirty || open.saving || open.conflict || Boolean(open.preservationError)
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

      {/* Saving a lossily decoded note bakes replacement characters into source. */}
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
