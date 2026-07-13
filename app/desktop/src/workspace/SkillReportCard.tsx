// The skill run's report card: the ledger of notes the run wrote (accumulated
// from `NoteWritten` events — the model's own answer carries the routing
// rationale), plus Undo. Undo reports per-file outcomes verbatim — a file kept
// because the user edited it is surfaced, never folded into a bare "done" —
// and a failed removal keeps the button as "Retry undo" (the backend restores
// its authority over failed runs).

import { useState } from "react";
import { AlertTriangle, Check, FilePlus2, Info, Loader2, Undo2 } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import type { NoteKind, UndoFileResult, UndoReport } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";

type UndoState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; report: UndoReport }
  | { status: "error"; message: string };

/** Pluralise a count with its noun. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The user-facing outcome line for one undone file. The backend's message is
 *  authoritative when present; these are the fallbacks per status. */
function outcomeCopy(result: UndoFileResult): string {
  if (result.message !== null && result.message !== "") return result.message;
  switch (result.status) {
    case "deleted":
      return "Removed";
    case "skippedEdited":
      return "Kept — it changed since it was written";
    case "skippedMissing":
      return "Already gone";
    case "failed":
      return "Couldn't be removed";
  }
}

function OutcomeGlyph({ status }: Readonly<{ status: UndoFileResult["status"] }>) {
  const cls = "size-3 shrink-0 translate-y-px";
  switch (status) {
    case "deleted":
      return <Check className={`${cls} text-muted-foreground/70`} aria-hidden />;
    case "failed":
      return <AlertTriangle className={`${cls} text-destructive`} aria-hidden />;
    default:
      return <Info className={`${cls} text-muted-foreground/70`} aria-hidden />;
  }
}

/** A vault-relative path with the folder squeezed and the basename protected,
 *  so a long path elides in the middle rather than eating the filename. */
function PathLabel({ relPath }: Readonly<{ relPath: string }>) {
  const slash = relPath.lastIndexOf("/");
  const dir = slash >= 0 ? relPath.slice(0, slash + 1) : "";
  const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  return (
    <span
      className="nn-mono flex min-w-0 flex-1 items-baseline text-[0.6875rem] text-foreground/90"
      title={relPath}
    >
      {dir !== "" && (
        <span className="min-w-0 truncate text-muted-foreground">{dir}</span>
      )}
      <span className="min-w-0 truncate">{base}</span>
    </span>
  );
}

export function SkillReportCard({
  files,
  runId,
  done,
  partial = false,
  provenance = [],
  onOpen = () => undefined,
}: Readonly<{
  /** The `NoteWritten` accumulation, in write order. */
  files: ReadonlyArray<{ relPath: string; kind: NoteKind }>;
  /** The run id `chat` resolved with — null until the run settles. */
  runId: string | null;
  /** Whether the run has ended (Undo only makes sense on a settled run). */
  done: boolean;
  /** The run stopped after writing at least one result. Written files remain
   *  useful and undoable, so this is a warning rather than a failed card. */
  partial?: boolean;
  /** Distinct provenance labels extracted from model-authored narrative. */
  provenance?: readonly string[];
  /** Opens a trusted path emitted by NoteWritten through workspace navigation. */
  onOpen?: (relPath: string) => void;
}>) {
  const [undo, setUndo] = useState<UndoState>({ status: "idle" });

  const runUndo = async () => {
    if (runId === null || undo.status === "running") return;
    setUndo({ status: "running" });
    try {
      setUndo({ status: "done", report: await api.undoSkillRun(runId) });
    } catch (e) {
      setUndo({ status: "error", message: errorMessage(e) });
    }
  };

  const report = undo.status === "done" ? undo.report : null;
  const outcomeFor = (relPath: string): UndoFileResult | undefined =>
    report?.files.find((f) => f.relPath === relPath);
  const failedCount =
    report?.files.filter((f) => f.status === "failed").length ?? 0;
  const removedCount =
    report?.files.filter((f) => f.status === "deleted").length ?? 0;

  // The button's three lives: fresh Undo, a retry after any failure, and gone
  // once every file reached a terminal non-failed outcome (nothing left to do).
  const showUndo =
    done &&
    runId !== null &&
    (undo.status === "idle" ||
      undo.status === "running" ||
      undo.status === "error" ||
      failedCount > 0);

  return (
    <section
      aria-label="Notes written by this run"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 bg-background/30 px-3 py-2.5"
    >
      <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-foreground/80">
        <FilePlus2 className="size-3.5 shrink-0 text-primary" aria-hidden />
        {count(files.length, "note written", "notes written")}
      </p>

      {partial && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-2 text-amber-200/90">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            <span className="block text-[0.6875rem] font-medium">
              Model-reported partial run
            </span>
            <span className="block text-[0.625rem] leading-snug text-muted-foreground">
              The model reports that {count(files.length, "note was", "notes were")} kept
              before the run stopped.
            </span>
          </span>
        </div>
      )}

      <ul aria-label="Written notes" className="flex min-w-0 flex-col gap-1.5">
        {files.map((file) => {
          const outcome = outcomeFor(file.relPath);
          const removed =
            outcome?.status === "deleted" || outcome?.status === "skippedMissing";
          return (
            <li key={file.relPath} className="flex min-w-0 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="nn-mono shrink-0 rounded-full bg-muted/40 px-1.5 py-px text-[0.5625rem] uppercase tracking-[0.08em] text-muted-foreground ring-1 ring-inset ring-border">
                  {file.kind}
                </span>
                <button
                  type="button"
                  aria-label={`Open ${file.relPath}`}
                  disabled={removed}
                  onClick={() => onOpen(file.relPath)}
                  className="flex min-h-6 min-w-0 flex-1 rounded-sm text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <PathLabel relPath={file.relPath} />
                </button>
              </div>
              {outcome && (
                <span
                  className={cn(
                    "flex items-start gap-1.5 pl-1 text-[0.625rem] leading-snug",
                    outcome.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground/80",
                  )}
                >
                  <OutcomeGlyph status={outcome.status} />
                  <span className="min-w-0 break-words">{outcomeCopy(outcome)}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {provenance.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border/50 pt-2">
          <p className="text-[0.625rem] font-medium text-muted-foreground">
            Model-reported provenance
          </p>
          <ul aria-label="Model-reported provenance" className="flex flex-wrap gap-1">
            {provenance.map((source) => (
              <li
                key={source}
                title={source}
                className="nn-mono max-w-full truncate rounded-full bg-muted/40 px-2 py-0.5 text-[0.5625rem] text-muted-foreground ring-1 ring-inset ring-border"
              >
                {source}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showUndo && (
        <button
          type="button"
          onClick={() => void runUndo()}
          disabled={undo.status === "running"}
          className={cn(buttonVariants({ tone: "quiet", size: "sm" }), "self-start px-2.5 py-1")}
        >
          {undo.status === "running" ? (
            <Loader2
              className="size-3 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            <Undo2 className="size-3" aria-hidden />
          )}
          {failedCount > 0 || undo.status === "error" ? "Retry undo" : "Undo"}
        </button>
      )}

      {/* Always-mounted status slot: empty it reads as padding; on undo it
          announces the summary politely (partial success is a status, not an
          alert — the per-file rows above carry the detail). */}
      <output className="min-h-4 text-[0.625rem] leading-snug text-muted-foreground/70">
        {report &&
          `Undo finished — ${count(removedCount, "note removed", "notes removed")}` +
            (report.files.length - removedCount > 0
              ? `, ${count(report.files.length - removedCount, "note kept", "notes kept")}.`
              : ".")}
      </output>

      {undo.status === "error" && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[0.6875rem] leading-snug text-destructive"
        >
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{undo.message}</span>
        </p>
      )}
    </section>
  );
}
