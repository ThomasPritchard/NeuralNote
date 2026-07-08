// Renders the chat transcript: user prompts, and assistant turns as the live
// "harness" trace — a step-by-step activity log (searching / reading /
// verifying / dropped), optional collapsed reasoning, the streamed markdown
// answer, clickable source chips, a coverage footer, and a surfaced inline
// error. Presentational only; all state folding lives in `chatMessage.ts`.

import {
  AlertTriangle,
  ChevronRight,
  FileText,
  Loader2,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Markdown } from "./Markdown";
import { groupActivity, resolveAnswerMarkers, summarizeActivity } from "./chatMessage";
import type {
  ActivityStep,
  ActivitySummary,
  AssistantMessage,
  ChatMessage,
  CitationView,
  CoverageView,
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

// One activity row: a fixed icon gutter (a Lucide glyph, matching the rest of
// the workspace — never an emoji) plus the step's line. The most recent step of
// an in-flight run reads as "active" (violet glyph); everything settled is calm
// and muted, so the trace looks like an agent working, not debug output.
const ROW = "flex items-start gap-2 text-[11px] leading-snug";
const GLYPH = "size-3.5 shrink-0 translate-y-px";

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
          <span className={`min-w-0 ${text}`}>
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
      // Truncate the folder path, never the tail: the basename and :lineRange are
      // the citation-relevant part and must stay legible. Only the directory span
      // shrinks; the "basename:range" span is protected (shrink-0), so a long path
      // elides in its middle (…/Note.md:12–28) rather than eating the range.
      const slash = step.relPath.lastIndexOf("/");
      const dir = slash >= 0 ? step.relPath.slice(0, slash + 1) : "";
      const base = slash >= 0 ? step.relPath.slice(slash + 1) : step.relPath;
      return (
        <li className={ROW}>
          <FileText className={`${GLYPH} ${glyph}`} aria-hidden />
          <span className={`nn-mono flex min-w-0 items-baseline ${text}`}>
            <span className="shrink-0">reading&nbsp;</span>
            {dir !== "" && <span className="min-w-0 truncate">{dir}</span>}
            <span className="shrink-0">
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
          <span className="min-w-0 text-destructive">
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

/** The live header verb, tracking the phase the run is actually in — so it never
 *  claims "Searching" while it's reading or verifying. */
function livePhase(grouped: GroupedStep[]): string {
  switch (grouped.at(-1)?.kind) {
    case "reading":
      return "Reading notes";
    case "verifying":
    case "dropped":
      return "Verifying citations";
    default:
      return "Searching your vault";
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
}: Readonly<{ grouped: GroupedStep[]; totalSteps: number }>) {
  const shown = grouped.slice(-LIVE_WINDOW_CAP);
  const offset = grouped.length - shown.length;
  const lastShown = shown.length - 1;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground/90">
        <Loader2
          className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
          aria-hidden
        />
        {/* Only the phase word lives in the status region — it changes ~3× a run.
            The step tally is aria-hidden so its per-step churn stays silent.
            <output> carries an implicit status role (and renders inline, like
            the span it replaced). */}
        <output>{livePhase(grouped)}</output>
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
      className="group rounded-lg border border-border/60 bg-background/30 px-2.5 py-1.5 text-[11px] text-muted-foreground"
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
// "Stopped —" (never a normal grey completed summary — that reads as "finished,
// then something unrelated broke"). The last row is where it died, so it's the
// diagnostic context for the error box rendered directly beneath.
function StoppedActivity({
  grouped,
  summary,
}: Readonly<{ grouped: GroupedStep[]; summary: ActivitySummary }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-medium text-muted-foreground/90">
        Stopped — {count(summary.searches, "search", "searches")} ·{" "}
        {count(summary.notesRead, "note", "notes")}
      </p>
      <ActivityRows grouped={grouped} />
    </div>
  );
}

// The activity trace, routed by run phase:
//   • errored               → the "Stopped" context, always expanded (diagnostic).
//   • streaming, pre-answer  → the bounded live window (the signature view).
//   • settled (done or answering) → one collapsed summary line; ≤2 steps render
//     inline (no chevron guarding a row or two); empty activity renders nothing.
function ActivityTrace({
  activity,
  answering,
  done,
  errored,
}: Readonly<{
  activity: ActivityStep[];
  answering: boolean;
  done: boolean;
  errored: boolean;
}>) {
  const grouped = groupActivity(activity);
  const summary = summarizeActivity(activity);

  if (errored) {
    // An error that struck before any step: the error box alone speaks.
    return grouped.length === 0 ? null : (
      <StoppedActivity grouped={grouped} summary={summary} />
    );
  }

  // Still searching/reading/verifying, no answer yet: the live "watch it work" view.
  if (!done && !answering) {
    return <LiveActivity grouped={grouped} totalSteps={summary.totalSteps} />;
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

function Reasoning({ text }: Readonly<{ text: string }>) {
  if (text.trim() === "") return null;
  return (
    <details className="group rounded-lg border border-border/60 bg-background/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
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

function SourceChip({
  citation,
  onOpen,
}: Readonly<{ citation: CitationView; onOpen: () => void }>) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col items-start gap-1 rounded-lg border border-border/80 bg-card/40 px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-card/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        <span className="nn-mono flex items-center gap-1.5 text-[10px] text-primary/90">
          <FileText className="size-3 shrink-0 opacity-80" aria-hidden />
          {citation.relPath}:{citation.startLine}
        </span>
        <span className="line-clamp-2 border-l border-border pl-2 text-[11px] italic leading-snug text-muted-foreground">
          “{citation.text}”
        </span>
      </button>
    </li>
  );
}

function Sources({
  citations,
  onOpen,
}: Readonly<{
  citations: CitationView[];
  onOpen: (citation: CitationView) => void;
}>) {
  if (citations.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
        Sources
      </p>
      <ul aria-label="Cited sources" className="flex flex-col gap-1.5">
        {citations.map((c) => (
          <SourceChip key={c.id} citation={c} onOpen={() => onOpen(c)} />
        ))}
      </ul>
    </div>
  );
}

// Surfaces only what the activity summary can't: partial coverage and unreadable
// files (never hidden — thin support must not read as full-vault coverage). The
// provenance counts (searches / notes) now live in the activity summary line, so
// this no longer repeats "Searched X · read Y" — two independently-computed
// provenance lines in one card would eventually disagree. Nothing to warn about →
// nothing rendered.
function CoverageFooter({ coverage }: Readonly<{ coverage: CoverageView }>) {
  const { truncated, skippedFiles } = coverage;
  if (!truncated && skippedFiles === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border/50 pt-2.5 text-[10px] leading-snug text-muted-foreground/70">
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

function AssistantTurn({
  turn,
  onOpenCitation,
}: Readonly<{
  turn: AssistantMessage;
  onOpenCitation: (citation: CitationView) => void;
}>) {
  // Strip `[eN]` markers the verifier dropped before rendering — a discredited
  // citation must never linger as a live reference in the answer (the moat).
  const answer = resolveAnswerMarkers(turn.answer, turn.citations, turn.done);
  return (
    // No turn-wide aria-live: the per-row activity churn (15–20 mutations a run)
    // must stay silent. Liveness is scoped instead to the phase line (role=status),
    // the streamed answer, and the error box (role=alert).
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-background/30 px-3 py-3">
      <ActivityTrace
        activity={turn.activity}
        answering={turn.answer.trim() !== ""}
        done={turn.done}
        errored={turn.error !== null}
      />
      <Reasoning text={turn.thinking} />
      {answer.trim() !== "" && (
        // The answer is the payload — full-contrast, tightened to the pane's
        // narrow measure, with outer block margins collapsed so it sits flush.
        <div
          aria-live="polite"
          className="text-[13px] leading-6 text-foreground/90 [&_.nn-markdown>:first-child]:mt-0 [&_.nn-markdown>:last-child]:mb-0 [&_.nn-markdown_h1]:mt-4 [&_.nn-markdown_h1]:text-base [&_.nn-markdown_h2]:mt-3.5 [&_.nn-markdown_h2]:text-[15px] [&_.nn-markdown_h3]:mt-3 [&_.nn-markdown_h3]:text-[13px] [&_.nn-markdown_li]:leading-6 [&_.nn-markdown_ol]:my-2 [&_.nn-markdown_ol]:text-[13px] [&_.nn-markdown_p]:my-2 [&_.nn-markdown_p]:text-[13px] [&_.nn-markdown_p]:leading-6 [&_.nn-markdown_pre]:my-2 [&_.nn-markdown_pre]:text-[12px] [&_.nn-markdown_ul]:my-2 [&_.nn-markdown_ul]:text-[13px]"
        >
          <Markdown body={answer} />
        </div>
      )}
      <Sources citations={turn.citations} onOpen={onOpenCitation} />
      {turn.coverage && <CoverageFooter coverage={turn.coverage} />}
      {turn.error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 leading-snug">{turn.error}</span>
        </div>
      )}
    </div>
  );
}

function UserBubble({ content }: Readonly<{ content: string }>) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-primary/15 px-3 py-2 text-[13px] leading-snug text-foreground ring-1 ring-inset ring-primary/25">
        {content}
      </p>
    </div>
  );
}

export function ChatMessages({
  messages,
  onOpenCitation,
}: Readonly<{
  messages: ChatMessage[];
  onOpenCitation: (citation: CitationView) => void;
}>) {
  // Keys without ids: the transcript is append-only and never reordered, so
  // "the nth user / nth assistant message" is a durable identity. Content can't
  // key an assistant turn — it mutates as the answer streams.
  const counts = { user: 0, assistant: 0 };
  const keyed = messages.map((message) => {
    const n = counts[message.role];
    counts[message.role] = n + 1;
    return { message, key: `${message.role}-${n}` };
  });
  return (
    <div className="flex flex-col gap-3.5">
      {keyed.map(({ message, key }) =>
        message.role === "user" ? (
          <UserBubble key={key} content={message.content} />
        ) : (
          <AssistantTurn key={key} turn={message} onOpenCitation={onOpenCitation} />
        ),
      )}
    </div>
  );
}
