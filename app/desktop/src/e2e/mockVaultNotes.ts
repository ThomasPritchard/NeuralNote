// Path helpers and minimal frontmatter parsing, mirroring
// crates/neuralnote-core/src/note.rs. Pure functions shared by the search,
// link-graph, template, and dispatch layers.

// ── Path helpers (POSIX `/`, absolute paths keyed in the entries map) ─────────
export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export const parentOf = (p: string): string => p.slice(0, p.lastIndexOf("/"));

export const extOf = (p: string): string | null => {
  const base = basename(p);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? null : base.slice(dot + 1).toLowerCase();
};

export const stemOf = (p: string): string => {
  const base = basename(p);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

/** Ensure a note name ends in a markdown extension (mirrors the core). */
export const ensureMd = (name: string): string => {
  const lower = name.toLowerCase();
  const ok =
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdx");
  return ok ? name : `${name}.md`;
};

export const isMarkdownExt = (ext: string | null): boolean =>
  ext === "md" || ext === "markdown" || ext === "mdx";

/** Stable, deterministic fingerprint that changes with content (djb2). */
export const hashContent = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return String(h);
};

export const normalizeAbsPath = (path: string): string => {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
};

export const isSameOrInside = (candidate: string, folder: string): boolean =>
  candidate === folder || candidate.startsWith(`${folder}/`);

// ── Minimal frontmatter parsing (mirrors crates/neuralnote-core/src/note.rs) ──
export interface ParsedNote {
  frontmatter: Record<string, unknown> | null;
  frontmatterRaw: string | null;
  frontmatterError: string | null;
  body: string;
}

export const stripQuotes = (s: string): string =>
  (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
    ? s.slice(1, -1)
    : s;

export const parseYamlKey = (source: string): string => {
  const key = source.trim();
  if (key.startsWith("'") && key.endsWith("'")) {
    return key.slice(1, -1).replace(/''/gu, "'");
  }
  if (key.startsWith('"') && key.endsWith('"')) {
    const jsonCompatible = key
      .replace(/\\x([0-9a-f]{2})/giu, "\\u00$1")
      .replace(/\\U([0-9a-f]{8})/giu, (_match, hex: string) => {
        const point = Number.parseInt(hex, 16);
        if (!Number.isSafeInteger(point) || point > 0x10ffff) return "\\uFFFD";
        return JSON.stringify(String.fromCodePoint(point)).slice(1, -1);
      });
    try {
      const decoded: unknown = JSON.parse(jsonCompatible);
      if (typeof decoded === "string") return decoded;
    } catch {
      return key;
    }
  }
  return key;
};

const parseScalarOrArray = (s: string): unknown => {
  if (s === "") return null;
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((x) => stripQuotes(x.trim()));
  }
  return stripQuotes(s);
};

export const parseFrontmatter = (raw: string): ParsedNote => {
  const source = raw.startsWith("\ufeff") ? raw.slice(1) : raw;
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return { frontmatter: null, frontmatterRaw: null, frontmatterError: null, body: raw };
  }
  const closed = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?([\s\S]*)$/.exec(source);
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
  let listKey: string | null = null;
  for (const sourceLine of block.split("\n")) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const listItem = /^-\s+(.+)$/.exec(line);
    if (listItem && listKey !== null) {
      const values = Array.isArray(obj[listKey]) ? obj[listKey] as unknown[] : [];
      values.push(stripQuotes(listItem[1].trim()));
      obj[listKey] = values;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = parseYamlKey(line.slice(0, idx));
    if (Object.hasOwn(obj, key)) {
      return {
        frontmatter: null,
        frontmatterRaw: block,
        frontmatterError: `duplicate frontmatter key: ${key}`,
        body,
      };
    }
    const value = line.slice(idx + 1).trim();
    obj[key] = parseScalarOrArray(value);
    listKey = value === "" ? key : null;
  }
  return {
    frontmatter: Object.keys(obj).length > 0 ? obj : null,
    frontmatterRaw: block,
    frontmatterError: null,
    body,
  };
};

export const titleFrom = (
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
