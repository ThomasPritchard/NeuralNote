// Pure helpers for the workspace: file-type metadata, tree aggregation, and
// path math. No React, no I/O — easy to reason about and reuse across the tree,
// reader, and status bar.

import { File, FileText, type LucideIcon } from "lucide-react";
import type { TreeNode } from "../lib/types";

/** Extensions we can usefully render as markdown. */
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

/** Extensions whose raw bytes are worth showing as plain text in a fallback. */
const TEXT_LIKE_EXTS = new Set([
  "md",
  "markdown",
  "mdx",
  "txt",
  "text",
  "json",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
  "log",
  "ini",
  "conf",
  "env",
  "html",
  "xml",
  "css",
  "scss",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rs",
  "go",
  "rb",
  "sh",
  "bash",
  "sql",
]);

/** Normalise OS path separators to `/` so comparisons work cross-platform
 *  (Rust emits OS-native `path`, which uses `\` on Windows). */
export function normSep(path: string): string {
  return path.replaceAll("\\", "/");
}

/** Lowercased extension (no dot) of a path or filename, or null if none. */
export function extFromPath(path: string): string | null {
  const norm = normSep(path);
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no dot, or a dotfile like ".gitignore"
  return base.slice(dot + 1).toLowerCase();
}

/** True when the file's extension is one we render as markdown. */
export function isMarkdownExt(ext: string | null): boolean {
  return ext !== null && MARKDOWN_EXTS.has(ext);
}

/** True when a (non-binary) file should be rendered with the markdown reader:
 *  the markdown extensions, plus extensionless text files like README/LICENSE. */
export function isMarkdownRenderable(ext: string | null): boolean {
  return ext === null || isMarkdownExt(ext);
}

/** True when a non-markdown file is still worth showing as raw text. */
export function isTextLikeExt(ext: string | null): boolean {
  return ext !== null && TEXT_LIKE_EXTS.has(ext);
}

/** A short human label for a file's kind, e.g. "Markdown" or ".PDF". */
export function extLabel(ext: string | null): string {
  if (ext === null || ext === "") return "File";
  if (isMarkdownExt(ext)) return "Markdown";
  return `.${ext.toUpperCase()}`;
}

/** The tree/reader icon for a node. Folders are handled separately. */
export function iconForFile(ext: string | null): LucideIcon {
  return isMarkdownExt(ext) ? FileText : File;
}

export interface TreeCounts {
  notes: number;
  folders: number;
}

/** Recursively count notes (markdown files) and folders across the whole tree.
 *  Attachments (images/PDFs/other files) are not notes, so they aren't counted. */
export function countTree(nodes: TreeNode[]): TreeCounts {
  return nodes.reduce<TreeCounts>(
    (acc, node) => {
      if (node.kind === "folder") {
        acc.folders += 1;
        const child = countTree(node.children ?? []);
        acc.notes += child.notes;
        acc.folders += child.folders;
      } else if (isMarkdownExt(node.ext)) {
        acc.notes += 1;
      }
      return acc;
    },
    { notes: 0, folders: 0 },
  );
}

/** Word count of a block of text (whitespace-delimited, empties dropped). */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

/** True when `child` is the same path as, or nested under, `parent`.
 *  Separator-agnostic so it holds on Windows (`\`) as well as POSIX (`/`). */
export function isPathInside(child: string, parent: string): boolean {
  const c = normSep(child);
  const p = normSep(parent);
  return c === p || c.startsWith(`${p}/`);
}

/** The vault-root-relative path of an absolute path — the key the lazy store's
 *  `loaded`/`expanded` maps use (`""` for the root itself). Separator-agnostic.
 *  A path that isn't under the root is returned normalised but unchanged (a
 *  defensive no-op — callers only pass in-vault paths). */
export function vaultRelPath(absPath: string, vaultRoot: string): string {
  const abs = normSep(absPath);
  const root = normSep(vaultRoot).replace(/\/+$/, "");
  if (abs === root) return "";
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
}

/** The parent directory of a vault-relative path, as a relPath (`""` = root).
 *  `"Notes/a.md" → "Notes"`, `"a.md" → ""`. Used to target the folder a lazy
 *  `refreshDir` must re-list after a CRUD op. */
export function parentRelPath(relPath: string): string {
  const rel = normSep(relPath);
  const slash = rel.lastIndexOf("/");
  return slash < 0 ? "" : rel.slice(0, slash);
}

/**
 * Re-point an open note's path after its file (or an ancestor folder) is moved
 * or renamed from `oldPath` to `newPath`. Returns the new path, or null when the
 * open note is unaffected.
 */
export function remapPath(
  active: string,
  oldPath: string,
  newPath: string,
): string | null {
  // Compare on normalised separators; slice the original (normalisation is
  // length-preserving, so oldPath.length is a valid offset into `active`).
  const a = normSep(active);
  const o = normSep(oldPath);
  if (a === o) return newPath;
  if (a.startsWith(`${o}/`)) {
    return `${newPath}${active.slice(oldPath.length)}`;
  }
  return null;
}
