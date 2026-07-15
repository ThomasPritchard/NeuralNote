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
  open: (path: string) => void;
  reload: () => void;
  overwrite: () => Promise<void>;
  repath: (newPath: string, newRelPath?: string) => void;
  setDraft: (value: string) => void;
  setPreservationError: (message: string | null) => void;
  save: () => Promise<void>;
  clear: () => void;
}
