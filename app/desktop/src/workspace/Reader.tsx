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
    <article className="relative flex-1 overflow-y-auto px-6 py-9">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-primary/[0.05] to-transparent"
        aria-hidden
      />
      <div className="relative mx-auto w-full max-w-[42rem]">
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
    return <Markdown body={note.body} noteIndex={noteIndex} onOpenLink={onOpenLink} />;
  }
  // Other text-like files fall back to their raw bytes; anything else, no dump.
  return <UnsupportedNotice ext={ext} raw={isTextLikeExt(ext) ? note.raw : null} />;
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
    return <span className="nn-mono text-foreground/80">{JSON.stringify(value)}</span>;
  }
  return <span className="text-foreground/90">{stringifyScalar(value)}</span>;
}

/** Render a scalar (or unknown) frontmatter value as a short display string. */
function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
