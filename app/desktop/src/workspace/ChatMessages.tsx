// Renders the chat transcript: user prompts, and assistant turns as the live
// "harness" trace — a step-by-step activity log (searching / reading /
// verifying / dropped), optional collapsed reasoning, the streamed markdown
// answer, clickable source chips, a coverage footer, and a surfaced inline
// error. Presentational only; all state folding lives in `chatMessage.ts`. The
// per-part views (activity trace, skill chrome, sources, turn notices) live in
// sibling modules; this file composes them into a turn and the transcript.

import { useCallback, useState } from "react";
import { AlertTriangle, Square } from "lucide-react";
import { ElicitCard } from "./ElicitCard";
import { Markdown } from "./Markdown";
import { SkillReportCard } from "./SkillReportCard";
import {
  isPartialSkillRun,
  modelReportedProvenance,
  resolveAnswerMarkers,
  showsNothingFoundCard,
} from "./chatMessage";
import type {
  AssistantMessage,
  ChatMessage,
  CitationView,
} from "./chatMessage";
import { ActivityTrace } from "./ChatActivityTrace";
import { SkillActivations, SkillSteps } from "./ChatSkillChrome";
import { Sources } from "./ChatSources";
import { CoverageFooter, NothingFoundCard, Reasoning } from "./ChatTurnNotices";

// Re-exported so `playfulProgressCopy.test.ts` (and any other importer) can keep
// pulling it from "./ChatMessages" even though it now lives in its own module.
export { playfulProgressCopy } from "./playfulProgressCopy";

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
      {turn.stopped && (
        <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-muted-foreground">
          <Square className="size-3 fill-current" aria-hidden />
          Stopped
        </p>
      )}
      <Reasoning text={turn.thinking} />
      {turn.pendingElicitation !== null && turn.turnId !== null && (
        // Keyed by elicitation id: a follow-up question in the same turn is a
        // fresh card (fresh focus, fresh state), never a half-answered reuse.
        <ElicitCard
          key={turn.pendingElicitation.id}
          elicitation={turn.pendingElicitation}
          turnId={turn.turnId}
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
      {turn.truncated && (
        // The answer hit the model's length ceiling. Calm, token-only notice
        // (mirrors the coverage footer's truncation banner): informational and
        // visible, never the destructive/alert register — the partial answer
        // and its citations above are still valid, just incomplete.
        <p className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">
          Response was cut off at the model&apos;s length limit.
        </p>
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
