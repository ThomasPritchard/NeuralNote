// A skill run's structured question, rendered as clickable controls: a button
// group (single-select) or a tick-list with a confirm button (multi-select,
// with thumbnails when the options carry them). Calls `answer_elicitation`
// exactly once on success and pins the chosen options; per spec §3.4 the
// 5-minute timeout ends the RUN, not the QUESTION — a timed-out card is never
// PERMANENTLY disabled: it renders dormant but stays clickable (inert only
// transiently while a newer run streams), and a late click simply continues
// the chat as an ordinary turn (history carries the context, so nothing is
// re-pasted).

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage, isNotFound } from "../lib/api";
import { cn } from "../lib/cn";
import type { ElicitOption } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import type { PendingElicitation } from "./chatMessage";

const OPTION_ROW =
  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ring-1 ring-inset transition-colors motion-reduce:transition-none";

/** The option's visible body: optional thumbnail, label, quiet description.
 *  Thumbnails are `data:` URIs fetched in Rust (spec §3.4) and decorative —
 *  the label names the option, so `alt=""` keeps them silent for SR users. */
function OptionBody({ option }: Readonly<{ option: ElicitOption }>) {
  return (
    <>
      {option.imageDataUri !== null && (
        <img
          src={option.imageDataUri}
          alt=""
          className="size-10 shrink-0 rounded-md object-cover ring-1 ring-inset ring-border"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[0.75rem] font-medium leading-snug text-foreground/90">
          {option.label}
        </span>
        {option.description !== null && (
          <span className="mt-0.5 block text-[0.6875rem] leading-snug text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
    </>
  );
}

export function ElicitCard({
  elicitation,
  turnId,
  dormant,
  busy,
  answer,
  onAnswered,
  onSendFollowUp,
}: Readonly<{
  elicitation: PendingElicitation;
  /** The owning run's id, sent with the answer so the Rust shell resolves this
   *  run's question and never a sibling run that reused the same elicitation id. */
  turnId: string;
  /** The run ended with this question unanswered (timeout / error) — render
   *  the quiet register and route clicks into chat. Never PERMANENTLY
   *  disabled: dormant stays clickable per spec §3.4, inert only transiently
   *  while a newer run streams (`busy`). */
  dormant: boolean;
  /** A newer run is streaming; dormant follow-up sends must wait for it. */
  busy: boolean;
  /** The chosen option ids once answered — held by the transcript (parent),
   *  so the card's terminal state survives its own re-renders. */
  answer: readonly string[] | undefined;
  onAnswered: (id: string, choices: string[]) => void;
  /** Issues an ordinary chat turn — the dormant card's whole affordance. */
  onSendFollowUp: (text: string) => void;
}>) {
  const { id, question, options, multiSelect } = elicitation;
  const [submitting, setSubmitting] = useState(false);
  // Flipped when answer_elicitation rejects with "not live": the backend has
  // timed the question out, so the card drops to the dormant register and
  // later clicks continue the chat instead. Never PERMANENTLY disabled —
  // dormant stays clickable per spec §3.4; inert only transiently while a
  // newer run streams (`busy`).
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const containerRef = useRef<HTMLElement>(null);
  const questionId = useId();

  const answered = answer !== undefined;
  // Clicks no longer reach the parked elicitation — they continue the chat.
  const fallback = dormant || expired;

  // A question that arrives mid-run is the one actionable thing on screen (the
  // composer is disabled while the run streams), so it takes focus — the SR
  // announcement is the question itself via aria-labelledby. Dormant/answered
  // cards re-rendered from history never steal focus.
  useEffect(() => {
    if (!dormant && answer === undefined) containerRef.current?.focus();
    // Mount-only on purpose: the card is keyed by elicitation id, so a new
    // question is a fresh mount — and only its arrival may move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (choices: string[], labels: string[]) => {
    if (answered || submitting) return;
    if (fallback) {
      // An expired question costs the user nothing: the click becomes an
      // ordinary turn and the model picks the thread back up from history.
      if (!busy) onSendFollowUp(labels.join(", "));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.answerElicitation(turnId, id, choices);
      // The clicked control is about to disable — park focus on the card
      // first so keyboard users aren't dropped to the document body.
      containerRef.current?.focus();
      onAnswered(id, choices);
    } catch (e) {
      if (isNotFound(e)) {
        setExpired(true);
      } else {
        // Validation/transport failures leave the prompt live server-side —
        // surfaced for retry, never swallowed.
        setError(errorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const toggleTick = (optionId: string) => {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(optionId)) next.delete(optionId);
      else next.add(optionId);
      return next;
    });
  };

  const confirmSelection = () => {
    const chosen = options.filter((o) => ticked.has(o.id));
    void submit(
      chosen.map((o) => o.id),
      chosen.map((o) => o.label),
    );
  };

  // Terminal/dormant cards drop to the transcript's quiet register; only a
  // live question carries the primary tint — it's the one thing being waited
  // on, and the accent should mean exactly that.
  const quiet = answered || fallback;

  return (
    <section
      ref={containerRef}
      tabIndex={-1}
      aria-labelledby={questionId}
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border px-3 py-2.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
        quiet ? "border-border/60 bg-background/30" : "border-primary/30 bg-primary/[0.06]",
      )}
    >
      <p
        id={questionId}
        className="text-[0.75rem] font-medium leading-snug text-foreground/90"
      >
        {question}
      </p>

      {multiSelect ? (
        <>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/30 px-2.5 py-1.5">
            <span className="nn-mono text-[0.625rem] text-muted-foreground">
              {answered ? answer.length : ticked.size} selected on this page
            </span>
            {!answered && (
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setTicked(new Set(options.map((option) => option.id)))}
                  disabled={submitting || ticked.size === options.length}
                  className="text-[0.625rem] font-medium text-primary transition-colors hover:text-primary/80 disabled:text-muted-foreground/50"
                >
                  Select page
                </button>
                <span className="text-border" aria-hidden>
                  /
                </span>
                <button
                  type="button"
                  onClick={() => setTicked(new Set())}
                  disabled={submitting || ticked.size === 0}
                  className="text-[0.625rem] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:text-muted-foreground/40"
                >
                  Clear page
                </button>
              </span>
            )}
          </div>
          <ul aria-label="Choices" className="flex flex-col gap-1.5">
            {options.map((option) => {
              const chosen = answered
                ? answer.includes(option.id)
                : ticked.has(option.id);
              return (
                <li key={option.id}>
                  <label
                    className={cn(
                      OPTION_ROW,
                      chosen ? "bg-primary/10 ring-primary/40" : "ring-border",
                      answered && !chosen && "opacity-50",
                      answered || submitting
                        ? "cursor-default"
                        : "cursor-pointer hover:bg-muted/40 hover:ring-primary/30",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={chosen}
                      // Deliberately NO `fallback && busy` term (unlike the
                      // Confirm button below and the single-select rows): a
                      // tick is local state, not a send, so the user can line
                      // up a dormant selection while a newer run streams —
                      // only Confirm, the control that actually sends, waits
                      // on `busy`.
                      disabled={answered || submitting}
                      onChange={() => toggleTick(option.id)}
                      className="size-3.5 shrink-0 accent-primary"
                    />
                    <OptionBody option={option} />
                  </label>
                </li>
              );
            })}
          </ul>
          {!answered && (
            <button
              type="button"
              onClick={confirmSelection}
              disabled={ticked.size === 0 || submitting || (fallback && busy)}
              className={cn(buttonVariants({ tone: "primary", size: "sm" }), "self-start px-3")}
            >
              {submitting ? (
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : (
                "Confirm selection"
              )}
            </button>
          )}
        </>
      ) : (
        <ul aria-label="Choices" className="flex flex-col gap-1.5">
          {options.map((option) => {
            const chosen = answered && answer.includes(option.id);
            return (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => void submit([option.id], [option.label])}
                  disabled={answered || submitting || (fallback && busy)}
                  className={cn(
                    OPTION_ROW,
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    chosen ? "bg-primary/10 ring-primary/40" : "ring-border",
                    answered && !chosen && "opacity-50",
                    answered || submitting
                      ? "cursor-default"
                      : "hover:bg-muted/40 hover:ring-primary/30",
                  )}
                >
                  <OptionBody option={option} />
                  {chosen && (
                    <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Always-mounted status slot: reads as padding while empty, announces
          the answered/expired transitions politely without layout jump. */}
      <output className="min-h-4 text-[0.625rem] leading-snug text-muted-foreground/70">
        {answered && "Answered."}
        {!answered &&
          expired &&
          "This question expired — picking an answer continues the chat."}
      </output>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[0.6875rem] leading-snug text-destructive"
        >
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{error}</span>
        </p>
      )}
    </section>
  );
}
