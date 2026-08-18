// Small standalone notices that hang off an assistant turn: the missing-
// reasoning backstop, the empty-retrieval "nothing found" on-ramp, and the
// partial-coverage footer. Each is strictly honest about what the turn saw and
// what this build can do. Presentational only.
//
// The reasoning DISCLOSURE itself is no longer here — reasoning is part of what
// the assistant did, so it lives on the timeline rail (`ChatTimelineNodes.tsx`)
// where it renders as markdown rather than one pre-wrapped string.

import { SearchX } from "lucide-react";
import type { CoverageView, UsageView } from "./chatMessage";

/** The backstop for an opt-in that produced nothing: reasoning was requested and
 *  billed for, the turn finished cleanly, and no reasoning tokens arrived. Silence
 *  there would read as "the feature is off", so it is said out loud. */
export function MissingReasoningNotice({
  text,
  requested,
  show,
}: Readonly<{
  text: string;
  requested: boolean;
  /** The turn settled normally and produced an answer — before that, absent
   *  reasoning just means it hasn't streamed yet. */
  show: boolean;
}>) {
  if (text.trim() !== "" || !requested || !show) return null;
  return (
    <p className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">
      Reasoning was on, but the model didn&apos;t return any.
    </p>
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

/** Pinned to one locale rather than the host's, so the grouping separator is a
 *  property of the app and not of whatever machine it runs on. */
const COUNT = new Intl.NumberFormat("en-US");

/** Elapsed time, as a record rather than a live readout. One decimal is right
 *  for a settled number — it is precise about something that has stopped moving.
 *  Past a minute the decimal stops meaning anything, so it becomes `2m 05s`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** What the run cost, in the order it is worth reading: how long, what it spent,
 *  and which model spent it.
 *
 *  A token count the provider declined to report is rendered as ABSENT — the
 *  fact simply is not in the list. It must never appear as `0`, which claims a
 *  measurement of nothing was taken when in truth nothing was measured; the
 *  local lane routinely reports neither. Elapsed time is ours to measure and the
 *  model is ours to know, so those two are always there.
 *
 *  No separator glyphs between the facts. Each is conditional, so dots would
 *  need first/last bookkeeping to avoid a leading or doubled one — and a gap
 *  reads the same. */
export function UsageFooter({ usage }: Readonly<{ usage: UsageView | null }>) {
  if (usage === null) return null;
  const facts: string[] = [formatElapsed(usage.elapsedMs)];
  if (usage.tokensIn !== null) facts.push(`${COUNT.format(usage.tokensIn)} tokens in`);
  if (usage.tokensOut !== null) facts.push(`${COUNT.format(usage.tokensOut)} tokens out`);
  return (
    <ul
      aria-label="What this turn cost"
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.625rem] leading-snug text-muted-foreground/70"
    >
      {facts.map((fact) => (
        <li key={fact}>{fact}</li>
      ))}
      <li className="nn-mono min-w-0 truncate text-muted-foreground/60" title={usage.model}>
        {usage.model}
      </li>
    </ul>
  );
}

// Surfaces only what the activity summary can't: partial coverage and unreadable
// files (never hidden — thin support must not read as full-vault coverage). The
// provenance counts (searches / notes) now live in the activity summary line, so
// this no longer repeats "Searched X · read Y" — two independently-computed
// provenance lines in one card would eventually disagree. Nothing to warn about →
// nothing rendered.
//
// `coverage.notesRead` is deliberately not listed here, having been considered
// for exactly this footer and declined. Three reasons, in order of weight:
// the rail already names every note the run opened, with its line range, on the
// node that opened it, and the ruling this phase implements is that provenance
// belongs in place on the call that raised it rather than in a second aggregate
// surface; `Sources` already names, clickably, every note the answer cites; and
// this footer is a WARNING surface that renders nothing when nothing is wrong,
// so a paragraph of paths under every turn would change what it is for. The gap
// between those two lists — notes whose spans came back from a search and were
// never opened or cited — is real but carries no action, and the footer is not
// where an inventory belongs.
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
