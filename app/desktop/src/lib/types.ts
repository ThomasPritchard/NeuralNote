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

// ── Search (search_vault) ────────────────────────────────────────────────────

/** One matching line within a file. */
export interface SearchMatch {
  /** 1-based line number in the file. */
  line: number;
  /** The matching line, clipped to a ~200-code-point window for long lines. */
  snippet: string;
  /** [start, end) match offsets into `snippet`, in Unicode CODE POINTS — the
   *  Rust side counts `char`s (scalar values), not UTF-16 units. Slice with
   *  `Array.from(snippet).slice(start, end)`, never `String.prototype.slice`
   *  (which counts UTF-16 units and drifts past any astral char, e.g. emoji). */
  ranges: [number, number][];
}

/** A file with search matches (by content, file name, or note title). */
export interface FileHit {
  /** Absolute path on disk (feeds the guarded open). */
  path: string;
  /** Vault-relative, `/`-joined — the stable id for the UI. */
  relPath: string;
  /** frontmatter `title` → first H1 → file stem (same rule as NoteDoc). */
  title: string;
  /** The query matched the file stem or title; such hits rank first, and a
   *  name-only hit (no content matches) carries `matches: []`. */
  nameMatch: boolean;
  matches: SearchMatch[];
}

export interface SearchResponse {
  hits: FileHit[];
  /** True when results were clipped by the caps (50 matches/file, 200 total). */
  truncated: boolean;
}

// ── Link graph (read_link_graph) ─────────────────────────────────────────────

/** A markdown note in the vault link graph (orphans included). */
export interface GraphNode {
  /** Vault-relative path — the stable id shared with TreeNode.relPath. */
  id: string;
  /** Same precedence rule as NoteDoc.title. */
  title: string;
  /** Top-level folder name; "" for vault-root notes. */
  cluster: string;
}

/** An undirected, deduped wikilink/markdown-link edge between two notes. */
export interface GraphLink {
  /** GraphNode ids (relPaths). */
  source: string;
  target: string;
  /** True when the endpoints live in different clusters (cross-folder link). */
  bridge: boolean;
}

export interface LinkGraph {
  nodes: GraphNode[];
  links: GraphLink[];
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
