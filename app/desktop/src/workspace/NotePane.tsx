// The main column: a single-note tab bar, a toolbar (breadcrumb · read/edit
// toggle · save), and the reader or editor beneath. Owns the empty / loading /
// error presentation for the active note. State lives in the useOpenNote hook
// passed down from Workspace.

import {
  AlertTriangle,
  Eye,
  FileText,
  Loader2,
  Pencil,
  RotateCw,
  Save,
  X,
} from "lucide-react";
import { cn } from "../lib/cn";
import { Editor } from "./Editor";
import { extFromPath, iconForFile } from "./fileMeta";
import { Reader } from "./Reader";
import type { OpenNote } from "./useOpenNote";

const EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

export function NotePane({ open, onClose }: { open: OpenNote; onClose: () => void }) {
  if (!open.path) {
    return (
      <main className="grid flex-1 place-items-center bg-background">
        <div className="flex max-w-xs flex-col items-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-xl bg-card text-muted-foreground ring-1 ring-inset ring-border">
            <FileText className="size-5" aria-hidden />
          </span>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
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
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {open.error ?? "This note couldn't be opened."}
          </p>
          <button
            type="button"
            onClick={open.reload}
            className="inline-flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <RotateCw className="size-3.5" aria-hidden /> Retry
          </button>
        </div>
      </main>
    );
  }

  const note = open.note;
  const TabIcon = iconForFile(extFromPath(note.path));
  // Binary attachments (non-UTF-8) have no editable text body — never enter edit
  // mode for them (the editor would be blank and a save would fail with a cryptic
  // UTF-8 error). Force read mode and hide the edit/save controls below.
  const editing = !note.binary && open.mode === "edit";

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      {/* Tab bar — single tab for v1. */}
      <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-sidebar">
        <div className="group flex max-w-64 items-center gap-1.5 border-r border-t-2 border-t-primary border-border bg-background px-3 text-[13px] text-foreground">
          <TabIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="truncate">{note.title}</span>
          {open.dirty && (
            <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unsaved changes" />
          )}
          <button
            type="button"
            aria-label="Close note"
            onClick={onClose}
            className="ml-1 grid size-4 shrink-0 place-items-center rounded text-muted-foreground opacity-60 transition hover:bg-muted hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {/* Toolbar — breadcrumb + view controls. */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border px-5 text-[12px] text-muted-foreground">
        <div className="nn-mono min-w-0 truncate" title={note.relPath}>
          {note.relPath}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {editing && (
            <button
              type="button"
              onClick={() => void open.save()}
              disabled={!open.dirty || open.saving}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
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
          {!note.binary && (
            <ModeToggle editing={editing} onSelect={(m) => open.setMode(m)} />
          )}
        </div>
      </div>

      {/* Encoding warning — pane-level so it shows in BOTH read and edit mode.
          It matters most in edit mode, where a save would bake the `�` in. */}
      {note.lossyText && (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-[12px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="leading-snug">
            This note isn&apos;t valid UTF-8, so some characters couldn&apos;t be read
            and show as <code>�</code>. Fix them before saving — saving replaces the
            unreadable characters permanently.
          </span>
        </div>
      )}

      {editing ? (
        <Editor
          value={open.draft}
          onChange={open.setDraft}
          onSave={() => void open.save()}
          saveError={open.saveError}
          conflict={open.conflict}
          onOverwrite={() => void open.overwrite()}
          onReload={open.reload}
        />
      ) : (
        <Reader note={note} />
      )}
    </main>
  );
}

function ModeToggle({
  editing,
  onSelect,
}: {
  editing: boolean;
  onSelect: (mode: "read" | "edit") => void;
}) {
  return (
    // <fieldset> is the native grouping element (replaces role="group"); the
    // border-0/m-0/p-0/min-w-0 resets strip the UA fieldset chrome so the toggle
    // looks identical. p-0.5 restores the original inner padding.
    <fieldset
      aria-label="View mode"
      className="m-0 flex min-w-0 items-center gap-0.5 rounded-md border-0 bg-muted/60 p-0.5"
    >
      <ToggleButton
        active={!editing}
        label="Read"
        icon={Eye}
        onClick={() => onSelect("read")}
      />
      <ToggleButton
        active={editing}
        label="Edit"
        icon={Pencil}
        onClick={() => onSelect("edit")}
      />
    </fieldset>
  );
}

function ToggleButton({
  active,
  label,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: typeof Eye;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
        EASE,
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}
