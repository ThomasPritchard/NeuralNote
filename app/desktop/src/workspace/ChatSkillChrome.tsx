// A skill turn's chrome: the labelled activation header (so a doing-turn is
// never dressed as a plain answer), the skill's own progress narration, and the
// actionable "set up YouTube imports" card that replaces the machine-oriented
// missing-yt-dlp failure row. Presentational only.

import { useState } from "react";
import { AlertTriangle, Check, ChevronRight, Download, Loader2, Wand2 } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { PullEvent } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { GLYPH, ROW } from "./chatRow";

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
export function SkillActivations({
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
export function SkillSteps({
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
