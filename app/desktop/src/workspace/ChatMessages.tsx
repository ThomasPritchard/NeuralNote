// Renders the chat transcript: user prompts, and assistant turns as the live
// "harness" trace — a step-by-step activity log (searching / reading /
// verifying / dropped), optional collapsed reasoning, the streamed markdown
// answer, clickable source chips, a coverage footer, and a surfaced inline
// error. Presentational only; all state folding lives in `chatMessage.ts`.

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Play,
  Search,
  SearchX,
  ShieldCheck,
  Wand2,
} from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { PullEvent } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ElicitCard } from "./ElicitCard";
import { Markdown } from "./Markdown";
import { SkillReportCard } from "./SkillReportCard";
import { parseYoutubeTimestampJump } from "./youtubeTimestamp";
import {
  groupActivity,
  isPartialSkillRun,
  modelReportedProvenance,
  resolveAnswerMarkers,
  showsNothingFoundCard,
  summarizeActivity,
} from "./chatMessage";
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
const ROW = "flex items-start gap-2 text-[0.6875rem] leading-snug";
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

// The orchestrator's activation-failure marker: a skill the user asked for
// that couldn't load arrives as a SkillStep carrying this phrase, and it must
// render as an honest notice, never as normal progress. Two-site coupling —
// the Rust source of truth is the SKILL_ACTIVATION_FAILURE_MARK const in
// crates/neuralnote-core/src/ai/orchestrator.rs; keep the literals in lockstep.
const ACTIVATION_FAILURE_MARK = "could not be activated";
const MISSING_YTDLP_STEP =
  "Skill 'youtube-distil' could not be activated: skill 'youtube-distil' is not eligible: unmet requirements: required binary 'yt-dlp' is missing from the app-data bin directory — continuing without it";

/** Recognise only the core's complete, deterministic missing-yt-dlp step. Any
 * wording drift or different activation failure stays in the ordinary visible
 * error lane instead of gaining an unrelated install action. */
function downloadableYoutubeRequirement(message: string): "yt-dlp" | null {
  return message === MISSING_YTDLP_STEP ? "yt-dlp" : null;
}

type RequirementInstallState =
  | { status: "idle" }
  | { status: "downloading"; label: string; percent: number | null }
  | { status: "cancelling"; label: string; percent: number | null }
  | { status: "ready" }
  | { status: "error"; message: string };

function YoutubeRequirementCard({ requirement }: Readonly<{ requirement: "yt-dlp" }>) {
  const [install, setInstall] = useState<RequirementInstallState>({ status: "idle" });

  const onEvent = (event: PullEvent) => {
    switch (event.type) {
      case "progress":
        setInstall((current) => ({
          status: current.status === "cancelling" ? "cancelling" : "downloading",
          label: event.status,
          percent: event.percent,
        }));
        break;
      case "success":
        setInstall({ status: "ready" });
        break;
      case "error":
        setInstall({ status: "error", message: event.message });
        break;
    }
  };

  const startDownload = () => {
    setInstall({ status: "downloading", label: "Starting…", percent: null });
    void api
      .downloadRequirement(requirement, onEvent)
      .catch((error: unknown) => {
        setInstall({ status: "error", message: errorMessage(error) });
      });
  };

  const cancelDownload = () => {
    if (install.status !== "downloading") return;
    setInstall({ ...install, status: "cancelling" });
    void api.cancelRequirementDownload().catch((error: unknown) => {
      setInstall({ status: "error", message: errorMessage(error) });
    });
  };

  const active = install.status === "downloading" || install.status === "cancelling";

  return (
    <section
      aria-label="Set up YouTube imports"
      className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-primary/25 bg-primary/[0.06] p-3"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
          {install.status === "ready" ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Download className="size-3.5" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[0.75rem] font-semibold text-foreground">
            {install.status === "ready" ? "YouTube imports are ready" : "Set up YouTube imports"}
          </h3>
          {install.status !== "ready" && (
            <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
              YouTube imports need yt-dlp, and it isn&apos;t installed yet. NeuralNote can
              download its pinned, verified copy for you.
            </p>
          )}
          {/* Mounted empty from the outset, then populated once on success. It
              announces readiness without turning progress frames into chatter
              or duplicating the visible completion copy. */}
          <output
            aria-live="polite"
            aria-atomic="true"
            className={
              install.status === "ready"
                ? "mt-0.5 block text-[0.6875rem] leading-relaxed text-muted-foreground"
                : "sr-only"
            }
          >
            {install.status === "ready"
              ? "yt-dlp is ready. Send the video again to start the import."
              : ""}
          </output>
        </div>
      </div>

      {active && (
        <output className="flex flex-col gap-1.5">
          <span className="flex items-center justify-between gap-2 text-[0.625rem] text-muted-foreground">
            <span className="min-w-0 truncate">
              {install.status === "cancelling" ? "Cancelling…" : install.label}
            </span>
            {install.percent !== null && (
              <span className="nn-mono shrink-0">{Math.round(install.percent)}%</span>
            )}
          </span>
          <Progress
            aria-label="Downloading yt-dlp"
            value={install.percent}
          />
        </output>
      )}

      {install.status === "error" && (
        <p
          role="alert"
          className="break-words rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[0.6875rem] leading-snug text-destructive"
        >
          Couldn&apos;t install yt-dlp: {install.message}
        </p>
      )}

      {(install.status === "idle" || install.status === "error") && (
        <button
          type="button"
          onClick={startDownload}
          className={buttonVariants({ tone: "primary", size: "sm", className: "self-start" })}
        >
          <Download className="size-3.5" aria-hidden />
          {install.status === "error" ? "Retry download" : "Download yt-dlp"}
        </button>
      )}
      {active && (
        <button
          type="button"
          onClick={cancelDownload}
          disabled={install.status === "cancelling"}
          className={buttonVariants({ tone: "quiet", size: "sm", className: "self-start" })}
          aria-label="Cancel yt-dlp download"
        >
          {install.status === "cancelling" ? "Cancelling…" : "Cancel"}
        </button>
      )}
    </section>
  );
}

/** The turn's skill header rows — each activated skill labels the turn, so a
 *  doing-turn is never dressed as a plain answer. */
function SkillActivations({
  activations,
}: Readonly<{ activations: ReadonlyArray<{ id: string; name: string }> }>) {
  if (activations.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {activations.map((activation) => (
        <p
          key={activation.id}
          className="flex items-center gap-1.5 border-b border-border/50 pb-1.5 text-[0.6875rem] font-medium text-foreground/85"
        >
          <Wand2 className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 truncate">{activation.name}</span>
          <span className="ml-auto shrink-0 text-[0.5625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
            Skill
          </span>
        </p>
      ))}
    </div>
  );
}

/** The skill's own progress narration ("Fetching captions…"), extending the
 *  harness feel. Steps are sparse and each is meaningful, so every row stays
 *  visible — no windowing, no disclosure. The last row spins while the run is
 *  genuinely working (not while it waits on the user or streams the answer);
 *  settled rows keep a neutral marker — a run can end mid-step, so a
 *  completion glyph would over-claim. Activation failures render in the
 *  destructive register: the skill the user asked for isn't running, and that
 *  is never dressed as progress. */
function SkillSteps({
  steps,
  working,
}: Readonly<{ steps: readonly string[]; working: boolean }>) {
  if (steps.length === 0) return null;
  // Identity + occurrence keys: append-only narration, messages may repeat.
  const seen = new Map<string, number>();
  const keyed = steps.map((message) => {
    const n = seen.get(message) ?? 0;
    seen.set(message, n + 1);
    return { message, key: `${message}#${n}` };
  });
  const last = keyed.length - 1;
  return (
    <ul aria-label="Skill progress" className="flex flex-col gap-1.5">
      {keyed.map(({ message, key }, i) => {
        const requirement = downloadableYoutubeRequirement(message);
        if (requirement !== null) {
          // Replace this one machine-oriented failure row with the actionable
          // card. Rendering both would repeat the same problem directly above
          // its explanation; every non-exact failure still takes the row below.
          return (
            <li key={key} className="min-w-0">
              <YoutubeRequirementCard requirement={requirement} />
            </li>
          );
        }
        if (message.includes(ACTIVATION_FAILURE_MARK)) {
          return (
            <li key={key} className={ROW}>
              <AlertTriangle className={`${GLYPH} text-destructive`} aria-hidden />
              <span className="min-w-0 break-words text-destructive">{message}</span>
            </li>
          );
        }
        const active = working && i === last;
        return (
          <li key={key} className={ROW}>
            {active ? (
              <Loader2
                className={`${GLYPH} animate-spin text-primary motion-reduce:animate-none`}
                aria-hidden
              />
            ) : (
              <ChevronRight className={`${GLYPH} text-muted-foreground/70`} aria-hidden />
            )}
            <span className={`min-w-0 break-words ${active ? "text-foreground/80" : "text-muted-foreground"}`}>
              {message}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// How many live steps stay on screen while a run streams. A thorough run fires
// 15–20 steps — often the same note five times over — so a small cap keeps the
// "watch it work" feel without a 20-row wall. The header's tally accounts for the
// hidden ones; the window's height is reserved so it can't jitter as rows roll.
const LIVE_WINDOW_CAP = 3;

const PLAYFUL_PROGRESS_COPY = [
  { sending: "Sending message", thinking: "Thinking" },
  { sending: "Dispatching a tiny messenger", thinking: "Connecting the dots" },
  {
    sending: "Knocking on the model's door",
    thinking: "Rummaging through the mental drawers",
  },
  { sending: "Launching a thought balloon", thinking: "Consulting the inner librarian" },
] as const;

/** Pick one voice for the whole turn. The prompt-derived hash makes the choice
 * stable across React renders and phase changes without persisting UI trivia or
 * introducing random, flaky behaviour. */
export function playfulProgressCopy(prompt: string) {
  let hash = 2_166_136_261;
  for (const codePoint of prompt) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return PLAYFUL_PROGRESS_COPY[(hash >>> 0) % PLAYFUL_PROGRESS_COPY.length];
}

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
// "Stopped —" (never a normal grey completed summary — that reads as "finished,
// then something unrelated broke"). The last row is where it died, so it's the
// diagnostic context for the error box rendered directly beneath.
function StoppedActivity({
  grouped,
  summary,
}: Readonly<{ grouped: GroupedStep[]; summary: ActivitySummary }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[0.6875rem] font-medium text-muted-foreground/90">
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
      <StoppedActivity grouped={grouped} summary={summary} />
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

function Reasoning({ text }: Readonly<{ text: string }>) {
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
function NothingFoundCard({ terms }: Readonly<{ terms: string[] }>) {
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

function SourceChip({
  citation,
  onOpen,
}: Readonly<{ citation: CitationView; onOpen: () => void }>) {
  const [openingTimestamp, setOpeningTimestamp] = useState(false);
  const [timestampError, setTimestampError] = useState<string | null>(null);
  const timestampJump = parseYoutubeTimestampJump(citation.text);
  const openTimestamp = async () => {
    if (timestampJump === null || openingTimestamp) return;
    setOpeningTimestamp(true);
    setTimestampError(null);
    try {
      await api.openYoutubeTimestamp(timestampJump.href);
    } catch (error) {
      setTimestampError(errorMessage(error));
    } finally {
      setOpeningTimestamp(false);
    }
  };
  const sourceBody = (
    <>
      <span
        className="nn-mono flex min-w-0 max-w-full items-center gap-1.5 text-[0.625rem] text-primary/90"
        title={`${citation.relPath}:${citation.startLine}`}
      >
        <FileText className="size-3 shrink-0 opacity-80" aria-hidden />
        <span className="min-w-0 truncate">
          {citation.relPath}:{citation.startLine}
        </span>
      </span>
      <span className="line-clamp-2 break-words border-l border-border pl-2 text-[0.6875rem] italic leading-snug text-muted-foreground">
        “{citation.text}”
      </span>
    </>
  );
  return (
    <li>
      {timestampJump === null ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full flex-col items-start gap-1 rounded-lg border border-border/80 bg-card/40 px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-card/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          {sourceBody}
        </button>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/80 bg-card/40 transition-colors hover:border-primary/40 hover:bg-card/70">
          <button
            type="button"
            onClick={onOpen}
            className="flex w-full flex-col items-start gap-1 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
          >
            {sourceBody}
          </button>
          <button
            type="button"
            onClick={() => void openTimestamp()}
            disabled={openingTimestamp}
            aria-label={`Watch at ${timestampJump.label} on YouTube`}
            className="nn-mono flex w-full items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5 text-left text-[0.625rem] font-medium text-primary/90 transition-colors hover:bg-primary/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary disabled:text-muted-foreground"
          >
            {openingTimestamp ? (
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Play className="size-3 fill-current" aria-hidden />
            )}
            Watch {timestampJump.label}
          </button>
          {timestampError !== null && (
            <p
              role="alert"
              className="break-words border-t border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[0.625rem] leading-snug text-destructive"
            >
              {timestampError}
            </p>
          )}
        </div>
      )}
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
      <p className="text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
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

function AssistantTurn({
  turn,
  prompt,
  onOpenCitation,
  onOpenNote,
  onSendFollowUp,
  busy,
  runId,
  elicitAnswer,
  onElicitAnswered,
}: Readonly<{
  turn: AssistantMessage;
  prompt: string;
  onOpenCitation: (citation: CitationView) => void;
  onOpenNote: (relPath: string) => void;
  /** Issues an ordinary chat turn (a dormant elicitation's late answer). */
  onSendFollowUp: (text: string) => void;
  /** A run is streaming somewhere in the pane — late sends must wait. */
  busy: boolean;
  /** This turn's run id (resolved when the run settles), for Undo. */
  runId: string | null;
  /** The chosen option ids once this turn's question was answered. */
  elicitAnswer: readonly string[] | undefined;
  onElicitAnswered: (id: string, choices: string[]) => void;
}>) {
  // Strip `[eN]` markers the verifier dropped before rendering — a discredited
  // citation must never linger as a live reference in the answer (the moat).
  const answer = resolveAnswerMarkers(turn.answer, turn.citations, turn.done);
  const answering = turn.answer.trim() !== "";
  // The run is parked on the user, not working: the question is live (not yet
  // answered) and the run hasn't ended. No spinner may claim progress here.
  const awaitingUser =
    turn.pendingElicitation !== null && elicitAnswer === undefined && !turn.done;
  const hasSkillNarrative =
    turn.skillActivations.length > 0 ||
    turn.skillSteps.length > 0 ||
    turn.pendingElicitation !== null;
  return (
    // No turn-wide aria-live: the per-row activity churn (15–20 mutations a run)
    // must stay silent. Liveness is scoped instead to the phase line (role=status),
    // the streamed answer, and the error box (role=alert).
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-background/30 px-3 py-3">
      <SkillActivations activations={turn.skillActivations} />
      <SkillSteps
        steps={turn.skillSteps}
        working={!turn.done && !answering && !awaitingUser && turn.error === null}
      />
      <ActivityTrace
        activity={turn.activity}
        phase={turn.phase}
        prompt={prompt}
        answering={answering}
        done={turn.done}
        errored={turn.error !== null}
        suppressLive={hasSkillNarrative}
      />
      <Reasoning text={turn.thinking} />
      {turn.pendingElicitation !== null && (
        // Keyed by elicitation id: a follow-up question in the same turn is a
        // fresh card (fresh focus, fresh state), never a half-answered reuse.
        <ElicitCard
          key={turn.pendingElicitation.id}
          elicitation={turn.pendingElicitation}
          dormant={turn.done && elicitAnswer === undefined}
          busy={busy}
          answer={elicitAnswer}
          onAnswered={onElicitAnswered}
          onSendFollowUp={onSendFollowUp}
        />
      )}
      {answer.trim() !== "" && (
        // The answer is the payload — full-contrast, tightened to the pane's
        // narrow measure, with outer block margins collapsed so it sits flush.
        <div
          aria-live="polite"
          className="text-[0.8125rem] leading-6 text-foreground/90 [&_.nn-markdown>:first-child]:mt-0 [&_.nn-markdown>:last-child]:mb-0 [&_.nn-markdown_h1]:mt-4 [&_.nn-markdown_h1]:text-base [&_.nn-markdown_h2]:mt-3.5 [&_.nn-markdown_h2]:text-[0.9375rem] [&_.nn-markdown_h3]:mt-3 [&_.nn-markdown_h3]:text-[0.8125rem] [&_.nn-markdown_li]:leading-6 [&_.nn-markdown_ol]:my-2 [&_.nn-markdown_ol]:text-[0.8125rem] [&_.nn-markdown_p]:my-2 [&_.nn-markdown_p]:text-[0.8125rem] [&_.nn-markdown_p]:leading-6 [&_.nn-markdown_pre]:my-2 [&_.nn-markdown_pre]:text-[0.75rem] [&_.nn-markdown_ul]:my-2 [&_.nn-markdown_ul]:text-[0.8125rem]"
        >
          <Markdown body={answer} />
        </div>
      )}
      {showsNothingFoundCard(turn) && turn.coverage && (
        <NothingFoundCard terms={turn.coverage.searchedTerms} />
      )}
      {turn.writtenNotes.length > 0 && (
        <SkillReportCard
          files={turn.writtenNotes}
          runId={runId}
          done={turn.done}
          partial={isPartialSkillRun(turn)}
          provenance={modelReportedProvenance(turn)}
          onOpen={onOpenNote}
        />
      )}
      <Sources citations={turn.citations} onOpen={onOpenCitation} />
      {turn.coverage && <CoverageFooter coverage={turn.coverage} />}
      {turn.error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[0.75rem] text-destructive"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words leading-snug">{turn.error}</span>
        </div>
      )}
    </div>
  );
}

function UserBubble({ content }: Readonly<{ content: string }>) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-primary/15 px-3 py-2 text-[0.8125rem] leading-snug text-foreground ring-1 ring-inset ring-primary/25">
        {content}
      </p>
    </div>
  );
}

export function ChatMessages({
  messages,
  onOpenCitation,
  onOpenNote,
  onSendFollowUp,
  busy,
  runIds,
}: Readonly<{
  messages: ChatMessage[];
  onOpenCitation: (citation: CitationView) => void;
  onOpenNote: (relPath: string) => void;
  /** Issues an ordinary chat turn — a dormant elicitation's late answer. */
  onSendFollowUp: (text: string) => void;
  /** A run is currently streaming (late elicitation sends must wait). */
  busy: boolean;
  /** Run ids by message index, resolved as each run settles — Undo's handle. */
  runIds: Readonly<Record<number, string>>;
}>) {
  // Answered elicitations, by elicitation id. Client-side on purpose: there is
  // no resolution ChatEvent (the reducer keeps the question pinned), so the
  // transcript holds the terminal "answered" state where every card of any
  // turn can read it — component-local state would die with a re-keyed card.
  const [elicitAnswers, setElicitAnswers] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const onElicitAnswered = useCallback((id: string, choices: string[]) => {
    setElicitAnswers((prev) => ({ ...prev, [id]: choices }));
  }, []);

  // Keys without ids: the transcript is append-only and never reordered, so
  // "the nth user / nth assistant message" is a durable identity. Content can't
  // key an assistant turn — it mutates as the answer streams.
  const counts = { user: 0, assistant: 0 };
  let latestUserPrompt = "";
  const keyed = messages.map((message, index) => {
    const n = counts[message.role];
    counts[message.role] = n + 1;
    if (message.role === "user") latestUserPrompt = message.content;
    return { message, index, key: `${message.role}-${n}`, prompt: latestUserPrompt };
  });
  return (
    <div className="flex flex-col gap-3.5">
      {keyed.map(({ message, index, key, prompt }) =>
        message.role === "user" ? (
          <UserBubble key={key} content={message.content} />
        ) : (
          <AssistantTurn
            key={key}
            turn={message}
            prompt={prompt}
            onOpenCitation={onOpenCitation}
            onOpenNote={onOpenNote}
            onSendFollowUp={onSendFollowUp}
            busy={busy}
            runId={runIds[index] ?? null}
            elicitAnswer={
              message.pendingElicitation
                ? elicitAnswers[message.pendingElicitation.id]
                : undefined
            }
            onElicitAnswered={onElicitAnswered}
          />
        ),
      )}
    </div>
  );
}
