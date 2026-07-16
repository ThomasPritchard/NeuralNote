// The assistant turn's live "harness" trace — a step-by-step activity log
// (searching / reading / verifying / dropped) that reads like an agent working.
// While a run streams and before the answer starts it's a bounded live window;
// once settled it collapses to one summary line; an errored run stays expanded
// as diagnostic context. Presentational only; all step folding lives in
// `chatMessage.ts`.

import {
  AlertTriangle,
  ChevronRight,
  FileText,
  Loader2,
  Search,
  ShieldCheck,
} from "lucide-react";
import { GLYPH, ROW } from "./chatRow";
import { playfulProgressCopy } from "./playfulProgressCopy";
import { groupActivity, summarizeActivity } from "./chatMessage";
import type {
  ActivityStep,
  ActivitySummary,
  AssistantMessage,
  GroupedStep,
} from "./chatMessage";

/** A compact line-range label — "12–28", or just "12" when it's one line. */
function lineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `${startLine}` : `${startLine}–${endLine}`;
}

/** Pluralise a count with its noun — "1 note" / "3 notes". Irregular plurals
 *  (search→searches) are passed explicitly rather than guessed from a suffix. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ActivityRow({
  step,
  active,
}: Readonly<{ step: GroupedStep; active: boolean }>) {
  const glyph = active ? "text-primary" : "text-muted-foreground/70";
  const text = active ? "text-foreground/80" : "text-muted-foreground";
  switch (step.kind) {
    case "search":
      return (
        <li className={ROW}>
          <Search className={`${GLYPH} ${glyph}`} aria-hidden />
          <span className={`min-w-0 break-words ${text}`}>
            searching <span className="text-foreground/80">“{step.query}”</span>
            {step.hitCount !== undefined && (
              <span className="text-muted-foreground/60">
                {" "}
                → {step.hitCount} {step.hitCount === 1 ? "note" : "notes"}
              </span>
            )}
          </span>
        </li>
      );
    case "reading": {
      // Both folder and basename may contain user-controlled long segments. Let
      // either side truncate, while the title preserves the complete target.
      const slash = step.relPath.lastIndexOf("/");
      const dir = slash >= 0 ? step.relPath.slice(0, slash + 1) : "";
      const base = slash >= 0 ? step.relPath.slice(slash + 1) : step.relPath;
      return (
        <li className={ROW}>
          <FileText className={`${GLYPH} ${glyph}`} aria-hidden />
          <span
            className={`nn-mono flex min-w-0 items-baseline ${text}`}
            title={`${step.relPath}:${lineRange(step.startLine, step.endLine)}`}
          >
            <span className="shrink-0">reading&nbsp;</span>
            {dir !== "" && <span className="min-w-0 truncate">{dir}</span>}
            <span className="min-w-0 truncate">
              {base}:{lineRange(step.startLine, step.endLine)}
              {/* A burst of consecutive reads of one note collapses to one row; the
                  ×N affix keeps that honest without stacking N identical lines. */}
              {step.count > 1 && (
                <span className="text-muted-foreground/60"> ×{step.count}</span>
              )}
            </span>
          </span>
        </li>
      );
    }
    case "verifying":
      return (
        <li className={ROW}>
          <ShieldCheck className={`${GLYPH} ${glyph}`} aria-hidden />
          <span className={text}>verifying citations</span>
        </li>
      );
    case "dropped":
      // Citation fidelity is the moat — a dropped claim is the one step that
      // earns the destructive tint, even amid the calm trace.
      return (
        <li className={ROW}>
          <AlertTriangle className={`${GLYPH} text-destructive`} aria-hidden />
          <span className="min-w-0 break-words text-destructive">
            dropped a citation ({step.reason})
          </span>
        </li>
      );
  }
}

// How many live steps stay on screen while a run streams. A thorough run fires
// 15–20 steps — often the same note five times over — so a small cap keeps the
// "watch it work" feel without a 20-row wall. The header's tally accounts for the
// hidden ones; the window's height is reserved so it can't jitter as rows roll.
const LIVE_WINDOW_CAP = 3;

/** A phase is visible only after the event that grounds it arrives. */
function livePhase(phase: AssistantMessage["phase"], prompt: string): string {
  const playful = playfulProgressCopy(prompt);
  switch (phase) {
    case "sending":
      return playful.sending;
    case "thinking":
      return playful.thinking;
    case "searching":
      return "Searching your vault";
    case "reading":
      return "Reading notes";
    case "verifying":
      return "Verifying citations";
  }
}

// While the run streams *and before the answer starts*: a bounded, height-reserved
// window — a live phase header plus only the freshest few *grouped* steps, the last
// of which reads as active. Rows tail in at the bottom; older ones roll off the top.
// The moment answer tokens arrive the whole trace collapses (see ActivityTrace) —
// the streaming answer is the live focus then, so this header never lingers as a lie.
function LiveActivity({
  grouped,
  totalSteps,
  phase,
  prompt,
}: Readonly<{
  grouped: GroupedStep[];
  totalSteps: number;
  phase: AssistantMessage["phase"];
  prompt: string;
}>) {
  const shown = grouped.slice(-LIVE_WINDOW_CAP);
  const offset = grouped.length - shown.length;
  const lastShown = shown.length - 1;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-2 text-[0.6875rem] font-medium text-muted-foreground/90">
        <Loader2
          className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
          aria-hidden
        />
        {/* Only the phase word lives in the status region — it changes ~3× a run.
            The step tally is aria-hidden so its per-step churn stays silent.
            <output> carries an implicit status role (and renders inline, like
            the span it replaced). */}
        <output>{livePhase(phase, prompt)}</output>
        {totalSteps > 0 && (
          <span aria-hidden className="font-normal text-muted-foreground/60">
            · {count(totalSteps, "step", "steps")}
          </span>
        )}
      </p>
      {/* Reserve the full window height (~3 rows) so the block never grows/shrinks
          as rows roll — a live region resizing every 300ms reads as flicker, not
          work. justify-end tails new rows in at the bottom, oldest off the top. */}
      <ul
        aria-label="Search activity"
        className="flex min-h-[3.75rem] flex-col justify-end gap-1.5"
      >
        {shown.map((step, i) => (
          // Keyed by absolute position in the full grouped list so a row keeps its
          // identity as the window slides.
          <ActivityRow key={offset + i} step={step} active={i === lastShown} />
        ))}
      </ul>
    </div>
  );
}

/** The one-line summary the collapsed trace shows once settled. Copy: "N searches
 *  · M notes · verified" — or "N searches · nothing found" when retrieval came up
 *  empty (the zero-hit queries stay auditable in the expanded trace). A dropped
 *  citation is surfaced here — an AlertTriangle scan target plus a destructive
 *  "· K citations dropped" — never hidden. Citation fidelity is the moat. */
function ActivitySummaryLine({ summary }: Readonly<{ summary: ActivitySummary }>) {
  const { searches, notesRead, dropped, verified } = summary;
  const segs: string[] = [];
  if (searches > 0) segs.push(count(searches, "search", "searches"));
  if (notesRead > 0) {
    segs.push(count(notesRead, "note", "notes"));
    if (verified) segs.push("verified");
  } else if (searches > 0) {
    segs.push("nothing found");
  }
  const base = segs.join(" · ");
  return (
    <span className="min-w-0">
      {dropped > 0 && (
        <AlertTriangle
          className="mr-1 inline size-3.5 -translate-y-px text-destructive"
          aria-hidden
        />
      )}
      {base}
      {dropped > 0 && (
        <span className="text-destructive">
          {base === "" ? "" : " · "}
          {count(dropped, "citation", "citations")} dropped
        </span>
      )}
    </span>
  );
}

/** A step's identity signature, for React keys. A reading group's line range and
 *  ×N count MUTATE as the group absorbs consecutive reads, so only the note path
 *  (the group's identity) can key it. */
function stepSignature(step: GroupedStep): string {
  switch (step.kind) {
    case "search":
      return `search:${step.query}`;
    case "reading":
      return `reading:${step.relPath}`;
    case "verifying":
      return "verifying";
    case "dropped":
      return `dropped:${step.reason}`;
  }
}

/** The trace rows, in one place — reused by every settled view (inline, disclosure,
 *  stopped) so a same-note read burst is always one ×N row, never a duplicate stack. */
function ActivityRows({ grouped }: Readonly<{ grouped: GroupedStep[] }>) {
  // Keys: step identity + occurrence. The trace is append-only and never
  // reordered, so "the 2nd read-burst of Note.md" is a durable identity even
  // when the same note or query recurs.
  const seen = new Map<string, number>();
  const keyed = grouped.map((step) => {
    const sig = stepSignature(step);
    const n = seen.get(sig) ?? 0;
    seen.set(sig, n + 1);
    return { step, key: `${sig}#${n}` };
  });
  return (
    <ul aria-label="Search activity" className="flex flex-col gap-1.5">
      {keyed.map(({ step, key }) => (
        <ActivityRow key={key} step={step} active={false} />
      ))}
    </ul>
  );
}

// Once settled (the run is done, or the answer has started streaming): the trace
// collapses to one summary line — collapsed by default so the answer sits right
// under the prompt. Reuses the Reasoning disclosure idiom (native <details> for
// free keyboard + aria, rotating chevron, motion-reduce-safe). Defaults OPEN when
// there's something to act on (a dropped citation, or nothing found), pushing the
// user into the trace. Expanding reveals the full deduped `groupActivity` trace.
function ActivitySummaryDisclosure({
  grouped,
  summary,
  open,
}: Readonly<{ grouped: GroupedStep[]; summary: ActivitySummary; open: boolean }>) {
  return (
    <details
      open={open}
      className="group rounded-lg border border-border/60 bg-background/30 px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground"
    >
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 font-medium text-muted-foreground/90 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        <ActivitySummaryLine summary={summary} />
      </summary>
      <div className="mt-1.5 pl-[18px]">
        <ActivityRows grouped={grouped} />
      </div>
    </details>
  );
}

// A run that errored: show the failing context, always expanded, framed as
// "Failed —" (never a normal grey completed summary — that reads as "finished,
// then something unrelated broke"). The last row is where it died, so it's the
// diagnostic context for the error box rendered directly beneath.
function FailedActivity({
  grouped,
  summary,
}: Readonly<{ grouped: GroupedStep[]; summary: ActivitySummary }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[0.6875rem] font-medium text-muted-foreground/90">
        Failed — {count(summary.searches, "search", "searches")} ·{" "}
        {count(summary.notesRead, "note", "notes")}
      </p>
      <ActivityRows grouped={grouped} />
    </div>
  );
}

// The activity trace, routed by run phase:
//   • errored               → the "Failed" context, always expanded (diagnostic).
//   • streaming, pre-answer  → the bounded live window (the signature view).
//   • settled (done or answering) → one collapsed summary line; ≤2 steps render
//     inline (no chevron guarding a row or two); empty activity renders nothing.
export function ActivityTrace({
  activity,
  phase,
  prompt,
  answering,
  done,
  errored,
  suppressLive,
}: Readonly<{
  activity: ActivityStep[];
  phase: AssistantMessage["phase"];
  prompt: string;
  answering: boolean;
  done: boolean;
  errored: boolean;
  /** A skill narrative (header/steps/question) is already carrying the live
   *  view — an empty retrieval trace must not add a "Searching your vault"
   *  spinner over a run that isn't searching (it may be waiting on the user). */
  suppressLive: boolean;
}>) {
  const grouped = groupActivity(activity);
  const summary = summarizeActivity(activity);

  if (errored) {
    // An error that struck before any step: the error box alone speaks.
    return grouped.length === 0 ? null : (
      <FailedActivity grouped={grouped} summary={summary} />
    );
  }

  // Still searching/reading/verifying, no answer yet: the live "watch it work" view.
  if (!done && !answering) {
    if (suppressLive) return null;
    return (
      <LiveActivity
        grouped={grouped}
        totalSteps={summary.totalSteps}
        phase={phase}
        prompt={prompt}
      />
    );
  }

  // Settled: an answer with no trace shows nothing; a short trace stays inline; a
  // thorough one collapses behind the summary line.
  if (grouped.length === 0) return null;
  if (grouped.length <= 2) return <ActivityRows grouped={grouped} />;
  const openByDefault =
    summary.dropped > 0 || (summary.notesRead === 0 && summary.searches > 0);
  return (
    <ActivitySummaryDisclosure
      grouped={grouped}
      summary={summary}
      open={openByDefault}
    />
  );
}
