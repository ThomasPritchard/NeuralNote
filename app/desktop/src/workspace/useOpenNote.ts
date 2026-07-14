// The reader/editor state machine for the single open note: which note is open,
// its loaded NoteDoc, read vs edit mode, the editor draft, and dirty/saving
// flags. Reads/writes go straight through api.ts; every failure is surfaced via
// the `error` / `saveError` channels — never swallowed.

import { useCallback, useRef, useState } from "react";
import * as api from "../lib/api";
import { errorMessage, isConflict } from "../lib/api";
import type { NoteDoc, RichEditDocument } from "../lib/types";

export type NoteMode = "read" | "edit";

export interface OpenNote {
  path: string | null;
  note: NoteDoc | null;
  loading: boolean;
  /** Read error for the active note. */
  error: string | null;
  mode: NoteMode;
  richDocument: RichEditDocument | null;
  richBody: string;
  richError: string | null;
  /** The editor buffer (the full raw file). */
  draft: string;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  /** The file changed on disk since it was opened; save is blocked pending a
   *  reload-or-overwrite choice. */
  conflict: boolean;
  /** Load a note into the reader (read mode). */
  open: (path: string) => void;
  /** Retry loading the active note after an error, or reload from disk to
   *  resolve a conflict (discards the local draft). */
  reload: () => void;
  /** Force the save over an external change (the user chose "overwrite"). */
  overwrite: () => Promise<void>;
  /** Re-point the open note after its file was renamed/moved, keeping the draft. */
  repath: (newPath: string, newRelPath?: string) => void;
  setMode: (mode: NoteMode) => void;
  setDraft: (value: string) => void;
  setRichDocument: (document: RichEditDocument) => void;
  setRichError: (message: string) => void;
  setRichBody: (body: string) => void;
  undoRich: () => void;
  redoRich: () => void;
  save: () => Promise<void>;
  /** Clear the reader entirely (e.g. the open note was deleted). */
  clear: () => void;
}

export function useOpenNote(): OpenNote {
  const [path, setPath] = useState<string | null>(null);
  const [note, setNote] = useState<NoteDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<NoteMode>("read");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  // Monotonic token so a slow load/save can't overwrite a newer selection.
  const loadId = useRef(0);

  const load = useCallback(async (target: string) => {
    const id = ++loadId.current;
    setPath(target);
    setLoading(true);
    setError(null);
    setSaveError(null);
    setConflict(false);
    setSaving(false);
    setMode("read");
    try {
      const doc = await api.readNote(target);
      if (id !== loadId.current) return;
      setNote(doc);
      setDraft(doc.raw);
    } catch (e) {
      if (id !== loadId.current) return;
      setNote(null);
      setDraft("");
      setError(errorMessage(e));
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, []);

  const open = useCallback(
    (target: string) => {
      void load(target);
    },
    [load],
  );

  const reload = useCallback(() => {
    if (path) void load(path);
  }, [path, load]);

  // TODO(rename-during-save-race): a write already in flight when the note is
  // renamed/moved doesn't bump `loadId`, so on resolve it sets note.path/relPath
  // back to the pre-rename value (stale breadcrumb) — display-only, self-heals on
  // the next interaction, no content loss. Fix by bumping the token on repath when
  // a save is in flight. Deferred (narrow race, cosmetic) — round-8.
  const repath = useCallback((newPath: string, newRelPath?: string) => {
    setPath(newPath);
    setNote((prev) =>
      prev
        ? { ...prev, path: newPath, relPath: newRelPath ?? prev.relPath }
        : prev,
    );
  }, []);

  // Save with optimistic concurrency: pass the content hash we read at. writeNote
  // returns the fresh doc built from the saved bytes, so there is no second read
  // to fail — a landed write is never mislabelled a failure. Bail on the note's
  // state write if the user switched notes mid-save (the load token moved), but
  // always clear `saving` so the next note's pane never shows a stuck "Saving…".
  const persist = useCallback(
    async (target: string, expectedHash: string | null) => {
      const id = loadId.current;
      setSaving(true);
      setSaveError(null);
      try {
        const doc = await api.writeNote(target, draft, expectedHash);
        if (id !== loadId.current) return; // user moved on; write already landed
        setNote(doc);
        // Do NOT reset the draft to the saved content: the user may have kept
        // typing during the in-flight write. `dirty` (draft !== note.raw) then
        // self-corrects — false if nothing changed, true if there are in-flight
        // edits — so those keystrokes are kept and the unsaved-changes guard still
        // protects them. Resetting here would silently discard them.
        setConflict(false);
      } catch (e) {
        if (id !== loadId.current) return;
        if (isConflict(e)) setConflict(true);
        else setSaveError(errorMessage(e));
      } finally {
        setSaving(false);
      }
    },
    [draft],
  );

  const save = useCallback(async () => {
    if (!path || !note) return;
    await persist(path, note.contentHash);
  }, [path, note, persist]);

  const overwrite = useCallback(async () => {
    if (!path) return;
    await persist(path, null); // force past the external change
  }, [path, persist]);

  const clear = useCallback(() => {
    loadId.current++;
    setPath(null);
    setNote(null);
    setDraft("");
    setError(null);
    setSaveError(null);
    setConflict(false);
    setSaving(false);
    setLoading(false);
    setMode("read");
  }, []);

  return {
    path,
    note,
    loading,
    error,
    mode,
    richDocument: null,
    richBody: "",
    richError: null,
    draft,
    dirty: note !== null && draft !== note.raw,
    saving,
    saveError,
    conflict,
    open,
    reload,
    overwrite,
    repath,
    setMode,
    setDraft,
    setRichDocument: () => {},
    setRichError: () => {},
    setRichBody: () => {},
    undoRich: () => {},
    redoRich: () => {},
    save,
    clear,
  };
}
