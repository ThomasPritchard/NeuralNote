// Edit mode: a deliberately plain textarea seeded with the full raw file. Cmd/Ctrl+S
// saves. Save errors are shown inline and the buffer is kept — edits are never
// lost silently. Rich editing is out of scope; this is the honest raw editor.
//
// The textarea is *uncontrolled* (`defaultValue` + onChange) so a multi-MB note
// doesn't pay an O(size) controlled re-render on every keystroke; dirty/draft
// state is still tracked via onChange. `defaultValue` seeds the buffer on mount
// and is enough because every disk-content swap that should replace the buffer
// (opening another note, reloading from disk) drops to read mode in useOpenNote,
// which unmounts this editor — so the next edit-mode mount re-seeds from the
// fresh draft. Save/overwrite keep it mounted, but the buffer already holds the
// saved bytes, so no re-seed is needed and the cursor stays put.

import { useEffect } from "react";
import { AlertTriangle, RotateCw, Save } from "lucide-react";

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saveError: string | null;
  /** The file changed on disk; save is blocked pending the user's choice. */
  conflict: boolean;
  /** Force-save over the external change. */
  onOverwrite: () => void;
  /** Reload from disk, discarding the local draft. */
  onReload: () => void;
}

export function Editor({
  value,
  onChange,
  onSave,
  saveError,
  conflict,
  onOverwrite,
  onReload,
}: EditorProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2.5 text-[12px] text-amber-300"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            This note changed on disk since you opened it. Your edits are kept here.
          </span>
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onReload}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RotateCw className="size-3.5" aria-hidden /> Reload (discard edits)
            </button>
            <button
              type="button"
              onClick={onOverwrite}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/90 px-2.5 py-1 font-medium text-black transition-colors hover:bg-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <Save className="size-3.5" aria-hidden /> Overwrite
            </button>
          </span>
        </div>
      )}
      {saveError && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-[12px] text-destructive">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="leading-snug">Couldn&apos;t save: {saveError}</span>
        </div>
      )}
      <textarea
        defaultValue={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label="Note source"
        className="nn-mono min-h-0 flex-1 resize-none bg-background px-6 py-6 text-[13px] leading-6 text-foreground/90 outline-none placeholder:text-muted-foreground/60"
        placeholder="Write in Markdown…"
      />
    </div>
  );
}
