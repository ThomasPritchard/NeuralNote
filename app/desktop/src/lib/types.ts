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
  /** Markdown files that couldn't be read and were skipped — surfaced, never
   *  silent. Always 0 from the mock backend (its in-memory FS can't fail
   *  per-file). */
  skippedFiles: number;
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
  /** Markdown files that couldn't be read: the node is kept (orphan-style),
   *  its links are skipped, and the failure is counted here — never silent.
   *  Always 0 from the mock backend (its in-memory FS can't fail per-file). */
  skippedFiles: number;
}

// ── Backlinks + templates ────────────────────────────────────────────────────

/** One resolved occurrence of a link pointing at the current note. */
export interface Backlink {
  sourceRel: string;
  sourceTitle: string;
  snippet: string;
  /** 1-based line number in the source note body. */
  line: number;
}

/** One note-title mention that does not already link the current note. */
export interface UnlinkedMention {
  sourceRel: string;
  sourceTitle: string;
  snippet: string;
  /** 1-based line number in the source note body. */
  line: number;
}

/** The Obsidian-style backlinks panel payload. */
export interface Backlinks {
  linked: Backlink[];
  unlinked: UnlinkedMention[];
  /** Markdown files that couldn't be read and were skipped. */
  skippedFiles: number;
}

/** One markdown template available for note creation. */
export interface TemplateInfo {
  /** Vault-relative path to the template file. */
  relPath: string;
  /** Display name, derived from the template file stem. */
  name: string;
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
    | "frontmatter"
    | "llm"
    | "localAi";
  message: string;
}

// ── AI: cited chat (chat / api_key_* commands) ───────────────────────────────

/** Whether an API key is configured, and the model that will be used. The key
 *  itself never crosses to the webview — only its presence and the model id. */
export interface ApiKeyStatus {
  hasKey: boolean;
  model: string;
}

export type ChatRole = "user" | "assistant";

/** One prior turn of the conversation, sent back with the next question so the
 *  model has context. System/tool turns are assembled in the Rust core. */
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/** A streamed event from a chat run — the Rust→UI contract (mirrors
 *  crates/neuralnote-core/src/ai/events.rs; serde `type`-tagged, camelCase).
 *  The UI renders the sequence as live steps: searching → reading → verifying →
 *  cited answer. A run always ends with `done` (success) or `error` (a surfaced
 *  failure), never silently. */
export type ChatEvent =
  | { type: "searching"; query: string }
  | { type: "retrieved"; query: string; hitCount: number }
  | { type: "reading"; relPath: string; startLine: number; endLine: number }
  | { type: "thinking"; delta: string }
  | { type: "verifying" }
  | { type: "citationDropped"; reason: string }
  | { type: "answer"; delta: string }
  | {
      type: "citation";
      /** The evidence handle the model cited (e.g. "e1"). */
      id: string;
      relPath: string;
      startLine: number;
      endLine: number;
      /** The verified quoted text — a verbatim substring of the source note. */
      text: string;
    }
  | {
      type: "coverage";
      searchedTerms: string[];
      notesRead: string[];
      truncated: boolean;
      skippedFiles: number;
    }
  | { type: "error"; message: string }
  | { type: "done" };

// ── AI: provider selection (local vs OpenRouter) ─────────────────────────────
// Mirrors crates/neuralnote-core/src/ai/{provider_config,local/*}.rs — serde
// camelCase, `status`/`type`-tagged enums. Kept in lockstep with the Rust types.

/** Which AI backend serves cited chat. `"openRouter"` = BYO API key; `"local"` =
 *  a bundled-Ollama model running on the user's machine. */
export type ProviderKind = "openRouter" | "local";

/** Provider-aware AI status (from `ai_status`). `activeProvider` is the *effective*
 *  provider — an existing key user with no explicit choice reads as `"openRouter"`,
 *  and `null` means nothing is set up yet (show the first-run picker). A pure config
 *  read: it never starts the sidecar or unlocks the keychain. */
export interface AiStatus {
  activeProvider: ProviderKind | null;
  openrouter: {
    hasKey: boolean;
    model: string;
  };
  local: {
    /** The chosen local model tag, or null if none is set up. */
    activeModelTag: string | null;
  };
}

/** Detected host hardware (macOS-first) driving the local-model recommendation. */
export interface HardwareSpec {
  totalRamBytes: number;
  cpuCores: number;
  cpuBrand: string;
  /** GPU label if detectable; null while GPU detection is deferred. */
  gpuLabel: string | null;
  /** e.g. "aarch64" / "x86_64". */
  arch: string;
  /** e.g. "macos" / "windows" / "linux". */
  os: string;
}

/** One curated, tool-calling-capable local model that MAY be installed. The
 *  allowlist is the source of truth for installability (it protects cited chat's
 *  tool-calling); the UI enriches each with live `HfModelMeta`. */
export interface CandidateModel {
  /** The Ollama library tag to pull/run, e.g. "qwen2.5:7b". */
  tag: string;
  /** Human-readable parameter count, e.g. "7.6B". */
  params: string;
  downloadBytes: number;
  minRamBytes: number;
  license: string;
  /** Hugging Face repo id for the transparency metadata lookup. */
  hfRepo: string;
}

/** The recommendation verdict for this machine (from `recommend_local_model`).
 *  `unsupported` carries the exact user-facing reason (e.g. weak specs, or a
 *  not-yet-supported platform). */
export type Recommendation =
  | {
      status: "supported";
      modelTag: string;
      params: string;
      estRamBytes: number;
      why: string;
    }
  | { status: "unsupported"; reason: string };

/** Live Hugging Face metadata shown for transparency. Every field is nullable —
 *  HF being unreachable is non-fatal; the caller treats a failed fetch as "no
 *  metadata", never a hard error. */
export interface HfModelMeta {
  id: string;
  downloads: number | null;
  likes: number | null;
  /** ISO-8601 timestamp string, or null. */
  lastModified: string | null;
  license: string | null;
}

/** A model already installed in the app-owned Ollama store (from
 *  `list_local_models`). */
export interface InstalledModel {
  tag: string;
  sizeBytes: number;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
}

/** A streamed event from a local-model download (mirrors
 *  crates/neuralnote-core/src/ai/local/pull.rs; serde `type`-tagged, camelCase).
 *  A pull always ends with exactly one terminal event — `success` or `error` —
 *  never silently. `percent` is the download %, present once totals are known. */
export type PullEvent =
  | {
      type: "progress";
      /** Ollama's phase label, e.g. "pulling manifest", "downloading …". */
      status: string;
      digest: string | null;
      completed: number | null;
      total: number | null;
      percent: number | null;
    }
  | { type: "success" }
  | { type: "error"; message: string };
