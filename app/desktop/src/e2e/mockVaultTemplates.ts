// Template mirror (crates/neuralnote-core/src/templates.rs). Pure rendering of
// Obsidian `{{…}}` and Templater `<%…%>` tokens against a fixed clock, plus the
// vault-aware resolver (`createTemplateResolver`) that infers the template
// folder and resolves a requested template against the in-memory filesystem.

import type { TemplateInfo, TreeNode } from "../lib/types";
import { type CoreErrorLike, type Entry, fail } from "./mockVaultTypes";
import { basename, extOf, isMarkdownExt, isSameOrInside, parentOf, stemOf } from "./mockVaultNotes";

export const DEFAULT_TEMPLATE_FOLDER = "Templates";
export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
export const DEFAULT_TIME_FORMAT = "HH:mm";
export const FALLBACK_TEMPLATE_FOLDERS = ["Templates", "_templates", "templates"];

export interface TemplateSettings {
  folder: string;
  dateFormat: string;
  timeFormat: string;
}

export const parseRelativePath = (raw: string): string | null => {
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

export const renderTemplate = (
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

// ── Vault-aware template resolution (reads the in-memory filesystem) ──────────

/** The filesystem accessors the resolver needs — supplied by `createMockVault`
 *  so the resolver stays read-only against the live vault state (the vault root
 *  can change via open/create, hence the getter). */
export interface TemplateResolverDeps {
  entries: ReadonlyMap<string, Entry>;
  getRoot: () => string;
  resolveVaultPath: (path: string) => string;
  relOf: (p: string) => string;
  childrenOf: (parent: string) => TreeNode[];
}

export interface TemplateResolver {
  templateInfos: () => TemplateInfo[];
  inferTemplateSettings: () => TemplateSettings;
  resolveTemplateFile: (settings: TemplateSettings, template: string) => string;
}

export const createTemplateResolver = (deps: TemplateResolverDeps): TemplateResolver => {
  const { entries, getRoot, resolveVaultPath, relOf, childrenOf } = deps;

  const topLevelTemplateFolder = (): string | null => {
    const root = getRoot();
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

  const readObsidianTemplateConfig = (settings: TemplateSettings): string | null => {
    const entry = entries.get(`${getRoot()}/.obsidian/templates.json`);
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

  return { templateInfos, inferTemplateSettings, resolveTemplateFile };
};
