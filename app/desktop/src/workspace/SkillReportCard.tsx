// The skill run's report card: the ledger of notes the run wrote (accumulated
// from `NoteWritten` events — the model's own answer carries the routing
// rationale), plus Undo. Undo reports per-file outcomes verbatim — a file kept
// because the user edited it is surfaced, never folded into a bare "done" —
// and a failed removal keeps the button as "Retry undo" (the backend restores
// its authority over failed runs). The announced summary keeps the same
// distinction (`undoSummary`): a failure is never counted as a note the user
// kept, because the announcement is all a screen reader gets.
//
// Undo is the app's one UNCONFIRMED destructive verb, and it is the only one
// that does not route through the Trash: it unlinks (#208). Everywhere else the
// product teaches the opposite rule — the file-tree delete confirms with "Move
// to Trash" and the release notes promise Trash recovery — so this card carries
// the correction in words, next to the button and tied to it, every time the
// button is offered.

import { useId, useState } from "react";
import { AlertTriangle, Check, FileCheck2, FilePlus2, Info, Loader2, Undo2 } from "lucide-react";
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

/** The permanence Undo owes the user before they press it. Both facts are
 *  load-bearing and both were checked against the backend rather than assumed:
 *  the unlink is `libc::unlinkat` with no Trash involved (`note_writer.rs`), and
 *  an edited note fails the hash check and survives — `undo.rs` maps
 *  `CheckedUnlink::Edited` to `SkippedEdited`, a non-deletion outcome. Stated
 *  plainly rather than loudly: this is the fast correction of an AI action, and
 *  an alarm here would train the user to click past it. */
const UNDO_PERMANENCE_CAVEAT =
  "Undo permanently deletes the notes this run wrote — they don't go to the " +
  "Trash. Notes you've edited since are kept.";

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
      // Not "Removed": that is the word the RECOVERABLE file-tree delete earns,
      // and this file is gone for good.
      return "Deleted permanently — not in the Trash";
    case "skippedEdited":
      return "Kept — it changed since it was written";
    case "skippedMissing":
      return "Already gone";
    case "failed":
      return "Couldn't be removed";
  }
}

/** The one sentence an undo is announced with. Every outcome the backend
 *  reports gets its own word, because a note that FAILED to delete is not a note
 *  the user chose to keep — folding the two together describes a clean,
 *  intentional result at the exact moment nothing worked. This `<output>` is the
 *  only part of the card a screen reader hears; the per-file rows carry the
 *  detail silently, so the failure has to be audible here or nowhere (#208).
 *
 *  Failures lead the sentence and change the verdict word — "finished" is a
 *  claim about the whole run — and a zero says nothing at all, so the ordinary
 *  clean case stays one short clause. */
function undoSummary(files: readonly UndoFileResult[]): string {
  const tally = (status: UndoFileResult["status"]) =>
    files.filter((file) => file.status === status).length;
  const failed = tally("failed");
  const parts = [
    { n: failed, label: "couldn't be removed" },
    { n: tally("deleted"), label: "deleted" },
    { n: tally("skippedEdited"), label: "kept" },
    { n: tally("skippedMissing"), label: "already gone" },
  ].filter((part) => part.n > 0);

  if (parts.length === 0) return "Undo finished — no notes to remove.";
  // The noun rides the first clause only: "1 note deleted, 1 kept" is one
  // sentence, where repeating "note" in every clause reads as a list of four.
  const clauses = parts.map((part, index) =>
    index === 0
      ? `${count(part.n, "note", "notes")} ${part.label}`
      : `${part.n} ${part.label}`,
  );
  return `${failed > 0 ? "Undo incomplete" : "Undo finished"} — ${clauses.join(", ")}.`;
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
 *  so a long path elides in the middle rather than eating the filename. Shared
 *  with `ChatNoteEditCard` so a note reads identically while it is being written
 *  and once it has landed. */
export function PathLabel({ relPath }: Readonly<{ relPath: string }>) {
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

/** One row of the ledger: the requested kind, and the path as a button that
 *  opens it. Shared by both groups so a note reads the same whether this run
 *  wrote it or found it already there. */
function LedgerRow({
  file,
  disabled,
  onOpen,
}: Readonly<{
  file: { relPath: string; kind: NoteKind };
  disabled: boolean;
  onOpen: (relPath: string) => void;
}>) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="nn-mono shrink-0 rounded-full bg-muted/40 px-1.5 py-px text-[0.5625rem] uppercase tracking-[0.08em] text-muted-foreground ring-1 ring-inset ring-border">
        {file.kind}
      </span>
      <button
        type="button"
        aria-label={`Open ${file.relPath}`}
        disabled={disabled}
        onClick={() => onOpen(file.relPath)}
        className="flex min-h-6 min-w-0 flex-1 rounded-sm text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45"
      >
        <PathLabel relPath={file.relPath} />
      </button>
    </div>
  );
}

export function SkillReportCard({
  files,
  existing = [],
  runId,
  done,
  partial = false,
  provenance = [],
  onOpen = () => undefined,
}: Readonly<{
  /** The `NoteWritten` accumulation, in write order. */
  files: ReadonlyArray<{ relPath: string; kind: NoteKind }>;
  /** The `NoteExists` accumulation: create-only writes that hit a note the user
   *  already had. Nothing landed on disk for these, so they are listed apart and
   *  never counted as written — and Undo has nothing of theirs to remove. */
  existing?: ReadonlyArray<{ relPath: string; kind: NoteKind }>;
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
  const caveatId = useId();

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

  // The button's four lives: absent when nothing was written (an already-present
  // note is not this run's to remove), fresh Undo, a retry after any failure, and
  // gone once every file reached a terminal non-failed outcome.
  const showUndo =
    done &&
    runId !== null &&
    files.length > 0 &&
    (undo.status === "idle" ||
      undo.status === "running" ||
      undo.status === "error" ||
      failedCount > 0);

  return (
    <section
      aria-label="Notes from this run"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 bg-background/30 px-3 py-2.5"
    >
      {files.length > 0 && (
        <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-foreground/80">
          <FilePlus2 className="size-3.5 shrink-0 text-primary" aria-hidden />
          {count(files.length, "note written", "notes written")}
        </p>
      )}

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

      {files.length > 0 && (
        <ul aria-label="Written notes" className="flex min-w-0 flex-col gap-1.5">
          {files.map((file) => {
            const outcome = outcomeFor(file.relPath);
            const removed =
              outcome?.status === "deleted" || outcome?.status === "skippedMissing";
            return (
              <li key={file.relPath} className="flex min-w-0 flex-col gap-0.5">
                <LedgerRow file={file} disabled={removed} onOpen={onOpen} />
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
      )}

      {existing.length > 0 && (
        // A create-only write that hit a note the user already had wrote
        // NOTHING. Listing these among the written ones would claim authorship
        // of the user's own note and offer to "undo" a file this run never
        // touched — so they get their own labelled group, their own quieter
        // glyph, and no Undo. The no-op is still surfaced: silence here is what
        // #108 was about.
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-muted-foreground">
            <FileCheck2 className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
            {count(existing.length, "note", "notes")} already in your vault
          </p>
          <ul
            aria-label="Notes that already existed"
            className="flex min-w-0 flex-col gap-1.5"
          >
            {existing.map((file) => (
              <li key={file.relPath} className="flex min-w-0 flex-col gap-0.5">
                <LedgerRow file={file} disabled={false} onOpen={onOpen} />
                <span className="pl-1 text-[0.625rem] leading-snug text-muted-foreground/80">
                  Left as it was — nothing was written
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
        // The warning and the button ship as one unit, so the button can never
        // be offered without it. Static copy, not a live region: the <output>
        // below owns announcements and a second one would talk over it —
        // `aria-describedby` is what carries the caveat to a screen reader, at
        // the moment focus reaches the control. The tone rides on the glyph and
        // the body stays `text-foreground/90` (9.7:1 on the dark theme, 12.0:1
        // on the light ones), because `text-warning` as body copy measures 3.4:1
        // at this size — the same split `KeyChangeCaveat` already makes.
        <div className="flex min-w-0 flex-col gap-1.5">
          <p
            id={caveatId}
            className="flex items-start gap-1.5 text-[0.625rem] leading-snug text-foreground/90"
          >
            <AlertTriangle className="mt-px size-3 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 flex-1 break-words">{UNDO_PERMANENCE_CAVEAT}</span>
          </p>
          <button
            type="button"
            onClick={() => void runUndo()}
            disabled={undo.status === "running"}
            aria-describedby={caveatId}
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
        </div>
      )}

      {/* Always-mounted status slot: empty it reads as padding; on undo it
          announces the summary politely (partial success is a status, not an
          alert — the per-file rows above carry the detail). A summary that
          reports a failure is lifted out of the quiet grey: the sighted reader
          gets the same weight the announcement carries, without a second tone
          colour as body copy at this size. */}
      <output
        className={cn(
          "min-h-4 text-[0.625rem] leading-snug",
          failedCount > 0 ? "text-foreground/90" : "text-muted-foreground/70",
        )}
      >
        {report && undoSummary(report.files)}
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
