import type { TreeNode } from "../lib/types";

export interface NoteIndexEntry {
  relPath: string;
  stem: string;
}

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const textEncoder = new TextEncoder();

function normSep(path: string): string {
  return path.replaceAll("\\", "/");
}

function basename(path: string): string {
  const norm = normSep(path);
  return norm.slice(norm.lastIndexOf("/") + 1);
}

function stemOf(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function isMarkdownExt(ext: string | null): boolean {
  return ext !== null && MARKDOWN_EXTS.has(ext.toLowerCase());
}

function pushIndex(map: Map<string, string[]>, key: string, relPath: string): void {
  const list = map.get(key);
  if (list) list.push(relPath);
  else map.set(key, [relPath]);
}

function compareCoreRelPath(a: string, b: string): number {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  if (aBytes.length !== bBytes.length) return aBytes.length - bBytes.length;
  for (let i = 0; i < aBytes.length; i += 1) {
    if (aBytes[i] !== bBytes[i]) return aBytes[i] - bBytes[i];
  }
  return 0;
}

function pickShortest(candidates: string[]): string | null {
  return candidates.reduce<string | null>(
    (best, relPath) =>
      best === null || compareCoreRelPath(relPath, best) < 0 ? relPath : best,
    null,
  );
}

function byName(index: NoteIndexEntry[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of index) {
    const relPath = normSep(entry.relPath);
    pushIndex(map, entry.stem.toLowerCase(), relPath);
    pushIndex(map, basename(relPath).toLowerCase(), relPath);
  }
  return map;
}

function byRel(index: NoteIndexEntry[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of index) {
    const relPath = normSep(entry.relPath);
    pushIndex(map, relPath.toLowerCase(), relPath);
  }
  return map;
}

function cleanWikilinkTarget(target: string): string {
  return normSep(target.split(/[#|]/)[0]?.trim() ?? "");
}

function normalizeMarkdownHref(href: string): string | null {
  const target = normSep(href).trim().split("#")[0] ?? "";
  if (target === "" || target.startsWith("/") || URL_SCHEME_RE.test(target)) {
    return null;
  }
  const segs: string[] = [];
  for (const part of target.replaceAll("%20", " ").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segs.length === 0) return null;
      segs.pop();
    } else {
      segs.push(part);
    }
  }
  return segs.join("/");
}

function resolveRel(cand: string, relIndex: Map<string, string[]>): string | null {
  const list = relIndex.get(cand.toLowerCase());
  if (!list) return null;
  return list.find((relPath) => relPath === cand) ?? pickShortest(list);
}

function resolveMdRel(cand: string, relIndex: Map<string, string[]>): string | null {
  return resolveRel(cand, relIndex) ?? resolveRel(`${cand}.md`, relIndex);
}

export function buildNoteIndex(root: TreeNode): NoteIndexEntry[] {
  const out: NoteIndexEntry[] = [];
  const visit = (node: TreeNode): void => {
    if (node.kind === "folder") {
      for (const child of node.children ?? []) visit(child);
      return;
    }
    if (isMarkdownExt(node.ext)) {
      const relPath = normSep(node.relPath);
      out.push({ relPath, stem: stemOf(node.name).toLowerCase() });
    }
  };
  visit(root);
  return out;
}

export function resolveWikilink(
  target: string,
  index: NoteIndexEntry[],
): string | null {
  const cleaned = cleanWikilinkTarget(target);
  if (cleaned === "") return null;
  const t = cleaned.toLowerCase();
  if (t.includes("/")) {
    const wants = [t, `${t}.md`];
    const candidates = index
      .map((entry) => normSep(entry.relPath))
      .filter((relPath) => {
        const lower = relPath.toLowerCase();
        return wants.some((want) => lower === want || lower.endsWith(`/${want}`));
      });
    return pickShortest(candidates);
  }
  return pickShortest(byName(index).get(t) ?? []);
}

export function resolveMarkdownLink(
  href: string,
  index: NoteIndexEntry[],
): string | null {
  const cand = normalizeMarkdownHref(href);
  if (cand === null) return null;
  return resolveMdRel(cand, byRel(index));
}
