// A stateful, in-memory stand-in for the Rust vault backend, driven through the
// real Tauri IPC boundary via `@tauri-apps/api/mocks`'s `mockIPC`. The whole
// point: render the REAL <App/> and let the genuine `src/lib/api.ts`,
// `src/lib/store.tsx`, and component tree run end-to-end, with this model
// mutating exactly as the real filesystem-backed core would across a multi-step
// journey (create → tree updates → open → edit → save → rename → move → delete).
//
// Every command name, argument shape (camelCase, as the JS side sends it), and
// return shape is mirrored 1:1 from the real seam:
//   - command names + arg keys ............ src/lib/api.ts / src-tauri/src/lib.rs
//   - TreeNode / NoteDoc / Vault shapes ... src/lib/types.ts (camelCase serde)
//   - create_note appends `.md`, rename keeps a markdown ext, folders-first sort,
//     title = frontmatter.title → first H1 → file stem ... crates/neuralnote-core
//   - search_vault (code-point offsets, snippet windows, caps) + read_link_graph
//     (wikilink/md-link resolution) ... specs/search-and-graph-view.md §Contract
//
// Events (`vault://tree-changed`, the window `tauri://close-requested`) and the
// window `destroy` are wired too: `mockIPC(..., { shouldMockEvents: true })`
// makes the built-in listener registry handle `plugin:event|*`, so `emit(...)`
// dispatches to the app's real subscriptions; `plugin:window|destroy` is the
// only window command the app issues and is recorded here.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type {
  AiStatus,
  ApiKeyStatus,
  Backlinks,
  CandidateModel,
  ChatEvent,
  CoreError,
  FileHit,
  GraphLink,
  GraphNode,
  HardwareSpec,
  HfModelMeta,
  InstalledModel,
  LinkGraph,
  NoteDoc,
  OpenRouterModelMenu,
  ProviderKind,
  PullEvent,
  ReasoningSupport,
  Recommendation,
  RecentVault,
  SearchMatch,
  SearchResponse,
  SkillListing,
  TemplateInfo,
  TreeNode,
  UndoReport,
  Vault,
  WorkspaceState,
  WorkspaceStateLoad,
} from "../lib/types";

export const VAULT_ROOT = "/vault";
export const NEW_VAULT_PARENT = "/parent";

/** The model `api_key_status` reports when a test doesn't override it — mirrors
 *  the core's locked default (`DEFAULT_MODEL`, neuralnote-core ai/orchestrator.rs).
 *  The frontend holds no copy: it takes the id solely from the `aiStatus` echo. */
export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4.5";

/** A thrown backend error, shaped exactly as a serialised `CoreError`. */
export interface CoreErrorLike {
  kind: CoreError["kind"];
  message: string;
}

/** A folder, or a file with its full raw contents. */
type Entry =
  | { kind: "folder" }
  | { kind: "file"; content: string; unreadable?: boolean };

/** Seed nodes use vault-relative, `/`-joined paths (the UI's stable id). */
export type SeedEntry =
  | { kind: "folder"; relPath: string }
  | { kind: "file"; relPath: string; content?: string; unreadable?: boolean };

export interface CreateMockVaultOptions {
  /** Initial tree contents. Ancestor folders are auto-created. */
  seed?: SeedEntry[];
  /** Recent vaults shown on the welcome screen. */
  recents?: RecentVault[];
  /** What the "open existing" folder picker returns (null = cancelled). */
  pickFolder?: string | null;
  /** What the "new vault location" folder picker returns (null = cancelled). */
  pickNewLocation?: string | null;
  /** The AI key status `api_key_status`/`ai_status` report. Defaults to a key
   *  present so a test lands straight in the chat view; pass `{ hasKey: false }`
   *  to exercise the first-run provider picker (and, through it, guided key
   *  setup). `model` defaults to {@link DEFAULT_CHAT_MODEL};
   *  `reasoningSupported` defaults to `"unknown"` (never probed → fail open). */
  apiKey?: {
    hasKey: boolean;
    model?: string;
    reasoning?: boolean;
    reasoningSupported?: ReasoningSupport;
    /** The verdict the `refresh_reasoning_support` probe *discovers and
     *  persists* when it runs, mirroring the real command (probe → persist →
     *  return). When set, the mount-time probe overwrites `reasoningSupported`
     *  with this — so a test can seed an initial `"unknown"` (chip fails open)
     *  and prove the probe is what drives it to `"unsupported"`. Left unset,
     *  the probe is a pure echo of the seeded verdict. */
    probedSupport?: ReasoningSupport;
  };
  /** The `ChatEvent` sequence the `chat` command streams to its Channel, in
   *  order, exactly as the Rust core would (searching → … → done | error).
   *  A script containing an `elicit` event pauses THERE, exactly as the Rust
   *  run parks on `UserPrompt::ask`: the remainder streams only after a valid
   *  `answer_elicitation`, and the `chat` invoke resolves (with its run id)
   *  once the script is drained. */
  chatScript?: ChatEvent[];
  /** Pause a scripted chat after this many frames until `cancel_chat_run`.
   *  The optional tail is then streamed as the backend's honest wind-down. */
  cancelChatAfterEvents?: number;
  cancelChatTail?: ChatEvent[];
  /** Test-only mirror of the implementation-authored folder picker that writes
   *  the selected route to `.neuralnote/profile.json`. */
  profileFolderElicitationId?: string;
  /** What `undo_skill_run` reports. Defaults to every note the run wrote
   *  deleting cleanly; seed explicit per-file outcomes (kept-edited, failed…)
   *  to exercise the report card's honesty about partial undos. */
  undoReport?: UndoReport;
  /** Fixed clock for template rendering. Defaults to the Rust test fixture time. */
  now?: Date;
  // ── Local-AI provider (ai_status / detect_hardware / recommend / pull / …) ──
  /** Explicit `active_provider` for `ai_status`. Defaults to the keyState
   *  derivation (`effective_provider`: key → "openRouter", else null). */
  activeProvider?: ProviderKind | null;
  /** The local model tag `ai_status` reports as active (drives the status pill). */
  localActiveTag?: string | null;
  /** What `detect_hardware` returns. Defaults to a capable Apple-Silicon spec. */
  hardware?: HardwareSpec;
  /** What `recommend_local_model` returns. Defaults to a "supported" verdict. */
  recommendation?: Recommendation;
  /** The curated catalogue `local_candidates` returns. Defaults to two models. */
  localCandidates?: CandidateModel[];
  /** Models already installed (`list_local_models`). Defaults to none. */
  installedModels?: InstalledModel[];
  /** The `PullEvent` stream `pull_local_model` replays (progress → success|error).
   *  Defaults to a short progress→success run; a successful run also marks the
   *  model installed, exactly as Ollama would. */
  pullScript?: PullEvent[];
  /** The streamed frames for the allowlisted skill-requirement installer. */
  requirementDownloadScript?: PullEvent[];
  /** HF metadata by hfRepo for `hf_model_metadata`. A repo with no entry makes the
   *  command reject, which the UI treats as "no metadata" (non-fatal by contract). */
  hfMeta?: Record<string, HfModelMeta>;
  /** The built-in skill catalogue `list_skills` reports (and `set_skill_enabled`
   *  mutates). Defaults to the fixture skill, enabled, with no requirements —
   *  mirroring the compiled-in registry. */
  skills?: SkillListing[];
}

/** One `chat` invoke as the backend received it — lets a journey assert the
 *  picker/chips actually fed `activeSkills` across the IPC boundary. */
export interface ChatCallRecord {
  prompt: string;
  activeSkills: readonly string[];
}

export interface MockVault {
  /** Install the IPC + window mocks. Call before rendering <App/>. */
  install: () => void;
  /** Force a command to reject with the given error (until cleared). */
  setFailure: (cmd: string, error: CoreErrorLike) => void;
  clearFailure: (cmd: string) => void;
  /** End the parked run as the shell's elicitation TIMEOUT would — per spec
   *  §3.4 the timeout ends the RUN, not the QUESTION. The question is retired
   *  unanswered (a late `answer_elicitation` on its id rejects notFound,
   *  exactly like the real dead-id path) and the script's remainder — the
   *  run-end tail the test scripted, e.g. an honest wind-down answer plus
   *  `done` — streams so the pending `chat` invoke resolves with its run id.
   *  The card must then render dormant-but-clickable. Throws if no
   *  elicitation is parked (a mis-scripted test must fail loudly). */
  expireElicitation: () => void;
  /** Whether the OS window was actually destroyed (close path). */
  wasDestroyed: () => boolean;
  /** Ordered log of every command the app issued (for assertions/debugging). */
  readonly calls: readonly string[];
  /** Every `chat` invoke, with the `activeSkills` it carried. */
  readonly chatCalls: readonly ChatCallRecord[];
  /** Folder persisted by the scripted unknown-scheme picker, if answered. */
  readonly profileFolder: string | null;
  /** Native YouTube timestamp opens, after the real frontend wrapper. */
  readonly openedYoutubeUrls: readonly string[];
}

// ── Path helpers (POSIX `/`, absolute paths keyed in the entries map) ─────────
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const parentOf = (p: string): string => p.slice(0, p.lastIndexOf("/"));

const extOf = (p: string): string | null => {
  const base = basename(p);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? null : base.slice(dot + 1).toLowerCase();
};

const stemOf = (p: string): string => {
  const base = basename(p);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

/** Ensure a note name ends in a markdown extension (mirrors the core). */
const ensureMd = (name: string): string => {
  const lower = name.toLowerCase();
  const ok =
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdx");
  return ok ? name : `${name}.md`;
};

const isMarkdownExt = (ext: string | null): boolean =>
  ext === "md" || ext === "markdown" || ext === "mdx";

/** Stable, deterministic fingerprint that changes with content (djb2). */
const hashContent = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return String(h);
};

// ── Minimal frontmatter parsing (mirrors crates/neuralnote-core/src/note.rs) ──
interface ParsedNote {
  frontmatter: Record<string, unknown> | null;
  frontmatterRaw: string | null;
  frontmatterError: string | null;
  body: string;
}

const stripQuotes = (s: string): string =>
  (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
    ? s.slice(1, -1)
    : s;

const parseScalarOrArray = (s: string): unknown => {
  if (s === "") return null;
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((x) => stripQuotes(x.trim()));
  }
  return stripQuotes(s);
};

const parseFrontmatter = (raw: string): ParsedNote => {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { frontmatter: null, frontmatterRaw: null, frontmatterError: null, body: raw };
  }
  const closed = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?([\s\S]*)$/.exec(raw);
  if (!closed) {
    return {
      frontmatter: null,
      frontmatterRaw: null,
      frontmatterError: "frontmatter block was opened with `---` but never closed",
      body: raw,
    };
  }
  const block = closed[1];
  const body = closed[2] ?? "";
  const obj: Record<string, unknown> = {};
  for (const line of block.split("\n").map((l) => l.trim())) {
    if (line === "" || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    obj[line.slice(0, idx).trim()] = parseScalarOrArray(line.slice(idx + 1).trim());
  }
  return {
    frontmatter: Object.keys(obj).length > 0 ? obj : null,
    frontmatterRaw: block,
    frontmatterError: null,
    body,
  };
};

const titleFrom = (
  frontmatter: Record<string, unknown> | null,
  body: string,
  stem: string,
): string => {
  const fmTitle = frontmatter?.title;
  if (typeof fmTitle === "string" && fmTitle.trim() !== "") return fmTitle.trim();
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.startsWith("# ")) {
      const h1 = t.slice(2).trim();
      if (h1 !== "") return h1;
    }
  }
  return stem;
};

// ── Search mirror (crates/neuralnote-core/src/search.rs, mirrored 1:1) ───────
// Offsets are Unicode CODE POINTS (`Array.from`), matching the Rust side's char
// (scalar-value) offsets — never UTF-16 units. Each helper below names the core
// function it mirrors; keep them in lockstep.

/** A markdown note handed to the search/graph mirrors. */
interface MdFile {
  path: string;
  rel: string;
  content: string;
  unreadable?: boolean;
}

const MAX_TOTAL_MATCHES = 200;
const MAX_MATCHES_PER_FILE = 50;
const SNIPPET_MAX_CHARS = 200;
const MAX_QUERY_CHARS = 256;
/** Mirror of core `tree.rs` DIR_LISTING_CAP (issue #40): the per-directory
 *  breadth cap for the DISPLAY `list_dir` path only. A folder with more than this
 *  many entries returns the first CAP plus a truncation count. */
const DIR_LISTING_CAP = 5_000;

/** Mirror of core `fold_char`: full per-char Unicode lowercasing (which may
 *  EXPAND, e.g. İ → i + combining dot) plus Greek final-sigma normalisation
 *  (ς → σ). Applied per code point, as core folds char-by-char — the
 *  whole-string context-sensitive final-sigma rule can't fire. */
const foldChar = (cp: string): string[] =>
  Array.from(cp.toLowerCase(), (c) => (c === "ς" ? "σ" : c));

/** Mirror of core `fold`. */
const fold = (s: string): string[] => Array.from(s).flatMap(foldChar);

/** Mirror of core `contains_folded`: whether folded `text` contains the
 *  folded query anywhere (overlap-agnostic — existence only). */
const containsFolded = (text: string, foldedQuery: string[]): boolean => {
  const folded = fold(text);
  for (let i = 0; i + foldedQuery.length <= folded.length; i += 1) {
    let hit = true;
    for (let j = 0; j < foldedQuery.length; j += 1) {
      if (folded[i + j] !== foldedQuery[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
};

/** Mirror of core `FoldedLine`/`fold_line`: the folded code points plus the
 *  original char index each folded code point came from (pushed once per
 *  emitted code point, so expansions like İ → 2 chars stay mapped). No byte
 *  bookkeeping — JS slices code-point arrays directly. */
interface FoldedLine {
  folded: string[];
  foldOrigin: number[];
}

const foldLine = (lineCps: string[]): FoldedLine => {
  const folded: string[] = [];
  const foldOrigin: number[] = [];
  for (let charIdx = 0; charIdx < lineCps.length; charIdx += 1) {
    for (const lc of foldChar(lineCps[charIdx])) {
      folded.push(lc);
      foldOrigin.push(charIdx);
    }
  }
  return { folded, foldOrigin };
};

/** Mirror of core `occurrences`, minus its scan cutoff: non-overlapping folded
 *  occurrences of the query, as folded-index ranges. Core stops scanning past
 *  `first_end + SNIPPET_MAX_CHARS` purely as an allocation bound — every
 *  occurrence it skips starts beyond the snippet window and is dropped by
 *  `buildSnippet` anyway, so outputs are identical. */
const findOccurrences = (folded: string[], query: string[]): [number, number][] => {
  const out: [number, number][] = [];
  let i = 0;
  while (i + query.length <= folded.length) {
    let hit = true;
    for (let j = 0; j < query.length; j += 1) {
      if (folded[i + j] !== query[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      out.push([i, i + query.length]);
      i += query.length;
    } else {
      i += 1;
    }
  }
  return out;
};

/** Mirror of core `build_snippet`: the whole line when short, else a
 *  SNIPPET_MAX_CHARS-wide window centered on the first match (clamped to the
 *  line). Ranges are rebased to the window; a range straddling a window edge
 *  is CLIPPED to its visible part, and only fully-outside ranges are dropped —
 *  so the first match always yields a range, even when wider than the window. */
const buildSnippet = (
  lineCps: string[],
  occs: [number, number][],
): { snippet: string; ranges: [number, number][] } => {
  if (lineCps.length <= SNIPPET_MAX_CHARS) {
    return { snippet: lineCps.join(""), ranges: occs };
  }
  const [a, b] = occs[0];
  const start = Math.min(
    Math.max(Math.floor((a + b) / 2) - SNIPPET_MAX_CHARS / 2, 0),
    lineCps.length - SNIPPET_MAX_CHARS,
  );
  const end = start + SNIPPET_MAX_CHARS;
  const ranges: [number, number][] = [];
  for (const [x, y] of occs) {
    const cx = Math.max(x, start);
    const cy = Math.min(y, end);
    if (cx < cy) ranges.push([cx - start, cy - start]);
  }
  return { snippet: lineCps.slice(start, end).join(""), ranges };
};

/** Mirror of core `match_line`: fold the line, find folded occurrences, map
 *  them back to original char ranges ([origin[i], origin[j-1] + 1)), and
 *  build the (possibly clipped) snippet. One SearchMatch per matching line;
 *  `lineNo` is 1-based. */
const matchLine = (
  line: string,
  lineNo: number,
  foldedQuery: string[],
): SearchMatch | null => {
  const lineCps = Array.from(line);
  const fl = foldLine(lineCps);
  const occs = findOccurrences(fl.folded, foldedQuery);
  if (occs.length === 0) return null;
  const orig = occs.map(([i, j]): [number, number] => [
    fl.foldOrigin[i],
    fl.foldOrigin[j - 1] + 1,
  ]);
  const { snippet, ranges } = buildSnippet(lineCps, orig);
  return { line: lineNo, snippet, ranges };
};

/** Mirror of core `scan_content`: keep at most `budget` matching lines; the
 *  bool is true iff at least one further matching line existed beyond the
 *  budget — the exact "did a cap clip anything" signal for `truncated`. */
const scanContent = (
  raw: string,
  foldedQuery: string[],
  budget: number,
): [SearchMatch[], boolean] => {
  const out: SearchMatch[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = matchLine(lines[i], i + 1, foldedQuery);
    if (m === null) continue;
    if (out.length >= budget) return [out, true];
    out.push(m);
  }
  return [out, false];
};

/** Mirror of core `search_vault` (post-walk): the raw text is searched with
 *  frontmatter included; the global budget is consumed IN WALK ORDER during
 *  the scan (a name-hit file walked after exhaustion keeps its hit but loses
 *  its content matches); name/title hits then rank before content-only hits,
 *  each group in walk order. Queries are truncated to MAX_QUERY_CHARS.
 *  `skippedFiles` is always 0 here — the in-memory FS can't fail per-file
 *  (setFailure covers whole-command failures). */
const searchFiles = (files: MdFile[], rawQuery: string): SearchResponse => {
  const trimmed = rawQuery.trim();
  if (trimmed === "") return { hits: [], truncated: false, skippedFiles: 0 };
  const capped = Array.from(trimmed).slice(0, MAX_QUERY_CHARS).join("");
  const foldedQuery = fold(capped);

  const nameHits: FileHit[] = [];
  const contentHits: FileHit[] = [];
  let total = 0;
  let truncated = false;
  let skippedFiles = 0;

  for (const file of files) {
    if (file.unreadable) {
      skippedFiles += 1;
      continue;
    }
    const stem = stemOf(file.path);
    const parsed = parseFrontmatter(file.content);
    const title = titleFrom(parsed.frontmatter, parsed.body, stem);
    // Name/title checks run for every file, even after the content budget is
    // exhausted — a name hit costs no match budget.
    const nameMatch =
      containsFolded(stem, foldedQuery) || containsFolded(title, foldedQuery);

    const budget = Math.min(MAX_MATCHES_PER_FILE, MAX_TOTAL_MATCHES - total);
    const [matches, clipped]: [SearchMatch[], boolean] =
      budget === 0 && truncated
        ? [[], false] // budget gone and truncation already known — skip the scan
        : scanContent(file.content, foldedQuery, budget);
    truncated = truncated || clipped;
    total += matches.length;

    if (nameMatch || matches.length > 0) {
      const hit: FileHit = { path: file.path, relPath: file.rel, title, nameMatch, matches };
      (nameMatch ? nameHits : contentHits).push(hit);
    }
  }
  return { hits: [...nameHits, ...contentHits], truncated, skippedFiles };
};

// ── Link-graph mirror (crates/neuralnote-core/src/links.rs, mirrored 1:1) ────
// Each helper names the core function it mirrors; keep them in lockstep.

/** Mirror of core `RawTarget`: a raw link target as written in a note, before
 *  resolution — wiki and md targets resolve by different rules. */
interface RawTarget {
  kind: "wiki" | "md";
  value: string;
}

/** Mirror of core `cluster_of`: first path segment; "" for root-level notes. */
const clusterOf = (rel: string): string => {
  const i = rel.indexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
};

/** Mirror of core `fence_marker`: the leading code-fence run of a line
 *  (``` or ~~~, length ≥ 3), if any. */
const fenceMarker = (line: string): [string, number] | null => {
  const trimmed = line.trimStart();
  const first = trimmed.charAt(0);
  if (first !== "`" && first !== "~") return null;
  let len = 1;
  while (len < trimmed.length && trimmed.charAt(len) === first) len += 1;
  return len >= 3 ? [first, len] : null;
};

/** Mirror of core `blank_keeping_newlines`: spaces, newline chars preserved
 *  so lines never shift. */
const blankKeepingNewlines = (line: string): string =>
  Array.from(line, (c) => (c === "\n" || c === "\r" ? c : " ")).join("");

/** Mirror of core `mask_fences`: fences are LINE-anchored (a mid-line ``` is
 *  not a fence), open with ≥3 backticks or tildes, and close only on a run of
 *  the SAME char at least as long (CommonMark) — a 3-backtick line inside a
 *  4-backtick fence is content, not a closer. An unclosed fence masks to the
 *  end of the body; opener, interior, and closer lines all mask. */
const maskFences = (body: string): string => {
  let out = "";
  let open: [string, number] | null = null;
  // split_inclusive('\n'): each piece keeps its trailing newline.
  for (const line of body.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    const marker = fenceMarker(line);
    let masked: boolean;
    if (open === null) {
      masked = marker !== null;
      if (marker !== null) open = marker;
    } else {
      if (marker !== null && marker[0] === open[0] && marker[1] >= open[1]) {
        open = null;
      }
      masked = true; // opener, interior, and closer lines all mask
    }
    out += masked ? blankKeepingNewlines(line) : line;
  }
  return out;
};

/** Mirror of core `backtick_run_len`. */
const backtickRunLen = (chars: string[], from: number): number => {
  let len = 0;
  while (from + len < chars.length && chars[from + len] === "`") len += 1;
  return len;
};

/** Mirror of core `find_closing_run`: the start of the next backtick run of
 *  EXACTLY `n`, if any. */
const findClosingRun = (chars: string[], from: number, n: number): number | null => {
  let i = from;
  while (i < chars.length) {
    if (chars[i] === "`") {
      const len = backtickRunLen(chars, i);
      if (len === n) return i;
      i += len;
    } else {
      i += 1;
    }
  }
  return null;
};

/** Mirror of core `mask_inline_spans`: whole-body backtick-run spans that may
 *  cross newlines — a run of N backticks closes on the next run of exactly N;
 *  an unmatched opener is copied literally; newlines preserved. */
const maskInlineSpans = (text: string): string => {
  const chars = Array.from(text);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== "`") {
      out += chars[i];
      i += 1;
      continue;
    }
    const openLen = backtickRunLen(chars, i);
    const closeStart = findClosingRun(chars, i + openLen, openLen);
    if (closeStart === null) {
      out += "`".repeat(openLen);
      i += openLen;
    } else {
      const spanEnd = closeStart + openLen;
      for (; i < spanEnd; i += 1) {
        out += chars[i] === "\n" || chars[i] === "\r" ? chars[i] : " ";
      }
    }
  }
  return out;
};

/** Mirror of core `mask_code`: fences first, then inline spans. */
const maskCode = (body: string): string => maskInlineSpans(maskFences(body));

/** Mirror of core `extract_wikilinks`: `[[t]]`, `[[t|alias]]`, `[[t#heading]]`,
 *  `[[t#heading|alias]]`; embeds (`![[t]]`) are caught by the same scan. The
 *  target is the part before the first `#` or `|`, trimmed. */
const extractWikilinks = (text: string, emit: (t: string, offset: number) => void): void => {
  let base = 0;
  let rest = text;
  for (;;) {
    const start = rest.indexOf("[[");
    if (start === -1) return;
    const open = base + start;
    const afterStart = open + 2;
    const after = text.slice(afterStart);
    const end = after.indexOf("]]");
    if (end === -1) return;
    const target = after.slice(0, end).split(/[#|]/)[0].trim();
    if (target !== "") emit(target, open);
    base = afterStart + end + 2;
    rest = text.slice(base);
  }
};

/** Mirror of core `extract_md_links`: `[text](target)` where the target is
 *  everything up to the first `)` — spaces included. `[[wikilinks]]` are
 *  skipped here (the wikilink scan owns them); image links (`![…](…)`) count. */
const extractMdLinks = (text: string, emit: (t: string, offset: number) => void): void => {
  let base = 0;
  let rest = text;
  for (;;) {
    const open = rest.indexOf("[");
    if (open === -1) return;
    const openAbs = base + open;
    const afterOpenAbs = openAbs + 1;
    const afterOpen = text.slice(afterOpenAbs);
    if (afterOpen.startsWith("[")) {
      base = afterOpenAbs + 1;
      rest = text.slice(base);
      continue;
    }
    const close = afterOpen.indexOf("]");
    if (close === -1) return;
    const afterCloseAbs = afterOpenAbs + close + 1;
    const afterClose = text.slice(afterCloseAbs);
    if (!afterClose.startsWith("(")) {
      base = afterCloseAbs;
      rest = text.slice(base);
      continue;
    }
    const parenAbs = afterCloseAbs + 1;
    const paren = afterClose.slice(1);
    const tEnd = paren.indexOf(")");
    if (tEnd === -1) return;
    emit(paren.slice(0, tEnd), openAbs);
    base = parenAbs + tEnd + 1;
    rest = text.slice(base);
  }
};

/** Mirror of core `has_scheme` (RFC 3986 scheme prefix). */
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.\-]*:/;

/** Mirror of core `normalize_md_target`: lexical resolution against the source
 *  note's folder. Null for external targets (scheme or absolute), empty
 *  targets, or `..` escaping the vault root. `%20` only — no general decoding. */
const normalizeMdTarget = (sourceRel: string, rawTarget: string): string | null => {
  const target = rawTarget.trim().split("#")[0];
  if (target === "" || target.startsWith("/") || URL_SCHEME_RE.test(target)) {
    return null;
  }
  const decoded = target.replace(/%20/g, " ");
  const segs = sourceRel.split("/");
  segs.pop(); // drop the source file name, keeping its folder
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segs.length === 0) return null; // escaping the root → not a vault link
      segs.pop();
    } else {
      segs.push(part);
    }
  }
  return segs.join("/");
};

/** Obsidian's ambiguity rule (core's `min_by`): shortest, then lexicographic. */
const pickShortest = (candidates: string[]): string | null => {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) =>
    c.length < best.length || (c.length === best.length && c < best) ? c : best,
  );
};

/** Mirror of core `resolve_wikilink`: filename targets match the lowercased
 *  stem/filename index; path-qualified targets (`[[folder/note]]`) match by
 *  case-insensitive, segment-aligned rel-path suffix, with or without `.md`. */
const resolveWikilink = (
  target: string,
  byName: Map<string, string[]>,
  allRels: string[],
): string | null => {
  const t = target.toLowerCase();
  let candidates: string[];
  if (t.includes("/")) {
    const wants = [t, `${t}.md`];
    candidates = allRels.filter((rel) => {
      const lower = rel.toLowerCase();
      return wants.some((w) => lower === w || lower.endsWith(`/${w}`));
    });
  } else {
    candidates = byName.get(t) ?? [];
  }
  return pickShortest(candidates);
};

/** Mirror of core `resolve_rel`: exact-case match wins, else the same
 *  shortest-then-lexicographic tiebreak (a case-sensitive filesystem can hold
 *  `Target.md` AND `target.md`, so the index is a list, never last-write-wins). */
const resolveRel = (cand: string, byRel: Map<string, string[]>): string | null => {
  const list = byRel.get(cand.toLowerCase());
  if (!list) return null;
  return list.find((r) => r === cand) ?? pickShortest(list);
};

/** Mirror of core `resolve_md_rel`: the candidate as written, else with `.md`
 *  appended (Obsidian resolves extensionless links). */
const resolveMdRel = (cand: string, byRel: Map<string, string[]>): string | null =>
  resolveRel(cand, byRel) ?? resolveRel(`${cand}.md`, byRel);

interface LinkResolutionIndex {
  byName: Map<string, string[]>;
  byRel: Map<string, string[]>;
  allRels: string[];
}

const pushIndex = (map: Map<string, string[]>, key: string, rel: string): void => {
  const list = map.get(key);
  if (list) list.push(rel);
  else map.set(key, [rel]);
};

/** Mirror of core `LinkResolutionIndex::from_files`. */
const buildLinkResolutionIndex = (files: MdFile[]): LinkResolutionIndex => {
  const byName = new Map<string, string[]>();
  const byRel = new Map<string, string[]>();
  const allRels: string[] = [];
  for (const file of files) {
    const stem = stemOf(file.rel);
    pushIndex(byName, stem.toLowerCase(), file.rel);
    pushIndex(byName, basename(file.rel).toLowerCase(), file.rel);
    pushIndex(byRel, file.rel.toLowerCase(), file.rel);
    allRels.push(file.rel);
  }
  return { byName, byRel, allRels };
};

const resolveRawTarget = (target: RawTarget, index: LinkResolutionIndex): string | null =>
  target.kind === "wiki"
    ? resolveWikilink(target.value, index.byName, index.allRels)
    : resolveMdRel(target.value, index.byRel);

const emitRawTargets = (
  sourceRel: string,
  masked: string,
  emit: (target: RawTarget, offset: number) => void,
): void => {
  extractWikilinks(masked, (target, offset) => {
    emit({ kind: "wiki", value: target }, offset);
  });
  extractMdLinks(masked, (target, offset) => {
    const rel = normalizeMdTarget(sourceRel, target);
    if (rel !== null) emit({ kind: "md", value: rel }, offset);
  });
};

/** Mirror of core `extract_targets`: a note's deduplicated raw targets from
 *  its masked body, insertion-ordered (dedupe DURING extraction). */
const extractTargets = (sourceRel: string, body: string): RawTarget[] => {
  const masked = maskCode(body);
  const seen = new Set<string>();
  const out: RawTarget[] = [];
  const add = (kind: RawTarget["kind"], value: string): void => {
    const key = `${kind}:${value}`; // kinds are prefix-free, so ':' is unambiguous
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, value });
    }
  };
  emitRawTargets(sourceRel, masked, (target) => {
    add(target.kind, target.value);
  });
  return out;
};

interface RawLinkOccurrence {
  target: RawTarget;
  line: number;
  snippet: string;
}

const rustLines = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split(/\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line.replace(/\r$/, ""));
};

const splitInclusiveLineParts = (text: string): { starts: number[]; lines: string[] } => {
  const starts: number[] = [];
  const lines: string[] = [];
  const pieces = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let offset = 0;
  for (const piece of pieces) {
    starts.push(offset);
    lines.push(piece.replace(/[\n\r]+$/g, ""));
    offset += piece.length;
  }
  if (starts.length === 0) {
    starts.push(0);
    lines.push("");
  }
  return { starts, lines };
};

const clipLineAround = (line: string, first: [number, number]): string =>
  buildSnippet(Array.from(line), [first]).snippet;

const occurrenceFor = (
  originalLines: string[],
  starts: number[],
  maskedLines: string[],
  target: RawTarget,
  offset: number,
): RawLinkOccurrence => {
  let idx = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] <= offset) idx = i;
    else break;
  }
  const line = originalLines[idx] ?? "";
  const start = starts[idx] ?? 0;
  const maskedLine = maskedLines[idx] ?? "";
  const col = Array.from(maskedLine.slice(0, Math.max(0, offset - start))).length;
  return {
    target,
    line: idx + 1,
    snippet: clipLineAround(line, [col, col + 1]),
  };
};

/** Mirror of core `extract_link_occurrences`: every raw link occurrence from a
 *  masked body, preserving line/snippet evidence for directional backlinks. */
const extractLinkOccurrences = (sourceRel: string, body: string): RawLinkOccurrence[] => {
  const masked = maskCode(body);
  const { starts, lines: maskedLines } = splitInclusiveLineParts(masked);
  const originalLines = rustLines(body);
  const out: RawLinkOccurrence[] = [];
  emitRawTargets(sourceRel, masked, (target, offset) => {
    out.push(occurrenceFor(originalLines, starts, maskedLines, target, offset));
  });
  return out;
};

interface NoteText {
  title: string;
  body: string;
}

const readNoteText = (file: MdFile, skipped: { count: number }): NoteText | null => {
  if (file.unreadable) {
    skipped.count += 1;
    return null;
  }
  const parsed = parseFrontmatter(file.content);
  return {
    title: titleFrom(parsed.frontmatter, parsed.body, stemOf(file.rel)),
    body: parsed.body,
  };
};

const isWordChar = (ch: string): boolean => ch === "_" || /^[\p{L}\p{N}]$/u.test(ch);

const hasWordBoundaries = (folded: string[], start: number, end: number): boolean => {
  const left = start === 0 || !(isWordChar(folded[start - 1]) && isWordChar(folded[start]));
  const right =
    end === folded.length || !(isWordChar(folded[end - 1]) && isWordChar(folded[end]));
  return left && right;
};

const titleMatchesInLine = (line: string, foldedTitle: string[]): [number, number][] => {
  const fl = foldLine(Array.from(line));
  const matches: [number, number][] = [];
  let i = 0;
  while (i + foldedTitle.length <= fl.folded.length) {
    const end = i + foldedTitle.length;
    let hit = true;
    for (let j = 0; j < foldedTitle.length; j += 1) {
      if (fl.folded[i + j] !== foldedTitle[j]) {
        hit = false;
        break;
      }
    }
    if (hit && hasWordBoundaries(fl.folded, i, end)) {
      matches.push([fl.foldOrigin[i], fl.foldOrigin[end - 1] + 1]);
      i = end;
    } else {
      i += 1;
    }
  }
  return matches;
};

const findTitleMentions = (body: string, title: string): [number, string][] => {
  const foldedTitle = fold(title.trim());
  if (foldedTitle.length === 0) return [];
  const masked = maskCode(body);
  const bodyLines = rustLines(body);
  const maskedLines = rustLines(masked);
  const mentions: [number, string][] = [];
  for (let idx = 0; idx < bodyLines.length && idx < maskedLines.length; idx += 1) {
    for (const match of titleMatchesInLine(maskedLines[idx], foldedTitle)) {
      mentions.push([idx + 1, clipLineAround(bodyLines[idx], match)]);
    }
  }
  return mentions;
};

const buildBacklinks = (files: MdFile[], targetRel: string): Backlinks => {
  const target = files.find((file) => file.rel === targetRel);
  if (!target) {
    throw { kind: "notFound", message: targetRel } satisfies CoreErrorLike;
  }

  const skipped = { count: 0 };
  const targetTitle = readNoteText(target, skipped)?.title ?? stemOf(target.rel);
  const resolver = buildLinkResolutionIndex(files);
  const linked: Backlinks["linked"] = [];
  const unlinked: Backlinks["unlinked"] = [];

  for (const file of files) {
    if (file.rel === targetRel) continue;
    const note = readNoteText(file, skipped);
    if (note === null) continue;

    const linkedBefore = linked.length;
    for (const occurrence of extractLinkOccurrences(file.rel, note.body)) {
      if (resolveRawTarget(occurrence.target, resolver) === targetRel) {
        linked.push({
          sourceRel: file.rel,
          sourceTitle: note.title,
          snippet: occurrence.snippet,
          line: occurrence.line,
        });
      }
    }

    if (linked.length === linkedBefore) {
      for (const [line, snippet] of findTitleMentions(note.body, targetTitle)) {
        unlinked.push({
          sourceRel: file.rel,
          sourceTitle: note.title,
          snippet,
          line,
        });
      }
    }
  }

  const bySourceThenLine = <T extends { sourceRel: string; line: number }>(a: T, b: T): number =>
    a.sourceRel === b.sourceRel ? a.line - b.line : a.sourceRel < b.sourceRel ? -1 : 1;
  linked.sort(bySourceThenLine);
  unlinked.sort(bySourceThenLine);
  return { linked, unlinked, skippedFiles: skipped.count };
};

// ── Template mirror (crates/neuralnote-core/src/templates.rs) ─────────────────

const DEFAULT_TEMPLATE_FOLDER = "Templates";
const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
const DEFAULT_TIME_FORMAT = "HH:mm";
const FALLBACK_TEMPLATE_FOLDERS = ["Templates", "_templates", "templates"];

interface TemplateSettings {
  folder: string;
  dateFormat: string;
  timeFormat: string;
}

const parseRelativePath = (raw: string): string | null => {
  const normalized = raw.trim().replace(/\\/g, "/");
  if (normalized === "" || normalized.startsWith("/")) return null;
  const out: string[] = [];
  for (const part of normalized.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    out.push(part);
  }
  return out.length === 0 ? null : out.join("/");
};

const two = (n: number): string => String(n).padStart(2, "0");

const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_SHORT = MONTH_LONG.map((name) => name.slice(0, 3));
const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const WEEKDAY_SHORT = WEEKDAY_LONG.map((name) => name.slice(0, 3));

const renderMomentToken = (rest: string, now: Date): [string, string] | null => {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const hours = now.getHours();
  const hour12 = hours % 12 || 12;
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const ampm = hours < 12 ? "AM" : "PM";
  const tokens: [string, string][] = [
    ["YYYY", String(year)],
    ["MMMM", MONTH_LONG[now.getMonth()]],
    ["dddd", WEEKDAY_LONG[now.getDay()]],
    ["MMM", MONTH_SHORT[now.getMonth()]],
    ["ddd", WEEKDAY_SHORT[now.getDay()]],
    ["YY", two(year % 100)],
    ["MM", two(month)],
    ["DD", two(day)],
    ["HH", two(hours)],
    ["hh", two(hour12)],
    ["mm", two(minutes)],
    ["ss", two(seconds)],
    ["M", String(month)],
    ["D", String(day)],
    ["H", String(hours)],
    ["h", String(hour12)],
    ["A", ampm],
  ];
  for (const [token, rendered] of tokens) {
    if (rest.startsWith(token)) return [token, rendered];
  }
  if (rest.startsWith("a")) return ["a", ampm.toLowerCase()];
  return null;
};

const formatMoment = (format: string, now: Date): string => {
  let out = "";
  let cursor = 0;
  while (cursor < format.length) {
    const rest = format.slice(cursor);
    if (rest.startsWith("[")) {
      const closeOffset = format.slice(cursor + 1).indexOf("]");
      if (closeOffset === -1) {
        out += rest;
        break;
      }
      const close = cursor + 1 + closeOffset;
      out += format.slice(cursor + 1, close);
      cursor = close + 1;
      continue;
    }
    const rendered = renderMomentToken(rest, now);
    if (rendered !== null) {
      out += rendered[1];
      cursor += rendered[0].length;
      continue;
    }
    const [ch] = Array.from(rest);
    out += ch;
    cursor += ch.length;
  }
  return out;
};

const renderObsidian = (inner: string, title: string, now: Date, settings: TemplateSettings): string | null => {
  const command = inner.trim();
  if (command === "title") return title;
  if (command === "date") return formatMoment(settings.dateFormat, now);
  if (command === "time") return formatMoment(settings.timeFormat, now);
  if (command.startsWith("date:")) return formatMoment(command.slice("date:".length).trim(), now);
  if (command.startsWith("time:")) return formatMoment(command.slice("time:".length).trim(), now);
  return null;
};

const parseQuoted = (input: string): string | null => {
  const quote = input.charAt(0);
  if (quote !== '"' && quote !== "'") return null;
  if (!input.endsWith(quote) || input.length < 2) return null;
  return input.slice(1, -1);
};

const parseOptionalFormat = (args: string): string | null =>
  parseQuoted(args) ??
  (() => {
    if (!args.startsWith("[") || !args.endsWith("]")) return null;
    return parseQuoted(args.slice(1, -1).trim());
  })();

const parseFormatCall = (command: string, name: string): string | undefined | null => {
  if (!command.startsWith(`${name}(`) || !command.endsWith(")")) return null;
  const args = command.slice(name.length + 1, -1).trim();
  if (args === "") return undefined;
  return parseOptionalFormat(args);
};

const shiftedDate = (now: Date, days: number): Date => {
  const shifted = new Date(now.getTime());
  shifted.setDate(shifted.getDate() + days);
  return shifted;
};

const renderTemplater = (inner: string, title: string, now: Date): string | null => {
  const command = inner.trim();
  if (command === "tp.file.title") return title;
  const nowFormat = parseFormatCall(command, "tp.date.now");
  if (nowFormat !== null) return formatMoment(nowFormat ?? DEFAULT_DATE_FORMAT, now);
  const tomorrowFormat = parseFormatCall(command, "tp.date.tomorrow");
  if (tomorrowFormat !== null) {
    return formatMoment(tomorrowFormat ?? DEFAULT_DATE_FORMAT, shiftedDate(now, 1));
  }
  const yesterdayFormat = parseFormatCall(command, "tp.date.yesterday");
  if (yesterdayFormat !== null) {
    return formatMoment(yesterdayFormat ?? DEFAULT_DATE_FORMAT, shiftedDate(now, -1));
  }
  const createdFormat = parseFormatCall(command, "tp.file.creation_date");
  if (createdFormat !== null) return formatMoment(createdFormat ?? DEFAULT_DATE_FORMAT, now);
  return null;
};

const renderTemplate = (
  content: string,
  title: string,
  now: Date,
  settings: TemplateSettings,
): string => {
  let out = "";
  let cursor = 0;
  while (cursor < content.length) {
    const nextObsidian = content.indexOf("{{", cursor);
    const nextTemplater = content.indexOf("<%", cursor);
    if (nextObsidian === -1 && nextTemplater === -1) {
      out += content.slice(cursor);
      break;
    }
    const useObsidian =
      nextObsidian !== -1 && (nextTemplater === -1 || nextObsidian <= nextTemplater);
    const start = useObsidian ? nextObsidian : nextTemplater;
    out += content.slice(cursor, start);
    const openLen = 2;
    const closeMarker = useObsidian ? "}}" : "%>";
    const afterOpen = start + openLen;
    const closeOffset = content.slice(afterOpen).indexOf(closeMarker);
    if (closeOffset === -1) {
      out += content.slice(start);
      break;
    }
    const close = afterOpen + closeOffset;
    const fullEnd = close + closeMarker.length;
    const full = content.slice(start, fullEnd);
    const inner = content.slice(afterOpen, close);
    const rendered = useObsidian
      ? renderObsidian(inner, title, now, settings)
      : renderTemplater(inner, title, now);
    out += rendered ?? full;
    cursor = fullEnd;
  }
  return out;
};

/** Mirror of core `read_link_graph` (post-walk): a node per markdown note
 *  (orphans included), the resolution indices, and each note's deduped raw
 *  targets built in ONE walk; targets then resolve against the full note set,
 *  self-links drop, and edges dedupe on the unordered pair (NUL-joined —
 *  relPaths can contain spaces, so a printable join would be ambiguous).
 *  `skippedFiles` is always 0 here — the in-memory FS can't fail per-file. */
const buildLinkGraph = (files: MdFile[]): LinkGraph => {
  const nodes: GraphNode[] = [];
  const noteTargets: [string, RawTarget[]][] = [];
  // Lowercased stem AND filename → relPaths, for `[[target]]` ± `.md`.
  const byName = new Map<string, string[]>();
  // Lowercased relPath → relPaths, for markdown-link resolution.
  const byRel = new Map<string, string[]>();
  let skippedFiles = 0;
  const push = (map: Map<string, string[]>, key: string, rel: string): void => {
    const list = map.get(key);
    if (list) list.push(rel);
    else map.set(key, [rel]);
  };

  for (const f of files) {
    const stem = stemOf(f.rel);
    const parsed = f.unreadable
      ? { frontmatter: null, body: "", frontmatterRaw: null, frontmatterError: null }
      : parseFrontmatter(f.content);
    if (f.unreadable) skippedFiles += 1;
    nodes.push({
      id: f.rel,
      title: titleFrom(parsed.frontmatter, parsed.body, stem),
      cluster: clusterOf(f.rel),
    });
    push(byName, stem.toLowerCase(), f.rel);
    push(byName, basename(f.rel).toLowerCase(), f.rel);
    push(byRel, f.rel.toLowerCase(), f.rel);
    noteTargets.push([f.rel, f.unreadable ? [] : extractTargets(f.rel, parsed.body)]);
  }
  const allRels = nodes.map((n) => n.id);

  const links: GraphLink[] = [];
  const seen = new Set<string>();
  for (const [source, targets] of noteTargets) {
    for (const t of targets) {
      const resolved =
        t.kind === "wiki"
          ? resolveWikilink(t.value, byName, allRels)
          : resolveMdRel(t.value, byRel);
      if (resolved === null || resolved === source) continue; // unresolved / self
      const key =
        source < resolved
          ? `${source}\u0000${resolved}`
          : `${resolved}\u0000${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        source,
        target: resolved,
        bridge: clusterOf(source) !== clusterOf(resolved),
      });
    }
  }
  return { nodes, links, skippedFiles };
};

// ── Chat Channel delivery (the `chat` command's streamed events) ─────────────
// `api.chat` passes a `@tauri-apps/api` `Channel` as the `onEvent` invoke arg.
// The public `invoke` hands args straight to `__TAURI_INTERNALS__.invoke`, which
// under `mockIPC` is `cb(cmd, args)` with NO serialisation — so the handler
// receives the LIVE Channel instance (not its `__CHANNEL__:id` string form).
//
// The Channel registered a callback via `transformCallback` on construction;
// under mockIPC that's `registerCallback`, which stores the closure in
// `window.__TAURI_INTERNALS__.callbacks` keyed by the numeric `channel.id` and
// exposes it through `runCallback(id, data)`. The Rust side delivers each event
// as a `{ index, message }` frame to that callback; the Channel's own ordering
// machinery then forwards `message` to the `onmessage` handler `api.chat` set
// (the pane's `applyEvent`). Driving it through `runCallback` — rather than
// poking `channel.onmessage` directly — exercises that real dispatch path.
interface TauriChannelLike {
  id: number;
}
interface TauriInternalsLike {
  runCallback?: (id: number, data: unknown) => void;
}

/** A per-stream sender that keeps its own `{ index, message }` sequence — the
 *  Channel's ordering machinery expects one monotonically increasing index per
 *  stream, so a script parked on an elicitation and resumed later must NOT
 *  restart at zero. Throws loudly if the channel isn't wired to the mock IPC —
 *  a dropped stream is never silent. */
const channelSender = (channel: unknown): ((message: unknown) => void) => {
  const id = (channel as TauriChannelLike | null)?.id;
  const runCallback = (window as unknown as {
    __TAURI_INTERNALS__?: TauriInternalsLike;
  }).__TAURI_INTERNALS__?.runCallback;
  if (typeof id !== "number" || !runCallback) {
    throw {
      kind: "io",
      message: "event channel is not wired to the mock IPC",
    } satisfies CoreErrorLike;
  }
  let nextIndex = 0;
  return (message) => {
    runCallback(id, { index: nextIndex, message });
    nextIndex += 1;
  };
};

/** Stream a scripted `ChatEvent[]` to the invoke's Channel exactly as the Rust
 *  core would: one in-order `{ index, message }` frame per event. */
const emitToChannel = (channel: unknown, events: readonly unknown[]): void => {
  const send = channelSender(channel);
  events.forEach(send);
};

// ── Local-AI defaults (a capable Apple-Silicon machine on the supported path) ──
const GIB = 1024 ** 3;

const DEFAULT_HARDWARE: HardwareSpec = {
  totalRamBytes: 16 * GIB,
  cpuCores: 8,
  cpuBrand: "Apple M2",
  gpuLabel: null,
  arch: "aarch64",
  os: "macos",
};

const DEFAULT_LOCAL_CANDIDATES: CandidateModel[] = [
  {
    tag: "llama3.2:3b",
    params: "3.2B",
    downloadBytes: 2_000_000_000,
    minRamBytes: 6_000_000_000,
    license: "Llama 3.2",
    hfRepo: "meta-llama/Llama-3.2-3B-Instruct",
  },
  {
    tag: "qwen2.5:7b",
    params: "7.6B",
    downloadBytes: 4_700_000_000,
    minRamBytes: 10_000_000_000,
    license: "Apache-2.0",
    hfRepo: "Qwen/Qwen2.5-7B-Instruct",
  },
];

const DEFAULT_RECOMMENDATION: Recommendation = {
  status: "supported",
  modelTag: "qwen2.5:7b",
  params: "7.6B",
  estRamBytes: 10_000_000_000,
  why: "Fits comfortably in your 11 GB of usable memory.",
};

/** Mirror of the compiled-in registry's fixture skill (`fixture_manifest`,
 *  crates/neuralnote-core/src/ai/skills.rs), enabled by default as it ships. */
const DEFAULT_SKILLS: SkillListing[] = [
  {
    id: "fixture-note-workflow",
    name: "Fixture note workflow",
    description: "Demonstrate progress, elicitation, and a guarded note write.",
    icon: "flask",
    enabled: true,
    requirements: [],
  },
];

/** A short, realistic pull: manifest → half → full → success. */
const DEFAULT_PULL_SCRIPT: PullEvent[] = [
  { type: "progress", status: "pulling manifest", digest: null, completed: null, total: null, percent: null },
  { type: "progress", status: "downloading", digest: "sha256:abc", completed: 2_350_000_000, total: 4_700_000_000, percent: 50 },
  { type: "progress", status: "downloading", digest: "sha256:abc", completed: 4_700_000_000, total: 4_700_000_000, percent: 100 },
  { type: "success" },
];

const DEFAULT_REQUIREMENT_DOWNLOAD_SCRIPT: PullEvent[] = [
  {
    type: "progress",
    status: "downloading",
    digest: null,
    completed: null,
    total: null,
    percent: null,
  },
  { type: "success" },
];

export function createMockVault(opts: CreateMockVaultOptions = {}): MockVault {
  let root = VAULT_ROOT;
  const entries = new Map<string, Entry>();
  const recents = opts.recents ?? [];
  const pickFolder = opts.pickFolder === undefined ? VAULT_ROOT : opts.pickFolder;
  const pickNewLocation =
    opts.pickNewLocation === undefined ? NEW_VAULT_PARENT : opts.pickNewLocation;
  const failures = new Map<string, CoreErrorLike>();
  const calls: string[] = [];
  let destroyed = false;
  let workspaceState: WorkspaceState = { openPaths: [], activePath: null };
  let profileFolder: string | null = null;
  const openedYoutubeUrls: string[] = [];
  const now = opts.now ?? new Date(2026, 0, 2, 15, 4, 5);

  // AI key state (mutated by save/clear, reported by api_key_status) + the chat
  // stream this vault replays. Both are per-test overridable via opts.
  const keyState = {
    hasKey: opts.apiKey?.hasKey ?? true,
    model: opts.apiKey?.model ?? DEFAULT_CHAT_MODEL,
    // Mirrors `ProviderConfig.reasoning`, whose serde default is false: reasoning
    // tokens are billed, so they are opt-in. Mutated by set_reasoning.
    reasoning: opts.apiKey?.reasoning ?? false,
    // Mirrors `ProviderConfig.cached_reasoning_support()`, which is "unknown"
    // until a model is probed — and "unknown" keeps the toggle enabled, so an
    // unprobed fixture fails open exactly as the real config does.
    reasoningSupported: opts.apiKey?.reasoningSupported ?? "unknown",
  };
  // The verdict the mount-time probe persists when it runs (see the option doc).
  const probedSupport = opts.apiKey?.probedSupport;
  const chatScript = opts.chatScript ?? [];

  // The built-in skill catalogue, deep-copied so `set_skill_enabled` mutates
  // backend state without aliasing the caller's fixture (mirrors the Rust
  // registry + `disabled_skills` config the real commands read and write).
  const skillsState: SkillListing[] = (opts.skills ?? DEFAULT_SKILLS).map(
    (s) => ({ ...s, requirements: s.requirements.map((r) => ({ ...r })) }),
  );

  // ── Skill-run state (run ids, one parked elicitation, the undo ledger) ─────
  // Mirrors the shell: `chat` resolves with a run id; an `elicit` frame parks
  // the stream exactly as `UserPrompt::ask` parks the Rust run (the remainder
  // plays only after a validated `answer_elicitation`); `undo_skill_run`
  // reports per-file outcomes over what the run actually wrote.
  const chatCalls: ChatCallRecord[] = [];
  const writtenByRun = new Map<string, string[]>();
  const completedChatRuns = new Set<string>();
  interface ParkedElicitation {
    id: string;
    offeredIds: ReadonlySet<string>;
    multiSelect: boolean;
    send: (message: unknown) => void;
    remainder: ChatEvent[];
    runId: string;
    /** Resolves the still-pending `chat` invoke with its run id. */
    finish: () => void;
  }
  let parkedElicitation: ParkedElicitation | null = null;
  interface PausedChat {
    send: (message: unknown) => void;
    runId: string;
    finish: () => void;
  }
  let pausedChat: PausedChat | null = null;
  let pendingRequirementDownload: {
    timer: ReturnType<typeof setTimeout>;
    send: (message: unknown) => void;
    finish: () => void;
  } | null = null;

  /** Play script events until the stream parks on an `elicit` (the elicit
   *  frame itself is emitted first) or drains, recording every `noteWritten`
   *  into the run's undo ledger. Calls `finish` only when the script drains —
   *  a parked run keeps its `chat` invoke pending, exactly like the shell. */
  const advanceChatScript = (
    send: (message: unknown) => void,
    events: ChatEvent[],
    runId: string,
    finish: () => void,
  ): void => {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      send(event);
      if (event.type === "noteWritten") {
        const written = writtenByRun.get(runId) ?? [];
        written.push(event.relPath);
        writtenByRun.set(runId, written);
      }
      if (event.type === "elicit") {
        parkedElicitation = {
          id: event.id,
          offeredIds: new Set(event.options.map((o) => o.id)),
          multiSelect: event.multiSelect,
          send,
          remainder: events.slice(i + 1),
          runId,
          finish,
        };
        return;
      }
    }
    finish();
  };

  // Local-AI provider state, mutated by set_active_provider / pull / delete and
  // reported by ai_status / list_local_models. `explicitProvider` mirrors the Rust
  // `ProviderConfig.active_provider`; `effectiveProvider` mirrors its
  // `effective_provider()` (a key with no explicit choice reads as OpenRouter).
  const aiState = {
    explicitProvider: (opts.activeProvider ?? null) as ProviderKind | null,
    localActiveTag: opts.localActiveTag ?? null,
    installed: [...(opts.installedModels ?? [])] as InstalledModel[],
  };
  const effectiveProvider = (): ProviderKind | null =>
    aiState.explicitProvider ?? (keyState.hasKey ? "openRouter" : null);

  /** Mirror of the core's `build_ai_status`: the effective provider (an explicit
   *  choice wins, else a stored key reads as "openRouter", else null — the
   *  first-run picker), plus each provider's own state. Shared by `ai_status` and
   *  `set_reasoning`, exactly as the Rust command pair shares the real one. */
  const buildAiStatus = (): AiStatus => ({
    activeProvider: effectiveProvider(),
    reasoningSupported: keyState.reasoningSupported,
    openrouter: {
      hasKey: keyState.hasKey,
      model: keyState.model,
      reasoning: keyState.reasoning,
    },
    local: { activeModelTag: aiState.localActiveTag },
  });

  const rankedOpenRouterModels = [
    ["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", 200_000],
    ["openai/gpt-5.2", "GPT-5.2", 400_000],
    ["google/gemini-2.5-pro", "Gemini 2.5 Pro", 1_048_576],
    ["anthropic/claude-opus-4.1", "Claude Opus 4.1", 200_000],
    ["openai/gpt-5-mini", "GPT-5 Mini", 400_000],
    ["deepseek/deepseek-v3.2", "DeepSeek V3.2", 163_840],
    ["x-ai/grok-4", "Grok 4", 256_000],
    ["qwen/qwen3-235b-a22b", "Qwen3 235B", 131_072],
    ["meta-llama/llama-4-maverick", "Llama 4 Maverick", 1_048_576],
    ["mistralai/mistral-large-2512", "Mistral Large", 262_144],
  ] as const;
  let offeredOpenRouterModels = new Set<string>();

  const buildOpenRouterMenu = (): OpenRouterModelMenu => {
    const models = rankedOpenRouterModels.map(([id, name, contextLength], index) => ({
      id,
      name,
      contextLength,
      rank: index + 1,
    }));
    offeredOpenRouterModels = new Set(models.map((model) => model.id));
    return {
      models,
      asOf: "2026-07-13",
      selectedModel: keyState.model,
      pinnedSelectedModel: offeredOpenRouterModels.has(keyState.model) ? null : keyState.model,
    };
  };

  const relOf = (p: string): string => p.slice(root.length + 1);

  const ensureAncestors = (absPath: string): void => {
    let parent = parentOf(absPath);
    while (parent.length > root.length) {
      if (!entries.has(parent)) entries.set(parent, { kind: "folder" });
      parent = parentOf(parent);
    }
  };

  for (const s of opts.seed ?? []) {
    const abs = `${root}/${s.relPath}`;
    ensureAncestors(abs);
    entries.set(
      abs,
      s.kind === "folder"
        ? { kind: "folder" }
        : { kind: "file", content: s.content ?? "", unreadable: s.unreadable },
    );
  }

  const fail = (kind: CoreErrorLike["kind"], message: string): never => {
    throw { kind, message } satisfies CoreErrorLike;
  };

  const normalizeAbsPath = (path: string): string => {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`;
  };

  const resolveVaultPath = (path: string): string => {
    const abs = normalizeAbsPath(path.startsWith("/") ? path : `${root}/${path}`);
    if (abs !== root && !abs.startsWith(`${root}/`)) {
      fail("outsideVault", path);
    }
    return abs;
  };

  // ── TreeNode serialisation (folders-first, then case-insensitive by name) ──
  const toNode = (path: string): TreeNode => {
    const entry = entries.get(path);
    if (entry?.kind === "folder") {
      return {
        kind: "folder",
        name: basename(path),
        path,
        relPath: relOf(path),
        ext: null,
        children: childrenOf(path),
      };
    }
    return {
      kind: "file",
      name: basename(path),
      path,
      relPath: relOf(path),
      ext: extOf(path),
      children: null,
    };
  };

  const childrenOf = (parent: string): TreeNode[] => {
    const nodes = [...entries.keys()]
      .filter((p) => parentOf(p) === parent)
      .map(toNode);
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      // Mirror of core tree.rs: `name.to_lowercase().cmp(...)` — plain
      // code-unit order on the lowercased names, NOT locale collation
      // (localeCompare ranks punctuation differently, e.g. "b-dir" vs "banana").
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (an < bn) return -1;
      return an > bn ? 1 : 0;
    });
    return nodes;
  };

  /** Mirror of core `list_dir` (issue #40): one directory's immediate children,
   *  non-recursively — folders come back with `children: null` (unloaded), same
   *  folders-first case-insensitive sort as `childrenOf`. */
  const shallowChildrenOf = (parent: string): TreeNode[] =>
    childrenOf(parent).map((node) =>
      node.kind === "folder" ? { ...node, children: null } : node,
    );

  const buildDoc = (path: string, raw: string): NoteDoc => {
    const parsed = parseFrontmatter(raw);
    return {
      path,
      relPath: relOf(path),
      title: titleFrom(parsed.frontmatter, parsed.body, stemOf(path)),
      frontmatter: parsed.frontmatter,
      frontmatterRaw: parsed.frontmatterRaw,
      frontmatterError: parsed.frontmatterError,
      body: parsed.body,
      raw,
      contentHash: hashContent(raw),
      binary: false,
      lossyText: false,
    };
  };

  /** Re-key `from` (and, for a folder, every descendant) to `to`, content intact. */
  const rekey = (from: string, to: string): void => {
    for (const key of [...entries.keys()]) {
      if (key === from) {
        entries.set(to, entries.get(key)!);
        entries.delete(key);
      } else if (key.startsWith(`${from}/`)) {
        entries.set(`${to}${key.slice(from.length)}`, entries.get(key)!);
        entries.delete(key);
      }
    }
  };

  const requireFile = (path: string): Entry & { kind: "file" } => {
    const e = entries.get(path);
    if (!e) throw { kind: "notFound", message: `${path} not found` } satisfies CoreErrorLike;
    if (e.kind !== "file") {
      throw { kind: "notFound", message: `${path} not found` } satisfies CoreErrorLike;
    }
    if (e.unreadable) throw { kind: "io", message: `${path} unreadable` } satisfies CoreErrorLike;
    return e;
  };

  const createNoteNode = (parentPath: string, name: string): TreeNode => {
    const fileName = ensureMd(name.trim());
    const target = `${parentPath}/${fileName}`;
    if (entries.has(target)) fail("alreadyExists", `${fileName} already exists`);
    entries.set(target, { kind: "file", content: "" });
    return toNode(target);
  };

  /** Mirror of core `markdown_files` + `collect_markdown` (tree.rs): every
   *  markdown note in TREE-WALK order — within each folder, subfolders first
   *  (recursed depth-first), then files, each group case-insensitive by name —
   *  so search hits and graph nodes inherit the read_tree scan order. */
  const markdownFiles = (): MdFile[] => {
    const out: MdFile[] = [];
    const collect = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.children !== null) {
          collect(node.children);
        } else if (isMarkdownExt(node.ext)) {
          const entry = entries.get(node.path);
          if (entry?.kind === "file") {
            out.push({
              path: node.path,
              rel: node.relPath,
              content: entry.content,
              unreadable: entry.unreadable,
            });
          }
        }
      }
    };
    collect(childrenOf(root));
    return out;
  };

  const topLevelTemplateFolder = (): string | null => {
    const matches: string[] = [];
    for (const [path, entry] of entries) {
      const name = basename(path);
      if (
        parentOf(path) === root &&
        entry.kind === "folder" &&
        FALLBACK_TEMPLATE_FOLDERS.some((wanted) => name.toLowerCase() === wanted.toLowerCase())
      ) {
        matches.push(name);
      }
    }
    matches.sort();
    return matches[0] ?? null;
  };

  const readObsidianTemplateConfig = (
    settings: TemplateSettings,
  ): string | null => {
    const entry = entries.get(`${root}/.obsidian/templates.json`);
    if (!entry || entry.kind !== "file" || entry.unreadable) return null;
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.dateFormat === "string" && obj.dateFormat.trim() !== "") {
        settings.dateFormat = obj.dateFormat;
      }
      if (typeof obj.timeFormat === "string" && obj.timeFormat.trim() !== "") {
        settings.timeFormat = obj.timeFormat;
      }
      return typeof obj.folder === "string" ? parseRelativePath(obj.folder) : null;
    } catch {
      return null;
    }
  };

  const inferTemplateSettings = (): TemplateSettings => {
    const settings: TemplateSettings = {
      folder: DEFAULT_TEMPLATE_FOLDER,
      dateFormat: DEFAULT_DATE_FORMAT,
      timeFormat: DEFAULT_TIME_FORMAT,
    };
    settings.folder =
      readObsidianTemplateConfig(settings) ??
      topLevelTemplateFolder() ??
      DEFAULT_TEMPLATE_FOLDER;
    return settings;
  };

  const existingTemplateFolder = (settings: TemplateSettings): string | null => {
    const folder = resolveVaultPath(settings.folder);
    return entries.get(folder)?.kind === "folder" ? folder : null;
  };

  const templateInfos = (): TemplateInfo[] => {
    const settings = inferTemplateSettings();
    const folder = existingTemplateFolder(settings);
    if (folder === null) return [];
    const out: TemplateInfo[] = [];
    const collect = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.children !== null) {
          collect(node.children);
        } else if (isMarkdownExt(node.ext)) {
          out.push({ relPath: node.relPath, name: stemOf(node.relPath) });
        }
      }
    };
    collect(childrenOf(folder));
    out.sort((a, b) => {
      const ar = a.relPath.toLowerCase();
      const br = b.relPath.toLowerCase();
      if (ar !== br) return ar < br ? -1 : 1;
      return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
    });
    return out;
  };

  const isSameOrInside = (candidate: string, folder: string): boolean =>
    candidate === folder || candidate.startsWith(`${folder}/`);

  const resolveTemplateFile = (settings: TemplateSettings, template: string): string => {
    const folder = existingTemplateFolder(settings);
    if (folder === null) {
      throw {
        kind: "notFound",
        message: `template folder not found: ${settings.folder}`,
      } satisfies CoreErrorLike;
    }
    const rel = parseRelativePath(template);
    if (rel === null) {
      throw {
        kind: "invalidName",
        message: "template path must be vault-relative",
      } satisfies CoreErrorLike;
    }
    const requested = resolveVaultPath(rel);
    if (!isSameOrInside(requested, folder)) {
      fail("invalidName", `template must be inside the template folder: ${relOf(folder)}`);
    }
    if (!isMarkdownExt(extOf(requested))) {
      fail("invalidName", "template must be a markdown file");
    }
    const entry = entries.get(requested);
    if (!entry) throw { kind: "notFound", message: `template not found: ${rel}` } satisfies CoreErrorLike;
    if (entry.kind !== "file") {
      throw { kind: "notFound", message: `template not found: ${rel}` } satisfies CoreErrorLike;
    }
    if (entry.unreadable) {
      throw { kind: "io", message: `${requested} unreadable` } satisfies CoreErrorLike;
    }
    return requested;
  };

  // ── The IPC handler: one stateful backend for the whole journey ───────────
  const handler = (cmd: string, payload?: InvokeArgs): unknown => {
    calls.push(cmd);

    if (cmd === "plugin:window|destroy") {
      destroyed = true;
      return null;
    }

    const failure = failures.get(cmd);
    if (failure) throw failure;

    const a = (payload ?? {}) as Record<string, unknown>;

    switch (cmd) {
      case "list_recent_vaults":
        return recents;
      case "pick_vault_folder":
        return pickFolder;
      case "pick_new_vault_location":
        return pickNewLocation;
      case "open_vault": {
        root = a.path as string;
        return { name: basename(root), path: root } satisfies Vault;
      }
      case "create_vault": {
        root = `${a.parentDir as string}/${a.name as string}`;
        return { name: a.name as string, path: root } satisfies Vault;
      }
      case "close_vault":
        return undefined;
      case "load_workspace_state":
        return {
          state: {
            openPaths: [...workspaceState.openPaths],
            activePath: workspaceState.activePath,
          },
          recoveredFromCorrupt: false,
          recoveryMessage: null,
        } satisfies WorkspaceStateLoad;
      case "save_workspace_state": {
        const next = a.state as WorkspaceState;
        workspaceState = {
          openPaths: [...next.openPaths],
          activePath: next.activePath,
        };
        return undefined;
      }
      case "reset_workspace_state":
        workspaceState = { openPaths: [], activePath: null };
        return {
          state: { openPaths: [], activePath: null },
          recoveredFromCorrupt: false,
          recoveryMessage: null,
        } satisfies WorkspaceStateLoad;
      case "set_menu_editing":
      case "set_chat_visible":
        return undefined;
      case "read_tree":
        return childrenOf(root);
      case "list_dir": {
        // The lazy DISPLAY path (issue #40): one directory's immediate children,
        // capped, with a truncation count — never a recursive walk. `path` is the
        // vault-relative folder ("" = root).
        const target = resolveVaultPath((a.path as string) ?? "");
        const all = shallowChildrenOf(target);
        return {
          entries: all.slice(0, DIR_LISTING_CAP),
          truncated: all.length > DIR_LISTING_CAP ? all.length - DIR_LISTING_CAP : null,
        };
      }
      case "read_note": {
        const path = a.path as string;
        return buildDoc(path, requireFile(path).content);
      }
      case "write_note": {
        const path = a.path as string;
        const content = a.content as string;
        const expected = (a.expectedHash ?? null) as string | null;
        const file = requireFile(path);
        if (expected !== null && hashContent(file.content) !== expected) {
          fail("conflict", "this note changed on disk since you opened it");
        }
        file.content = content;
        return buildDoc(path, content);
      }
      case "create_folder": {
        const target = `${a.parentPath as string}/${(a.name as string).trim()}`;
        if (entries.has(target)) fail("alreadyExists", `${basename(target)} already exists`);
        entries.set(target, { kind: "folder" });
        return toNode(target);
      }
      case "create_note": {
        return createNoteNode(a.parentPath as string, a.name as string);
      }
      case "rename_entry": {
        const path = a.path as string;
        const entry = entries.get(path);
        if (!entry) fail("notFound", `${path} not found`);
        const hadMd = entry!.kind === "file" && isMarkdownExt(extOf(path));
        const finalName = hadMd ? ensureMd((a.newName as string).trim()) : (a.newName as string).trim();
        const target = `${parentOf(path)}/${finalName}`;
        if (target !== path && entries.has(target)) fail("alreadyExists", `${finalName} already exists`);
        rekey(path, target);
        return toNode(target);
      }
      case "delete_entry": {
        const path = a.path as string;
        if (!entries.has(path)) fail("notFound", `${path} not found`);
        for (const key of [...entries.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) entries.delete(key);
        }
        return undefined;
      }
      case "search_vault":
        return searchFiles(markdownFiles(), a.query as string);
      case "read_link_graph":
        return buildLinkGraph(markdownFiles());
      case "read_backlinks": {
        const path = resolveVaultPath(a.path as string);
        return buildBacklinks(markdownFiles(), relOf(path));
      }
      case "list_templates":
        return templateInfos();
      case "create_note_from_template": {
        const parentPath = resolveVaultPath(a.parentPath as string);
        const name = a.name as string;
        const template = (a.template ?? null) as string | null;
        const settings = inferTemplateSettings();
        const templateContent =
          template === null
            ? null
            : requireFile(resolveTemplateFile(settings, template)).content;
        const node = createNoteNode(parentPath, name);
        if (templateContent !== null) {
          const file = requireFile(node.path);
          file.content = renderTemplate(templateContent, stemOf(node.name), now, settings);
        }
        return node;
      }
      // ── AI: cited chat (api_key_* + chat) ─────────────────────────────────
      case "api_key_status":
        return { hasKey: keyState.hasKey, model: keyState.model } satisfies ApiKeyStatus;
      case "ai_status":
        return buildAiStatus();
      case "openrouter_model_menu":
        return buildOpenRouterMenu();
      case "select_openrouter_model": {
        const model = a.model as string;
        if (!offeredOpenRouterModels.has(model)) {
          return fail("invalidName", "model was not offered by the current OpenRouter menu");
        }
        keyState.model = model;
        return buildAiStatus();
      }
      case "open_openrouter_rankings":
        return undefined;
      case "detect_hardware":
        return opts.hardware ?? DEFAULT_HARDWARE;
      case "recommend_local_model":
        return opts.recommendation ?? DEFAULT_RECOMMENDATION;
      case "local_candidates":
        return opts.localCandidates ?? DEFAULT_LOCAL_CANDIDATES;
      case "list_local_models":
        // The command starts the sidecar in the shell; here it just reports state.
        return aiState.installed;
      case "set_active_provider": {
        aiState.explicitProvider = a.provider as ProviderKind;
        if (a.localModelTag != null) aiState.localActiveTag = a.localModelTag as string;
        return undefined;
      }
      case "set_reasoning": {
        // Returns the persisted status, as the Rust command does — the toggle
        // renders this rather than re-reading, so a failed re-read can never show
        // "off" while the config says "on".
        keyState.reasoning = a.enabled as boolean;
        return buildAiStatus();
      }
      case "refresh_reasoning_support":
        // The capability probe. The real command probes the selected model over
        // the network, PERSISTS the verdict, and returns the freshly persisted
        // status. Mirror that write: when `probedSupport` is set, the probe
        // overwrites the cached verdict (so a test can start at "unknown" and
        // observe the flip); otherwise it echoes the seeded verdict. Drive the
        // fail-open path with `backend.setFailure("refresh_reasoning_support", …)`.
        if (probedSupport !== undefined) keyState.reasoningSupported = probedSupport;
        return buildAiStatus();
      case "hf_model_metadata": {
        const repo = a.hfRepo as string;
        const meta = (opts.hfMeta ?? {})[repo];
        // No entry → reject, exactly as an unreachable HF would; the UI treats it
        // as "no metadata" (non-fatal by contract).
        if (!meta) fail("localAi", `no Hugging Face metadata for ${repo}`);
        return meta;
      }
      case "delete_local_model": {
        const tag = a.tag as string;
        aiState.installed = aiState.installed.filter((m) => m.tag !== tag);
        if (aiState.localActiveTag === tag) aiState.localActiveTag = null;
        return undefined;
      }
      case "cancel_pull":
        // The stream is delivered synchronously below, so there's nothing in-flight
        // to interrupt here; a cancel is exercised via a pullScript ending in an
        // error frame. No-op, matching the fire-and-forget command.
        return undefined;
      case "pull_local_model": {
        const tag = a.tag as string;
        const script = opts.pullScript ?? DEFAULT_PULL_SCRIPT;
        emitToChannel(a.onEvent, script);
        // A successful pull leaves the model installed, exactly as Ollama would, so
        // the subsequent list_local_models / set_active_provider reflect it.
        const succeeded = script.some((e) => (e as PullEvent).type === "success");
        if (succeeded && !aiState.installed.some((m) => m.tag === tag)) {
          aiState.installed.push({
            tag,
            sizeBytes: 4_700_000_000,
            family: null,
            parameterSize: null,
            quantization: null,
          });
        }
        return undefined;
      }
      case "download_requirement": {
        const name = a.name as string;
        if (name !== "yt-dlp") {
          return fail("invalidName", `unknown requirement '${name}'`);
        }
        const script = opts.requirementDownloadScript ?? DEFAULT_REQUIREMENT_DOWNLOAD_SCRIPT;
        if (script.length === 0) return undefined;
        const send = channelSender(a.onEvent);
        if (pendingRequirementDownload !== null) {
          send({
            type: "error",
            message: "a skill requirement download is already in progress",
          } satisfies PullEvent);
          return undefined;
        }
        send(script[0]);
        if (script.length === 1) return undefined;
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            script.slice(1).forEach(send);
            pendingRequirementDownload = null;
            resolve();
          }, 50);
          pendingRequirementDownload = {
            timer,
            send,
            finish: resolve,
          };
        });
      }
      case "cancel_requirement_download": {
        const pending = pendingRequirementDownload;
        if (pending !== null) {
          clearTimeout(pending.timer);
          pending.send({
            type: "error",
            message: "Download cancelled.",
          } satisfies PullEvent);
          pendingRequirementDownload = null;
          pending.finish();
        }
        return undefined;
      }
      case "list_skills":
        // Fresh objects per call, exactly as serde would deserialise them —
        // callers must never end up sharing (or mutating) backend state.
        return skillsState.map((s) => ({
          ...s,
          requirements: s.requirements.map((r) => ({ ...r })),
        }));
      case "set_skill_enabled": {
        // Mirrors `set_skill_enabled_in` (commands/ai.rs): an unknown id is an
        // invalidName rejection; a valid write persists and returns the state
        // READ BACK from the store — a fresh post-write lookup, never the
        // request echoed — so if the store ever normalises a write, a frontend
        // that renders the request instead of the response fails the e2e.
        const id = a.id as string;
        const skill = skillsState.find((s) => s.id === id);
        if (!skill) return fail("invalidName", `unknown skill '${id}'`);
        skill.enabled = a.enabled as boolean;
        return skillsState.find((s) => s.id === id)!.enabled;
      }
      case "save_api_key": {
        // The key itself never crosses back; only presence + model are reported.
        keyState.hasKey = true;
        keyState.model = (a.model as string) || keyState.model;
        return undefined;
      }
      case "clear_api_key": {
        keyState.hasKey = false;
        return undefined;
      }
      case "chat": {
        // Replay the scripted stream through the real Channel, then resolve
        // with the run id — mirroring the Rust run that emits events, ends on
        // `done`/`error`, and returns the id `undo_skill_run` takes. A script
        // holding an `elicit` parks there; `answer_elicitation` resumes it.
        const runId = a.turnId as string;
        chatCalls.push({
          prompt: a.prompt as string,
          activeSkills: [...((a.activeSkills as string[] | undefined) ?? [])],
        });
        const send = channelSender(a.onEvent);
        return new Promise<string>((resolve) => {
          const finish = () => {
            completedChatRuns.add(runId);
            resolve(runId);
          };
          const pauseAfter = opts.cancelChatAfterEvents;
          if (pauseAfter !== undefined) {
            advanceChatScript(send, chatScript.slice(0, pauseAfter), runId, () => {
              pausedChat = { send, runId, finish };
            });
          } else {
            advanceChatScript(send, [...chatScript], runId, finish);
          }
        });
      }
      case "cancel_chat_run": {
        const turnId = a.turnId as string;
        const paused = pausedChat;
        if (paused === null || paused.runId !== turnId) {
          return {
            turnId,
            status: completedChatRuns.has(turnId) ? "alreadyCompleted" : "notCurrent",
          };
        }
        pausedChat = null;
        // The native command returns its typed acknowledgement as soon as the
        // exact run signal wins. Provider/skill wind-down happens afterwards;
        // scheduling the tail in the next task preserves that causal order and
        // prevents a terminal tail from clearing the active turn before the UI
        // can apply the matching `cancelled` outcome.
        setTimeout(() => {
          advanceChatScript(
            paused.send,
            opts.cancelChatTail ?? [],
            paused.runId,
            paused.finish,
          );
        }, 0);
        return { turnId, status: "cancelled" };
      }
      case "open_youtube_timestamp": {
        const value = a.url as string;
        const parsed = new URL(value);
        if (
          parsed.protocol !== "https:" ||
          parsed.hostname !== "youtu.be" ||
          !/^\/[A-Za-z0-9_-]{11}$/.test(parsed.pathname) ||
          !/^\d+$/.test(parsed.searchParams.get("t") ?? "")
        ) {
          return fail("invalidName", "YouTube timestamp URL is invalid");
        }
        openedYoutubeUrls.push(value);
        return undefined;
      }
      case "answer_elicitation": {
        // Validation mirrors the shell (skills/elicitation.rs `answer`):
        // invalid choices reject and LEAVE the question parked for a retry;
        // only a valid answer consumes it and resumes the run.
        const id = a.id as string;
        const choices = a.choices as string[];
        const parked = parkedElicitation;
        if (parked === null || parked.id !== id) {
          return fail(
            "notFound",
            `elicitation '${id}' is not live (it may have timed out or ended)`,
          );
        }
        if (!parked.multiSelect && choices.length !== 1) {
          return fail(
            "invalidName",
            `elicitation '${id}' is single-select and requires exactly one choice`,
          );
        }
        const chosen = new Set<string>();
        for (const choice of choices) {
          if (!parked.offeredIds.has(choice)) {
            return fail(
              "invalidName",
              `choice '${choice}' was not offered by elicitation '${id}'`,
            );
          }
          if (chosen.has(choice)) {
            return fail(
              "invalidName",
              `choice '${choice}' was supplied more than once for elicitation '${id}'`,
            );
          }
          chosen.add(choice);
        }
        if (id === opts.profileFolderElicitationId) {
          profileFolder = choices[0] ?? null;
        }
        parkedElicitation = null;
        advanceChatScript(parked.send, parked.remainder, parked.runId, parked.finish);
        return undefined;
      }
      case "undo_skill_run": {
        const runId = a.runId as string;
        const written = writtenByRun.get(runId);
        if (!written || written.length === 0) {
          return fail("notFound", `no undoable skill run '${runId}'`);
        }
        const report: UndoReport =
          opts.undoReport ??
          ({
            files: written.map((relPath) => ({
              relPath,
              status: "deleted",
              message: null,
            })),
          } satisfies UndoReport);
        // Mirror the shell: a fully terminal report consumes the run; any
        // failed file keeps it reserved so "Retry undo" can hit it again.
        if (!report.files.some((f) => f.status === "failed")) {
          writtenByRun.delete(runId);
        }
        return report;
      }
      case "move_entry": {
        const path = a.path as string;
        const newParent = a.newParentPath as string;
        if (!entries.has(path)) fail("notFound", `${path} not found`);
        if (newParent === path || newParent.startsWith(`${path}/`)) {
          fail("invalidName", "cannot move a folder into itself");
        }
        const target = `${newParent}/${basename(path)}`;
        if (entries.has(target)) fail("alreadyExists", `${basename(path)} already exists`);
        rekey(path, target);
        return toNode(target);
      }
      default:
        // Failures are never silent: an unmocked command must reject loudly,
        // not resolve undefined (which reads as silent empty success).
        // `plugin:event|*` never lands here — mockIPC({ shouldMockEvents })
        // intercepts those before this handler.
        return fail("io", `unknown command: ${cmd}`);
    }
  };

  return {
    install() {
      mockWindows("main");
      mockIPC(handler, { shouldMockEvents: true });
    },
    setFailure(cmd, error) {
      failures.set(cmd, error);
    },
    clearFailure(cmd) {
      failures.delete(cmd);
    },
    expireElicitation() {
      const parked = parkedElicitation;
      if (parked === null) {
        throw new Error("expireElicitation: no elicitation is parked");
      }
      // Retire the question FIRST (dead-id semantics for any late answer),
      // then let the run end: the remainder streams and `chat` resolves.
      parkedElicitation = null;
      advanceChatScript(parked.send, parked.remainder, parked.runId, parked.finish);
    },
    wasDestroyed() {
      return destroyed;
    },
    calls,
    chatCalls,
    get profileFolder() {
      return profileFolder;
    },
    openedYoutubeUrls,
  };
}
