// Small standalone notices that hang off an assistant turn: the collapsed
// reasoning disclosure, the empty-retrieval "nothing found" on-ramp, and the
// partial-coverage footer. Each is strictly honest about what the turn saw and
// what this build can do. Presentational only.

import { ChevronRight, SearchX } from "lucide-react";
import type { CoverageView } from "./chatMessage";

export function Reasoning({ text }: Readonly<{ text: string }>) {
  if (text.trim() === "") return null;
  return (
    <details className="group rounded-lg border border-border/60 bg-background/30 px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground">
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 font-medium text-muted-foreground/90 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        Reasoning
      </summary>
      <p className="mt-1.5 whitespace-pre-wrap pl-[18px] leading-relaxed text-muted-foreground/80">
        {text}
      </p>
    </details>
  );
}

// The empty-retrieval on-ramp: the turn searched the vault and nothing
// survived verification. Lists what was searched (auditable, like the trace)
// and is strictly honest about what this build can do — add a note, nothing
// more. It must NOT offer to distil a link or ingest a source: no capture
// pipeline ships until Slice 5, and promising an unbuilt capability is
// fabrication, this product's worst failure mode.
export function NothingFoundCard({ terms }: Readonly<{ terms: string[] }>) {
  // Identity + occurrence keys: the term list is fixed once coverage lands,
  // but a backend could legally repeat a term.
  const seen = new Map<string, number>();
  const keyed = terms.map((term) => {
    const n = seen.get(term) ?? 0;
    seen.set(term, n + 1);
    return { term, key: `${term}#${n}` };
  });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/30 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-foreground/80">
        <SearchX className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
        Nothing in your vault covers this
      </p>
      <ul aria-label="Searched terms" className="flex flex-wrap gap-1">
        {keyed.map(({ term, key }) => (
          <li
            key={key}
            className="nn-mono rounded-full bg-muted/40 px-2 py-0.5 text-[0.625rem] text-muted-foreground ring-1 ring-inset ring-border"
          >
            {term}
          </li>
        ))}
      </ul>
      <p className="text-[0.6875rem] leading-snug text-muted-foreground">
        Answers only come from your notes. Research this and add a note, then
        ask again.
      </p>
      {/* TODO(slice-5): wire a capture CTA here once the skills bank lands. */}
    </div>
  );
}

// Surfaces only what the activity summary can't: partial coverage and unreadable
// files (never hidden — thin support must not read as full-vault coverage). The
// provenance counts (searches / notes) now live in the activity summary line, so
// this no longer repeats "Searched X · read Y" — two independently-computed
// provenance lines in one card would eventually disagree. Nothing to warn about →
// nothing rendered.
export function CoverageFooter({ coverage }: Readonly<{ coverage: CoverageView }>) {
  const { truncated, skippedFiles } = coverage;
  if (!truncated && skippedFiles === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border/50 pt-2.5 text-[0.625rem] leading-snug text-muted-foreground/70">
      {/* Partial coverage is surfaced, never hidden — thin support must not read
          as if the whole vault was seen. Calm, token-only notice (mirrors
          SearchPanel's truncation banner): visible, not alarming. */}
      {truncated && (
        <p className="rounded-md border border-border bg-muted/40 px-2 py-1 text-muted-foreground">
          Partial coverage. Some search results were truncated.
        </p>
      )}
      {skippedFiles > 0 && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
          {skippedFiles} {skippedFiles === 1 ? "file" : "files"} couldn&apos;t be read.
        </p>
      )}
    </div>
  );
}
