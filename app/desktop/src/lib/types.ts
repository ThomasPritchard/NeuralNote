// TypeScript mirror of the Rust `neuralnote-core::model` types. Kept in lockstep
// with crates/neuralnote-core/src/model.rs — fields are camelCase by serde.

export type EntryKind = "folder" | "file";

/** An opened vault — a folder on disk. */
export interface Vault {
  name: string;
  path: string;
}

/** A node in the vault tree. Folders carry `children`; files carry `ext`. */
export interface TreeNode {
  kind: EntryKind;
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Vault-relative, `/`-joined — the stable id for the UI. */
  relPath: string;
  /** Lowercased extension without the dot (files only). */
  ext: string | null;
  /** Child nodes (folders only), folders-first then files. */
  children: TreeNode[] | null;
}

/** A note opened in the reader/editor. */
export interface NoteDoc {
  path: string;
  relPath: string;
  /** frontmatter `title` → first H1 → file stem. */
  title: string;
  /** Parsed YAML frontmatter, or null if absent/unparseable. */
  frontmatter: Record<string, unknown> | null;
  /** Raw frontmatter block between the `---` fences, if present. */
  frontmatterRaw: string | null;
  /** Set when a frontmatter block existed but failed to parse (never silent). */
  frontmatterError: string | null;
  /** Markdown body with the frontmatter stripped. */
  body: string;
  /** The entire file, verbatim. */
  raw: string;
  /** Stable content fingerprint at read — echoed on save for conflict detection. */
  contentHash: string;
  /** True for a binary attachment (image/PDF, or any non-`.md`/`.txt` file that
   *  isn't valid UTF-8). The backend returns it flagged with empty `body`/`raw`
   *  rather than erroring, so the reader can show its "preview not available" notice. */
  binary: boolean;
  /** True when a text note (`.md`/`.txt`) wasn't valid UTF-8 and was decoded
   *  lossily (e.g. a Windows-1252/Latin-1 note from a migrated vault). Content is
   *  shown, but some characters became `�`; the reader surfaces a notice. */
  lossyText: boolean;
}

/** A recently-opened vault, for the welcome screen. */
export interface RecentVault {
  name: string;
  path: string;
  /** Unix epoch milliseconds. */
  lastOpened: number;
}

/** The shape a `CoreError` takes when it crosses the Tauri boundary. */
export interface CoreError {
  kind:
    | "notFound"
    | "alreadyExists"
    | "outsideVault"
    | "invalidName"
    | "conflict"
    | "io"
    | "frontmatter";
  message: string;
}
