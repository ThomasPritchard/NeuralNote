// The security prompt, pinned in the turn it belongs to.
//
// Deliberately NOT a modal. A gated call is a thing the run did, at a point on
// the timeline, and a dialog that steals focus from the whole app would make an
// approval feel like an interruption from somewhere else rather than the next
// step of the thing the user is watching. It follows `ElicitCard`'s anatomy for
// the same reason that card is pinned: the answer belongs where the question
// was asked.
//
// Two departures from `ElicitCard`, both because this one is a SECURITY prompt:
//
//   1. There is a real resolution event. `ElicitCard` has to hold "answered" in
//      the transcript because the reducer keeps its question pinned forever;
//      here `toolApprovalResolved` clears `pendingApproval`, so the sheet simply
//      stops being rendered. Nothing client-side decides whether a call ran.
//   2. A settled run never leaves a live-looking sheet on screen. Rust is the
//      only expiry authority, so a sheet the user leaves open past the timeout
//      is already resolved server-side — it renders dormant, and a late answer
//      reports "not live" rather than approving after the fact.
//
// The composer and Stop are untouched by this component. A gate that disabled
// the user's escape hatch while deciding whether the agent may write to their
// vault would have the priority exactly backwards (§9.5.1).

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, KeyRound, Loader2 } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage, isNotFound } from "../lib/api";
import { cn } from "../lib/cn";
import { buttonVariants } from "@/components/ui/button";
import { APPROVAL_REASON, expiryLine, gatedToolCopy } from "./approvalCopy";
import type { ToolApprovalView } from "./chatMessage";

export function ToolApprovalSheet({
  approval,
  turnId,
  dormant,
}: Readonly<{
  approval: ToolApprovalView;
  /** The owning run's id, sent with the answer so the Rust shell resolves this
   *  run's request and never a sibling run that reused the same call id. */
  turnId: string;
  /** The run ended with this request still open. Rust has already torn the
   *  approval down, so the controls go — an answerable-looking security sheet
   *  that silently no-ops is worse than an honest dead one. */
  dormant: boolean;
}>) {
  const [submitting, setSubmitting] = useState(false);
  /** Flipped when `answer_tool_approval` reports "not live": the request expired
   *  or its run ended between render and click. */
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLElement>(null);
  const headingId = useId();
  const reasonId = useId();

  const copy = gatedToolCopy(approval.tool);
  const settled = dormant || expired;

  // A request that arrives mid-run is the one thing on screen the user can act
  // on, so it takes focus — the announcement is the question itself, via
  // aria-labelledby. Focus lands on the CARD, never on a button: no answer to a
  // security prompt should be one Enter keypress away from a user who was
  // typing something else.
  //
  // This is also the one thing in the pane allowed to move a view the user
  // scrolled away from, and `focus()` scrolling its target into view is how it
  // happens. Deliberate, on two grounds: a request blocks the run and expires in
  // two minutes, so it is not the streaming chatter the never-yank rule exists
  // to protect reading from; and focus that lands off screen is a WCAG 2.4.7
  // failure, so taking focus without the view following would be worse than not
  // taking it. `ChatPaneScroll.browser.test.tsx` pins it in real pixels.
  useEffect(() => {
    if (!dormant) containerRef.current?.focus();
    // Mount-only: the sheet is keyed by approval id, so each request is a fresh
    // mount, and only a request's arrival may move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answer = async (approved: boolean) => {
    if (settled || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.answerToolApproval(turnId, approval.id, approved);
      // No local "answered" state: `toolApprovalResolved` unmounts this sheet.
      // Park focus on the card first so the keyboard user who just answered is
      // not dropped to the document body when the buttons go.
      containerRef.current?.focus();
    } catch (e) {
      if (isNotFound(e)) {
        setExpired(true);
      } else {
        // Validation or transport failure — the request is still live in Rust,
        // so the controls stay usable and the failure is surfaced for a retry
        // rather than swallowed. A security prompt that quietly fails to send
        // is indistinguishable from one that was never answered.
        setError(errorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const expiry = expiryLine(approval.expiresInSecs);
  return (
    <section
      ref={containerRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-describedby={reasonId}
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border px-3 py-2.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
        // The live sheet is the one thing being waited on, so it is the one
        // thing wearing the warning register. A dead one drops to the
        // transcript's quiet voice.
        settled ? "border-border/60 bg-background/30" : "border-warning/40 bg-warning/[0.07]",
      )}
    >
      <p className="flex items-start gap-2">
        <KeyRound
          className={cn(
            "mt-px size-3.5 shrink-0",
            settled ? "text-muted-foreground/60" : "text-warning",
          )}
          aria-hidden
        />
        <span
          id={headingId}
          className="min-w-0 flex-1 text-[0.75rem] font-medium leading-snug text-foreground/90"
        >
          {/* The tool's own plain-language action. An unknown gated tool falls
              back to naming nothing rather than printing an identifier at a
              user who is being asked to make a security decision. */}
          {copy === null
            ? "Allow NeuralNote to run this action?"
            : `Allow NeuralNote to ${copy.action}?`}
        </span>
      </p>

      {approval.relPath !== null && (
        // The real path, for the human. The judge is deliberately given a
        // salted digest instead: two audiences, two trust profiles. A person
        // can read a deceptive filename and is the right party to judge it.
        <p className="nn-mono break-words rounded-md bg-surface-sunken px-2 py-1.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
          {approval.relPath}
        </p>
      )}

      <p id={reasonId} className="text-[0.6875rem] leading-snug text-muted-foreground">
        {approval.reason !== null && APPROVAL_REASON[approval.reason]}
        {approval.reason !== null && expiry !== null && !settled && " "}
        {expiry !== null && !settled && expiry}
      </p>

      {!settled && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Deny is the FIRST tab stop, and the first thing a keyboard user
              reaches from the focused card. The primary tone still sits on the
              right, matching every other decision surface in the app. */}
          <button
            type="button"
            onClick={() => void answer(false)}
            disabled={submitting}
            className={cn(buttonVariants({ tone: "quiet", size: "sm" }), "px-3")}
          >
            Don&apos;t allow
          </button>
          <button
            type="button"
            onClick={() => void answer(true)}
            disabled={submitting}
            className={cn(buttonVariants({ tone: "primary", size: "sm" }), "px-3")}
          >
            {submitting ? (
              <Loader2
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              "Allow"
            )}
          </button>
        </div>
      )}

      {/* Always-mounted status slot: reads as padding while empty, announces the
          expired/ended transitions politely and without a layout jump. */}
      <output className="min-h-4 text-[0.625rem] leading-snug text-muted-foreground/70">
        {expired && "This request expired — nothing ran."}
        {!expired && dormant && "The run ended before this was answered — nothing ran."}
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
