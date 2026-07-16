// Link-graph mirror (crates/neuralnote-core/src/links.rs, mirrored 1:1).
// Each helper names the core function it mirrors; keep them in lockstep.

import type { Backlinks, GraphLink, GraphNode, LinkGraph } from "../lib/types";
import type { CoreErrorLike, MdFile } from "./mockVaultTypes";
import { basename, parseFrontmatter, stemOf, titleFrom } from "./mockVaultNotes";
import { buildSnippet, fold, foldLine, maskCode } from "./mockVaultText";

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
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

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

const bySourceThenLine = <T extends { sourceRel: string; line: number }>(a: T, b: T): number =>
  a.sourceRel === b.sourceRel ? a.line - b.line : a.sourceRel < b.sourceRel ? -1 : 1;

export const buildBacklinks = (files: MdFile[], targetRel: string): Backlinks => {
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

  linked.sort(bySourceThenLine);
  unlinked.sort(bySourceThenLine);
  return { linked, unlinked, skippedFiles: skipped.count };
};

/** Mirror of core `read_link_graph` (post-walk): a node per markdown note
 *  (orphans included), the resolution indices, and each note's deduped raw
 *  targets built in ONE walk; targets then resolve against the full note set,
 *  self-links drop, and edges dedupe on the unordered pair (NUL-joined —
 *  relPaths can contain spaces, so a printable join would be ambiguous).
 *  `skippedFiles` is always 0 here — the in-memory FS can't fail per-file. */
const pushIndexEntry = (map: Map<string, string[]>, key: string, rel: string): void => {
  const list = map.get(key);
  if (list) list.push(rel);
  else map.set(key, [rel]);
};

export const buildLinkGraph = (files: MdFile[]): LinkGraph => {
  const nodes: GraphNode[] = [];
  const noteTargets: [string, RawTarget[]][] = [];
  // Lowercased stem AND filename → relPaths, for `[[target]]` ± `.md`.
  const byName = new Map<string, string[]>();
  // Lowercased relPath → relPaths, for markdown-link resolution.
  const byRel = new Map<string, string[]>();
  let skippedFiles = 0;

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
    pushIndexEntry(byName, stem.toLowerCase(), f.rel);
    pushIndexEntry(byName, basename(f.rel).toLowerCase(), f.rel);
    pushIndexEntry(byRel, f.rel.toLowerCase(), f.rel);
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
