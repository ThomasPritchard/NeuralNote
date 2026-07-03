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
  CoreError,
  FileHit,
  GraphLink,
  GraphNode,
  LinkGraph,
  NoteDoc,
  RecentVault,
  SearchMatch,
  SearchResponse,
  TreeNode,
  Vault,
} from "../lib/types";

export const VAULT_ROOT = "/vault";
export const NEW_VAULT_PARENT = "/parent";

/** A thrown backend error, shaped exactly as a serialised `CoreError`. */
export interface CoreErrorLike {
  kind: CoreError["kind"];
  message: string;
}

/** A folder, or a file with its full raw contents. */
type Entry = { kind: "folder" } | { kind: "file"; content: string };

/** Seed nodes use vault-relative, `/`-joined paths (the UI's stable id). */
export type SeedEntry =
  | { kind: "folder"; relPath: string }
  | { kind: "file"; relPath: string; content?: string };

export interface CreateMockVaultOptions {
  /** Initial tree contents. Ancestor folders are auto-created. */
  seed?: SeedEntry[];
  /** Recent vaults shown on the welcome screen. */
  recents?: RecentVault[];
  /** What the "open existing" folder picker returns (null = cancelled). */
  pickFolder?: string | null;
  /** What the "new vault location" folder picker returns (null = cancelled). */
  pickNewLocation?: string | null;
}

export interface MockVault {
  /** Install the IPC + window mocks. Call before rendering <App/>. */
  install: () => void;
  /** Force a command to reject with the given error (until cleared). */
  setFailure: (cmd: string, error: CoreErrorLike) => void;
  clearFailure: (cmd: string) => void;
  /** Whether the OS window was actually destroyed (close path). */
  wasDestroyed: () => boolean;
  /** Ordered log of every command the app issued (for assertions/debugging). */
  readonly calls: readonly string[];
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

// ── Search mirror (specs/search-and-graph-view.md §Contract: search_vault) ───
// Offsets are Unicode CODE POINTS (`Array.from`), matching the Rust side's char
// (scalar-value) offsets — never UTF-16 units.

/** A markdown note handed to the search/graph mirrors. */
interface MdFile {
  path: string;
  rel: string;
  content: string;
}

const SEARCH_MAX_TOTAL = 200;
const SEARCH_MAX_PER_FILE = 50;
const SNIPPET_WINDOW = 200;

/** Lowercase one code point, keeping it a single code point (simple case
 *  folding). Multi-code-point expansions (e.g. İ → i̇) keep the original so
 *  match offsets never drift out of code-point space. */
const foldCp = (cp: string): string => {
  const lower = cp.toLowerCase();
  return Array.from(lower).length === 1 ? lower : cp;
};

const foldStr = (s: string): string => Array.from(s).map(foldCp).join("");

/** Non-overlapping, case-folded occurrences of `needle` in a line, both in
 *  code-point space. Returns [start, end) pairs. */
const findRanges = (lineCps: string[], needleCps: string[]): [number, number][] => {
  const ranges: [number, number][] = [];
  const hay = lineCps.map(foldCp);
  for (let i = 0; i + needleCps.length <= hay.length; ) {
    let hit = true;
    for (let j = 0; j < needleCps.length; j += 1) {
      if (hay[i + j] !== needleCps[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      ranges.push([i, i + needleCps.length]);
      i += needleCps.length;
    } else {
      i += 1;
    }
  }
  return ranges;
};

/** Clip a long line to a SNIPPET_WINDOW-code-point window centered on the
 *  first match, rebasing ranges into the window and dropping ones that fall
 *  outside it. Short lines pass through whole. */
const windowSnippet = (
  lineCps: string[],
  ranges: [number, number][],
): { snippet: string; ranges: [number, number][] } => {
  if (lineCps.length <= SNIPPET_WINDOW) {
    return { snippet: lineCps.join(""), ranges };
  }
  const center = Math.floor((ranges[0][0] + ranges[0][1]) / 2);
  const start = Math.max(
    0,
    Math.min(center - SNIPPET_WINDOW / 2, lineCps.length - SNIPPET_WINDOW),
  );
  const rebased = ranges
    .map(([s, e]): [number, number] => [
      Math.max(s - start, 0),
      Math.min(e - start, SNIPPET_WINDOW),
    ])
    .filter(([s, e]) => s < e);
  return {
    snippet: lineCps.slice(start, start + SNIPPET_WINDOW).join(""),
    ranges: rebased,
  };
};

/** Mirror of core search: markdown-only, case-insensitive over the raw text
 *  (frontmatter included), name/title matches ranked first, caps 50/file and
 *  200 total with `truncated`. Name-only hits carry `matches: []`. */
const searchFiles = (files: MdFile[], rawQuery: string): SearchResponse => {
  const query = rawQuery.trim();
  if (query === "") return { hits: [], truncated: false };
  const needle = Array.from(query).map(foldCp);
  const queryFolded = needle.join("");

  let truncated = false;
  const nameHits: FileHit[] = [];
  const contentHits: FileHit[] = [];
  for (const file of files) {
    const stem = stemOf(file.path);
    const parsed = parseFrontmatter(file.content);
    const title = titleFrom(parsed.frontmatter, parsed.body, stem);
    const nameMatch =
      foldStr(stem).includes(queryFolded) || foldStr(title).includes(queryFolded);

    const matches: SearchMatch[] = [];
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const lineCps = Array.from(lines[i]);
      const ranges = findRanges(lineCps, needle);
      if (ranges.length === 0) continue;
      if (matches.length >= SEARCH_MAX_PER_FILE) {
        truncated = true;
        break;
      }
      matches.push({ line: i + 1, ...windowSnippet(lineCps, ranges) });
    }

    if (!nameMatch && matches.length === 0) continue;
    const hit: FileHit = { path: file.path, relPath: file.rel, title, nameMatch, matches };
    (nameMatch ? nameHits : contentHits).push(hit);
  }

  // Apply the global cap in display order (name matches first).
  const hits = [...nameHits, ...contentHits];
  let budget = SEARCH_MAX_TOTAL;
  for (const hit of hits) {
    if (hit.matches.length > budget) {
      hit.matches = hit.matches.slice(0, budget);
      truncated = true;
    }
    budget -= hit.matches.length;
  }
  return { hits, truncated };
};

// ── Link-graph mirror (§Contract: read_link_graph) ───────────────────────────

const FENCED_BLOCK_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`]*`/g;
const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g;
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.\-]*:/;

/** Top-level folder of a relPath; "" for vault-root notes. */
const clusterOf = (rel: string): string =>
  rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "";

/** Obsidian's ambiguity rule: shortest relPath wins, then lexicographic. */
const pickShortest = (candidates: string[]): string | null => {
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (x, y) => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0),
  )[0];
};

/** Resolve a wikilink target: case-insensitive filename (with or without .md);
 *  path-qualified targets (containing /) match by relPath suffix at a segment
 *  boundary. */
const resolveWikilink = (target: string, files: MdFile[]): string | null => {
  const t = target.toLowerCase();
  const candidates = files
    .filter((f) => {
      const rel = f.rel.toLowerCase();
      if (t.includes("/")) {
        return (
          rel === t ||
          rel === `${t}.md` ||
          rel.endsWith(`/${t}`) ||
          rel.endsWith(`/${t}.md`)
        );
      }
      return basename(rel) === t || stemOf(rel) === t;
    })
    .map((f) => f.rel);
  return pickShortest(candidates);
};

/** Resolve a relative markdown-link target against the note's folder, with
 *  `../` handling. Null when it escapes the vault root or nothing matches. */
const resolveMdLink = (
  noteRel: string,
  target: string,
  files: MdFile[],
): string | null => {
  const segs = noteRel.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segs.length === 0) return null; // escapes the vault root
      segs.pop();
    } else {
      segs.push(part);
    }
  }
  const resolved = segs.join("/").toLowerCase();
  if (resolved === "") return null;
  const candidates = files
    .filter((f) => {
      const rel = f.rel.toLowerCase();
      return rel === resolved || rel === `${resolved}.md`;
    })
    .map((f) => f.rel);
  return pickShortest(candidates);
};

/** Mirror of core link extraction: nodes for every markdown note (orphans
 *  too); wikilinks + relative markdown links from the frontmatter-stripped
 *  body with code fences/spans masked; self-links dropped; unordered-pair
 *  dedupe; bridge = endpoints in different clusters. */
const buildLinkGraph = (files: MdFile[]): LinkGraph => {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const seen = new Set<string>();

  const addEdge = (source: string, target: string): void => {
    if (source === target) return; // self-link
    const key =
      source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source, target, bridge: clusterOf(source) !== clusterOf(target) });
  };

  for (const f of files) {
    const parsed = parseFrontmatter(f.content);
    nodes.push({
      id: f.rel,
      title: titleFrom(parsed.frontmatter, parsed.body, stemOf(f.rel)),
      cluster: clusterOf(f.rel),
    });

    // Obsidian ignores links inside fenced blocks and inline code spans.
    const masked = parsed.body
      .replace(FENCED_BLOCK_RE, " ")
      .replace(INLINE_CODE_RE, " ");

    for (const m of masked.matchAll(WIKILINK_RE)) {
      const target = m[1].split(/[#|]/)[0].trim();
      if (target === "") continue;
      const resolved = resolveWikilink(target, files);
      if (resolved !== null) addEdge(f.rel, resolved);
    }

    for (const m of masked.matchAll(MD_LINK_RE)) {
      let target = m[1];
      if (URL_SCHEME_RE.test(target) || target.startsWith("/")) continue;
      const hash = target.indexOf("#");
      if (hash !== -1) target = target.slice(0, hash);
      target = target.replace(/%20/g, " ");
      if (target === "") continue;
      const resolved = resolveMdLink(f.rel, target, files);
      if (resolved !== null) addEdge(f.rel, resolved);
    }
  }

  return { nodes, links };
};

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
    entries.set(abs, s.kind === "folder" ? { kind: "folder" } : { kind: "file", content: s.content ?? "" });
  }

  const fail = (kind: CoreErrorLike["kind"], message: string): never => {
    throw { kind, message } satisfies CoreErrorLike;
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
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return nodes;
  };

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
    if (!e || e.kind !== "file") fail("notFound", `${path} not found`);
    return e as Entry & { kind: "file" };
  };

  /** Every markdown note, sorted by relPath for deterministic hit/node order. */
  const markdownFiles = (): MdFile[] => {
    const files: MdFile[] = [];
    for (const [p, e] of entries) {
      if (e.kind === "file" && isMarkdownExt(extOf(p))) {
        files.push({ path: p, rel: relOf(p), content: e.content });
      }
    }
    return files.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
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
      case "read_tree":
        return childrenOf(root);
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
        const fileName = ensureMd((a.name as string).trim());
        const target = `${a.parentPath as string}/${fileName}`;
        if (entries.has(target)) fail("alreadyExists", `${fileName} already exists`);
        entries.set(target, { kind: "file", content: "" });
        return toNode(target);
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
        return undefined;
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
    wasDestroyed() {
      return destroyed;
    },
    calls,
  };
}
