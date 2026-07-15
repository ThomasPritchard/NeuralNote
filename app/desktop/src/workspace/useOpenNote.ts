import type { NoteDoc } from "../lib/types";

export interface OpenNote {
  sessionKey: string | null;
  sessionHash: string | null;
  path: string | null;
  note: NoteDoc | null;
  loading: boolean;
  error: string | null;
  draft: string;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  preservationError: string | null;
  conflict: boolean;
  /** True when the open note's file was removed on disk externally (deleted, or
   *  renamed out from under the tab). The note + draft are preserved; the reader
   *  surfaces this so an open note is never silently stale after a deletion. */
  externalDeleted: boolean;
  open: (path: string) => void;
  reload: () => void;
  overwrite: () => Promise<void>;
  repath: (newPath: string, newRelPath?: string) => void;
  setDraft: (value: string) => void;
  setPreservationError: (message: string | null) => void;
  save: () => Promise<void>;
  clear: () => void;
}
