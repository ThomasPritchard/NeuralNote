// Search mirror (crates/neuralnote-core/src/search.rs, mirrored 1:1). Offsets
// are Unicode CODE POINTS (`Array.from`), matching the Rust side's char offsets.
// Each helper names the core function it mirrors; keep them in lockstep.

import type { FileHit, SearchMatch, SearchResponse } from "../lib/types";
import type { MdFile } from "./mockVaultTypes";
import {
  parseFrontmatter,
  parseYamlKey,
  stemOf,
  stripQuotes,
  titleFrom,
} from "./mockVaultNotes";
import { buildSnippet, fold, foldLine, maskCode } from "./mockVaultText";

const MAX_TOTAL_MATCHES = 200;
const MAX_MATCHES_PER_FILE = 50;
const MAX_QUERY_CHARS = 256;

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

const TAG_WORD_CHARACTER = /^[\p{L}\p{M}\p{N}_/-]$/u;
const TAG_UNICODE_SYMBOL = /^\p{S}$/u;

const isTagCharacter = (character: string): boolean =>
  TAG_WORD_CHARACTER.test(character) ||
  character === "\u200d" ||
  ((character.codePointAt(0) ?? 0) > 0x7f && TAG_UNICODE_SYMBOL.test(character));

const validTagName = (name: string): boolean => {
  const chars = Array.from(name);
  return chars.length > 0 &&
    chars.every(isTagCharacter) &&
    chars.some((character) => !/^\p{N}$/u.test(character));
};

const parseTagQuery = (query: string): string | null | undefined => {
  const split = query.indexOf(":");
  if (split === -1 || query.slice(0, split).toLowerCase() !== "tag") return undefined;
  const value = query.slice(split + 1);
  const name = value.startsWith("#") ? value.slice(1) : value;
  return validTagName(name) ? name : null;
};

const tagMatches = (candidate: string, requested: string): boolean => {
  const foldedCandidate = fold(candidate).join("");
  const foldedRequested = fold(requested).join("");
  return foldedCandidate === foldedRequested ||
    foldedCandidate.startsWith(`${foldedRequested}/`);
};

/** Blank tag-like text in Markdown constructs where Obsidian does not index
 * tags. Input and output retain the same code-point length. */
const normalizeReferenceLabel = (label: string): string =>
  label.trim().replace(/\s+/gu, " ").toLocaleLowerCase();

const maskReferenceDefinitions = (
  lines: readonly string[],
): { maskedLines: string[]; labels: Set<string> } => {
  const maskedLines = [...lines];
  const labels = new Set<string>();
  const titleStart = /^(?:["'(])/u;
  for (let index = 0; index < lines.length; index += 1) {
    const definition = /^ {0,3}\[([^\]\r\n]+)\]:\s*(.*)$/u.exec(lines[index]);
    if (!definition) continue;
    labels.add(normalizeReferenceLabel(definition[1]));
    maskedLines[index] = " ".repeat(Array.from(lines[index]).length);

    let continuation = index + 1;
    if (definition[2].trim() === "" && continuation < lines.length) {
      const destination = /^ {1,3}\S/u.exec(lines[continuation]);
      if (destination) {
        maskedLines[continuation] = " ".repeat(Array.from(lines[continuation]).length);
        continuation += 1;
      }
    }
    if (
      continuation < lines.length &&
      /^ {1,3}\S/u.test(lines[continuation]) &&
      titleStart.test(lines[continuation].trimStart())
    ) {
      maskedLines[continuation] = " ".repeat(Array.from(lines[continuation]).length);
    }
  }
  return { maskedLines, labels };
};

const maskTagContexts = (line: string, referenceLabels: ReadonlySet<string>): string => {
  const chars = Array.from(line);
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) chars[i] = " ";
  };
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] === "\\" && i + 1 < chars.length) {
      blank(i, i + 2);
      i += 1;
      continue;
    }
    if (chars[i] === "[" && chars[i + 1] === "[") {
      let end = i + 2;
      while (end + 1 < chars.length && !(chars[end] === "]" && chars[end + 1] === "]")) end += 1;
      if (end + 1 < chars.length) {
        blank(i, end + 2);
        i = end + 1;
      }
      continue;
    }
    if (chars[i] === "<") {
      const end = chars.indexOf(">", i + 1);
      if (end !== -1) {
        blank(i, end + 1);
        i = end;
      }
      continue;
    }
    if (chars[i] === "[") {
      const close = chars.indexOf("]", i + 1);
      if (close === -1) continue;
      if (chars[close + 1] === "(") {
        const end = chars.indexOf(")", close + 2);
        if (end === -1) continue;
        blank(i, end + 1);
        i = end;
        continue;
      }
      if (chars[close + 1] === "[") {
        const end = chars.indexOf("]", close + 2);
        if (end === -1) continue;
        blank(i, end + 1);
        i = end;
        continue;
      }
      const label = chars.slice(i + 1, close).join("");
      if (referenceLabels.has(normalizeReferenceLabel(label))) {
        blank(i, close + 1);
        i = close;
        continue;
      }
      let separator = close + 1;
      while (separator < chars.length && /\s/u.test(chars[separator])) separator += 1;
      if (chars[separator] === ":") {
        blank(i, chars.length);
        break;
      }
    }
  }
  return chars.join("");
};

interface TagOccurrence {
  readonly line: number;
  readonly range: [number, number];
}

const inlineTagOccurrences = (body: string, firstLine: number, requested: string): TagOccurrence[] => {
  const originalLines = body.split(/\r?\n/);
  const codeMaskedLines = maskCode(body).split(/\r?\n/);
  const { maskedLines, labels: referenceLabels } = maskReferenceDefinitions(codeMaskedLines);
  const out: TagOccurrence[] = [];
  for (let lineIndex = 0; lineIndex < maskedLines.length; lineIndex += 1) {
    const chars = Array.from(maskTagContexts(maskedLines[lineIndex], referenceLabels));
    const originalChars = Array.from(originalLines[lineIndex] ?? "");
    if (/^ {4}/.test(chars.join(""))) continue;
    for (let i = 0; i < chars.length; i += 1) {
      if (chars[i] !== "#" || (i > 0 && !/\s/u.test(originalChars[i - 1] ?? ""))) continue;
      let end = i + 1;
      while (end < chars.length && isTagCharacter(chars[end])) end += 1;
      const name = chars.slice(i + 1, end).join("");
      if (validTagName(name) && tagMatches(name, requested)) {
        out.push({ line: firstLine + lineIndex, range: [i, end] });
      }
      i = Math.max(i, end - 1);
    }
  }
  return out;
};

const frontmatterTagOccurrences = (
  frontmatterRaw: string | null,
  frontmatter: Record<string, unknown> | null,
  requested: string,
): TagOccurrence[] => {
  if (frontmatterRaw === null || frontmatter === null) return [];
  const semantic = frontmatter.tags;
  const semanticValues = (Array.isArray(semantic) ? semantic : [semantic])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.startsWith("#") ? value.slice(1) : value)
    .filter((value) => validTagName(value));
  if (!semanticValues.some((value) => tagMatches(value, requested))) return [];
  const out: TagOccurrence[] = [];
  const lines = frontmatterRaw.split(/\r?\n/);
  let inTagsList = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const propertySource = /^(.+?):\s*(.*)$/u.exec(line);
    const property = propertySource && parseYamlKey(propertySource[1]).toLowerCase() === "tags"
      ? propertySource
      : null;
    let values: string[] = [];
    if (property) {
      inTagsList = property[2].trim() === "";
      const rawValue = property[2].trim();
      if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        values = rawValue.slice(1, -1).split(",");
      } else if (rawValue !== "") {
        values = [rawValue];
      }
    } else if (inTagsList) {
      const item = /^\s*-\s+(.+)$/.exec(line);
      if (item) values = [item[1]];
      else if (line.trim() !== "") inTagsList = false;
    }
    for (const rawValue of values) {
      const value = stripQuotes(rawValue.trim());
      const name = value.startsWith("#") ? value.slice(1) : value;
      if (!validTagName(name) || !tagMatches(name, requested)) continue;
      const startUtf16 = line.indexOf(value);
      if (startUtf16 === -1) continue;
      const start = Array.from(line.slice(0, startUtf16)).length;
      out.push({
        line: index + 2,
        range: [start, start + Array.from(value).length],
      });
    }
  }
  return out;
};

const scanTags = (
  raw: string,
  requested: string,
  budget: number,
): [SearchMatch[], boolean] => {
  const parsed = parseFrontmatter(raw);
  const source = raw.startsWith("\ufeff") ? raw.slice(1) : raw;
  if (
    parsed.frontmatterError !== null &&
    parsed.frontmatterRaw === null &&
    (source.startsWith("---\n") || source.startsWith("---\r\n"))
  ) {
    return [[], false];
  }
  const prefixLength = raw.length - parsed.body.length;
  const firstBodyLine = prefixLength === 0
    ? 1
    : raw.slice(0, prefixLength).split(/\r?\n/).length;
  const occurrences = [
    ...frontmatterTagOccurrences(parsed.frontmatterRaw, parsed.frontmatter, requested),
    ...inlineTagOccurrences(parsed.body, firstBodyLine, requested),
  ].sort((left, right) => left.line - right.line || left.range[0] - right.range[0]);
  const byLine = new Map<number, [number, number][]>();
  for (const occurrence of occurrences) {
    const ranges = byLine.get(occurrence.line) ?? [];
    ranges.push(occurrence.range);
    byLine.set(occurrence.line, ranges);
  }
  const sourceLines = raw.split(/\r?\n/);
  const matches: SearchMatch[] = [];
  for (const [line, ranges] of byLine) {
    if (matches.length >= budget) return [matches, true];
    const lineText = sourceLines[line - 1] ?? "";
    const snippet = buildSnippet(Array.from(lineText), ranges);
    matches.push({ line, ...snippet });
  }
  return [matches, false];
};

/** Mirror of core `search_vault` (post-walk): the raw text is searched with
 *  frontmatter included; the global budget is consumed IN WALK ORDER during
 *  the scan (a name-hit file walked after exhaustion keeps its hit but loses
 *  its content matches); name/title hits then rank before content-only hits,
 *  each group in walk order. Queries are truncated to MAX_QUERY_CHARS.
 *  `skippedFiles` is always 0 here — the in-memory FS can't fail per-file
 *  (setFailure covers whole-command failures). */
export const searchFiles = (files: MdFile[], rawQuery: string): SearchResponse => {
  const trimmed = rawQuery.trim();
  if (trimmed === "") return { hits: [], truncated: false, skippedFiles: 0 };
  const capped = Array.from(trimmed).slice(0, MAX_QUERY_CHARS).join("");
  const tagQuery = parseTagQuery(capped);
  if (tagQuery === null) return { hits: [], truncated: false, skippedFiles: 0 };
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
    const nameMatch = tagQuery === undefined &&
      (containsFolded(stem, foldedQuery) || containsFolded(title, foldedQuery));

    const budget = Math.min(MAX_MATCHES_PER_FILE, MAX_TOTAL_MATCHES - total);
    const [matches, clipped]: [SearchMatch[], boolean] = budget === 0 && truncated
      ? [[], false] // budget gone and truncation already known — skip the scan
      : tagQuery === undefined
        ? scanContent(file.content, foldedQuery, budget)
        : scanTags(file.content, tagQuery, budget);
    truncated = truncated || clipped;
    total += matches.length;

    if (nameMatch || matches.length > 0) {
      const hit: FileHit = { path: file.path, relPath: file.rel, title, nameMatch, matches };
      (nameMatch ? nameHits : contentHits).push(hit);
    }
  }
  return { hits: [...nameHits, ...contentHits], truncated, skippedFiles };
};
