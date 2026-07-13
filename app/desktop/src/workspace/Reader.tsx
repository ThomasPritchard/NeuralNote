// Read mode: the rendered note. Eyebrow type chip, title, a frontmatter
// "properties" table, then the body — markdown for .md/.markdown/.mdx, a
// plain-text fallback for other text files, and a friendly notice for binary
// files. A frontmatter parse error shows a non-blocking warning but never hides
// the body.

import { AlertTriangle, FileQuestion } from "lucide-react";
import type { NoteDoc } from "../lib/types";
import { BacklinksPanel } from "./BacklinksPanel";
import {
  extFromPath,
  extLabel,
  iconForFile,
  isMarkdownExt,
  isMarkdownRenderable,
  isTextLikeExt,
} from "./fileMeta";
import type { NoteIndexEntry } from "./linkResolve";
import { Markdown } from "./Markdown";

interface ReaderProps {
  note: NoteDoc;
  /** Vault note index for wikilink/internal-link resolution in the body. */
  noteIndex?: NoteIndexEntry[];
  /** Open another vault note by relPath (the workspace's guarded open). */
  onOpenLink?: (relPath: string) => void;
}

export function Reader({ note, noteIndex, onOpenLink }: Readonly<ReaderProps>) {
  const ext = extFromPath(note.path);
  const TypeIcon = iconForFile(ext);

  return (
    <article className="relative flex-1 overflow-y-auto px-8 py-10">
      <div className="relative mx-auto w-full max-w-[72ch]">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/12 px-2.5 py-1 text-[11px] font-medium text-primary ring-1 ring-inset ring-primary/20">
          <TypeIcon className="size-3" aria-hidden /> {extLabel(ext)}
        </span>

        <h1 className="nn-heading mt-4 text-[28px] font-semibold leading-tight tracking-tight">
          {note.title}
        </h1>

        {note.frontmatterError && (
          <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              <span className="leading-snug">
                Frontmatter couldn&apos;t be parsed: {note.frontmatterError}
              </span>
            </div>
            {note.frontmatterRaw && (
              // Show the offending block so the user can see (and fix) what failed,
              // rather than just being told it failed.
              <pre className="nn-mono mt-2 max-h-48 overflow-auto rounded-md bg-background/60 p-2 text-[11px] leading-5 text-muted-foreground">
                {note.frontmatterRaw}
              </pre>
            )}
          </div>
        )}

        {note.frontmatter && Object.keys(note.frontmatter).length > 0 && (
          <Properties frontmatter={note.frontmatter} />
        )}

        <div className="mt-7">
          <NoteBody
            note={note}
            ext={ext}
            noteIndex={noteIndex}
            onOpenLink={onOpenLink}
          />
        </div>

        {/* Backlinks only exist for actual markdown notes — read_backlinks
            indexes markdown files, so extensionless/binary files skip it. */}
        {!note.binary && isMarkdownExt(ext) && (
          <BacklinksPanel notePath={note.path} onOpenLink={onOpenLink} />
        )}
      </div>
    </article>
  );
}

function NoteBody({
  note,
  ext,
  noteIndex,
  onOpenLink,
}: Readonly<{
  note: NoteDoc;
  ext: string | null;
  noteIndex?: NoteIndexEntry[];
  onOpenLink?: (relPath: string) => void;
}>) {
  // Binaries first: the backend flags them and returns empty body/raw, so the
  // friendly notice (with no raw dump) is the only sensible view.
  if (note.binary) {
    return <UnsupportedNotice ext={ext} raw={null} />;
  }
  // Markdown, plus extensionless text files (README, LICENSE).
  if (isMarkdownRenderable(ext)) {
    return (
      <Markdown
        body={withoutRepeatedLeadingTitle(note.body, note.title)}
        noteIndex={noteIndex}
        onOpenLink={onOpenLink}
      />
    );
  }
  // Other text-like files fall back to their raw bytes; anything else, no dump.
  return <UnsupportedNotice ext={ext} raw={isTextLikeExt(ext) ? note.raw : null} />;
}

/**
 * The backend derives a note's title from frontmatter, then the first H1, then
 * the filename. When that H1 is the first body element, the reader's document
 * title already represents it; rendering both creates two competing H1s.
 * Preserve every non-matching heading, including a body H1 below frontmatter's
 * distinct title.
 */
export function withoutRepeatedLeadingTitle(body: string, title: string): string {
  let headingStart = 0;
  while (headingStart < body.length && body[headingStart].trim() === "") {
    headingStart += 1;
  }
  if (body[headingStart] !== "#") return body;

  let headingTextStart = headingStart + 1;
  if (body[headingTextStart] !== " " && body[headingTextStart] !== "\t") return body;
  while (body[headingTextStart] === " " || body[headingTextStart] === "\t") {
    headingTextStart += 1;
  }

  let headingEnd = headingTextStart;
  while (headingEnd < body.length && body[headingEnd] !== "\r" && body[headingEnd] !== "\n") {
    headingEnd += 1;
  }
  if (headingEnd === headingTextStart) return body;

  const normalize = (value: string) =>
    value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalize(body.slice(headingTextStart, headingEnd)) !== normalize(title)) return body;

  const lineEnd = body[headingEnd] === "\r" && body[headingEnd + 1] === "\n"
    ? headingEnd + 2
    : Math.min(headingEnd + 1, body.length);
  return `${body.slice(0, headingStart)}${body.slice(lineEnd)}`;
}

function UnsupportedNotice({
  ext,
  raw,
}: Readonly<{
  ext: string | null;
  raw: string | null;
}>) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-5">
      <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/90">
        <FileQuestion className="size-4 text-primary" aria-hidden />
        Preview not available for {ext ? `.${ext}` : "these"} files yet
      </div>
      {raw !== null && (
        <pre className="nn-mono mt-3 max-h-[60vh] overflow-auto rounded-md bg-background/60 p-3 text-[12px] leading-6 text-muted-foreground">
          {raw}
        </pre>
      )}
    </div>
  );
}

function Properties({ frontmatter }: Readonly<{ frontmatter: Record<string, unknown> }>) {
  return (
    <dl className="mt-5 flex flex-col divide-y divide-border/70 overflow-hidden rounded-lg border border-border bg-card/50">
      {Object.entries(frontmatter).map(([key, value]) => (
        <div key={key} className="flex items-start gap-3 px-4 py-2.5">
          <dt className="nn-mono flex w-28 shrink-0 items-center pt-px text-[12px] text-muted-foreground">
            {key}
          </dt>
          <dd className="min-w-0 flex-1 text-[13px]">
            <FrontmatterValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FrontmatterValue({ value }: Readonly<{ value: unknown }>) {
  if (Array.isArray(value)) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((item, i) => {
          const label = stringifyScalar(item);
          return (
            <span
              key={`${label}-${i}`}
              className="nn-mono rounded-sm bg-primary/12 px-1.5 py-0.5 text-[12px] text-primary ring-1 ring-inset ring-primary/15"
            >
              {label}
            </span>
          );
        })}
      </div>
    );
  }
  if (value !== null && typeof value === "object") {
    return <span className="nn-mono text-foreground/80">{stringifyScalar(value)}</span>;
  }
  return <span className="text-foreground/90">{stringifyScalar(value)}</span>;
}

/** Render a scalar (or unknown) frontmatter value as a short display string. */
function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "—";
    } catch {
      return "—";
    }
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    typeof value === "symbol"
  ) {
    return value.toString();
  }
  return "—";
}
