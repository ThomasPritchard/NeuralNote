// The chat pane's view model + the pure event reducer. A chat is a list of
// `ChatMessage`s; an assistant turn accumulates the streamed `ChatEvent`s (the
// live search/read/verify "harness" log, the streamed answer, cited sources,
// and a coverage footer). Keeping the fold pure and framework-free makes the
// harness feel unit-testable without React.

import type { ChatEvent, ChatTurn } from "../lib/types";

/** One row in the live activity log — the visible trace of the agent working. */
export type ActivityStep =
  | { kind: "search"; query: string; hitCount?: number }
  | { kind: "reading"; relPath: string; startLine: number; endLine: number }
  | { kind: "verifying" }
  | { kind: "dropped"; reason: string };

/** A verified citation the answer leans on — the click target that opens the
 *  cited note. Mirrors the `citation` ChatEvent minus its discriminant. */
export interface CitationView {
  id: string;
  relPath: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** The coverage footer — how much of the vault the turn actually saw, kept
 *  honest (partial/skipped coverage is surfaced, never hidden). */
export interface CoverageView {
  searchedTerms: string[];
  notesRead: string[];
  truncated: boolean;
  skippedFiles: number;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  /** The live "searching / reading / verifying" trace, in order. */
  activity: ActivityStep[];
  /** Pinned at turn creation because reasoning can be toggled off mid-stream;
   *  the finished turn stays self-describing against the opt-in it ran under. */
  reasoningRequested: boolean;
  /** Optional streamed reasoning tokens (rendered collapsed). */
  thinking: string;
  /** The streamed answer markdown, accumulated delta by delta. */
  answer: string;
  citations: CitationView[];
  coverage: CoverageView | null;
  /** A surfaced, non-fatal turn error — shown inline, never swallowed. */
  error: string | null;
  /** True once the run ended (a `done` or `error` event). */
  done: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage;

export function userMessage(content: string): UserMessage {
  return { role: "user", content };
}

/** A fresh assistant turn, before any event has landed. */
export function emptyAssistant(reasoningRequested = false): AssistantMessage {
  return {
    role: "assistant",
    activity: [],
    reasoningRequested,
    thinking: "",
    answer: "",
    citations: [],
    coverage: null,
    error: null,
    done: false,
  };
}

/** Reasoning was requested but the model streamed no thinking tokens. */
export function showsReasoningBackstop(turn: AssistantMessage): boolean {
  // A failed run has a bigger problem to report; stacking this notice would
  // bury the real one.
  //
  // `trim()` rather than `=== ""` so this agrees with the `Reasoning`
  // disclosure, which hides itself on whitespace. A lone "\n" delta would
  // otherwise render no trace *and* suppress the notice explaining why.
  return (
    turn.done &&
    turn.reasoningRequested &&
    turn.thinking.trim() === "" &&
    turn.error === null
  );
}

/** The turn searched the vault and genuinely found nothing to cite.
 *
 *  Zero surviving citations does not mean the vault held nothing — it can also
 *  mean a note was read and the model answered without an [eN] marker, or the
 *  verifier dropped the quote. In either of those the vault *did* cover it, so
 *  "nothing covers this" would be a false claim about the user's own notes. The
 *  card fires only when the turn read nothing (`notesRead` empty) and dropped
 *  nothing; otherwise the footer and the model's own answer carry the account. */
export function showsNothingFoundCard(turn: AssistantMessage): boolean {
  return (
    turn.done &&
    turn.error === null &&
    turn.coverage !== null &&
    turn.coverage.searchedTerms.length > 0 &&
    turn.coverage.notesRead.length === 0 &&
    turn.citations.length === 0 &&
    !turn.activity.some((step) => step.kind === "dropped")
  );
}

/** Fold a `retrieved` event into the matching `searching` row (→ "searching X →
 *  N notes"). Falls back to a standalone row if no pending search matches — a
 *  retrieval count is never dropped just because its search row went missing. */
function withHitCount(
  steps: ActivityStep[],
  query: string,
  hitCount: number,
): ActivityStep[] {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.kind === "search" && step.query === query && step.hitCount === undefined) {
      const next = steps.slice();
      next[i] = { ...step, hitCount };
      return next;
    }
  }
  return [...steps, { kind: "search", query, hitCount }];
}

/** Immutably fold one streamed `ChatEvent` into the assistant turn's view
 *  state. Total over the `ChatEvent` union — a new variant is a compile error
 *  here, so the UI can never silently ignore a backend event. */
export function reduceAssistant(
  turn: AssistantMessage,
  event: ChatEvent,
): AssistantMessage {
  switch (event.type) {
    case "searching":
      return { ...turn, activity: [...turn.activity, { kind: "search", query: event.query }] };
    case "retrieved":
      return { ...turn, activity: withHitCount(turn.activity, event.query, event.hitCount) };
    case "reading":
      return {
        ...turn,
        activity: [
          ...turn.activity,
          { kind: "reading", relPath: event.relPath, startLine: event.startLine, endLine: event.endLine },
        ],
      };
    case "verifying":
      return { ...turn, activity: [...turn.activity, { kind: "verifying" }] };
    case "citationDropped":
      return { ...turn, activity: [...turn.activity, { kind: "dropped", reason: event.reason }] };
    case "thinking":
      return { ...turn, thinking: turn.thinking + event.delta };
    case "answer":
      return { ...turn, answer: turn.answer + event.delta };
    case "citation":
      return {
        ...turn,
        citations: [
          ...turn.citations,
          {
            id: event.id,
            relPath: event.relPath,
            startLine: event.startLine,
            endLine: event.endLine,
            text: event.text,
          },
        ],
      };
    case "coverage":
      return {
        ...turn,
        coverage: {
          searchedTerms: event.searchedTerms,
          notesRead: event.notesRead,
          truncated: event.truncated,
          skippedFiles: event.skippedFiles,
        },
      };
    case "error":
      // A run ends on `error` too — mark it done so the working indicator
      // clears, but keep the message visible.
      return { ...turn, error: event.message, done: true };
    case "done":
      return { ...turn, done: true };
  }
}

/** Resolve `[eN]` citation markers in an answer against the verified citations.
 *  Citations arrive only after the answer has streamed, so while the turn is
 *  still running the markers are left exactly as the model emitted them. Once the
 *  turn is `done`, any `[eN]` with no matching verified citation was dropped by
 *  the verifier or hallucinated by the model — strip it (and a leading space) so
 *  a discredited citation is never left showing as a live reference. Citation
 *  fidelity is the moat: a marker pointing at nothing is a broken citation. */
export function resolveAnswerMarkers(
  answer: string,
  citations: CitationView[],
  done: boolean,
): string {
  if (!done) return answer;
  const verified = new Set(citations.map((c) => c.id));
  // Case-insensitive to mirror the Rust citation extractor (which accepts `[E9]`
  // and folds to lowercase); compare against the lowercased id the citation carries.
  return answer.replace(/ ?\[(e\d+)\]/gi, (whole, id: string) =>
    verified.has(id.toLowerCase()) ? whole : "",
  );
}

/** A `reading` step with the number of times that note was read consecutively
 *  folded in — so five back-to-back reads of one note render as one row (`×5`),
 *  not five identical lines. Its range widens to span every folded read. */
export type GroupedStep =
  | { kind: "search"; query: string; hitCount?: number }
  | { kind: "reading"; relPath: string; startLine: number; endLine: number; count: number }
  | { kind: "verifying" }
  | { kind: "dropped"; reason: string };

/** Collapse *consecutive* reads of the same note into a single counted row. Only
 *  consecutive runs merge, so the trace stays in execution order (a note re-read
 *  after other steps still shows again) — the common bloat case is a burst of reads
 *  of one note, which this flattens. Searches stay per-row: distinct queries are the
 *  point of the "watch it search" trace. */
export function groupActivity(activity: ActivityStep[]): GroupedStep[] {
  const out: GroupedStep[] = [];
  for (const step of activity) {
    const last = out.at(-1);
    if (step.kind === "reading" && last?.kind === "reading" && last.relPath === step.relPath) {
      last.count += 1;
      last.startLine = Math.min(last.startLine, step.startLine);
      last.endLine = Math.max(last.endLine, step.endLine);
      continue;
    }
    out.push(step.kind === "reading" ? { ...step, count: 1 } : step);
  }
  return out;
}

/** The one-line footer the collapsed trace shows once the turn is done. `notesRead`
 *  counts *distinct* notes (provenance honesty — reading one note five times is one
 *  source, not five), `dropped` counts discarded citations (surfaced, never hidden —
 *  a dropped citation is the moat's honesty signal). */
export interface ActivitySummary {
  searches: number;
  notesRead: number;
  dropped: number;
  verified: boolean;
  totalSteps: number;
}

export function summarizeActivity(activity: ActivityStep[]): ActivitySummary {
  let searches = 0;
  let dropped = 0;
  let verified = false;
  const notes = new Set<string>();
  for (const step of activity) {
    switch (step.kind) {
      case "search":
        searches += 1;
        break;
      case "reading":
        notes.add(step.relPath);
        break;
      case "verifying":
        verified = true;
        break;
      case "dropped":
        dropped += 1;
        break;
    }
  }
  return { searches, notesRead: notes.size, dropped, verified, totalSteps: activity.length };
}

/** Strip every `[eN]` citation marker from a prior answer before it re-enters a
 *  later turn's context. Evidence ids are assigned fresh per run (the Rust registry
 *  starts empty each `run_chat`), so a marker carried forward refers to nothing in
 *  the new turn's registry — and if the model echoes it, the verifier can validate it
 *  against an *unrelated* freshly-retrieved span, surfacing as a "verified" citation
 *  whose source text doesn't match the prose claim (SUS-1 — the exact failure the moat
 *  forbids). History is plain conversational context, so the markers add nothing;
 *  dropping all of them (verified or not) closes the hole at the source. */
export function stripCitationMarkers(answer: string): string {
  return answer.replace(/ ?\[e\d+\]/gi, "");
}

/** Cap on how many prior turns are resent as context. Without it, every `chat`
 *  request carries the entire transcript, so per-turn token cost grows linearly with
 *  conversation length and a long chat eventually trips the provider's context limit
 *  (PA-003). We keep the most recent turns and drop older ones — recency is what the
 *  next answer usually needs. (The core separately caps tool-result content within a
 *  run via `max_context_chars`; this bounds the conversation history.) */
const MAX_HISTORY_TURNS = 20;

/** The prior conversation as plain `ChatTurn`s, for the next `chat` request.
 *  Empty assistant turns (errored / no answer) are dropped so the model isn't
 *  handed blank context; `[eN]` markers are stripped so stale ids can't re-enter a
 *  later run and mis-cite (see `stripCitationMarkers`); and the history is windowed
 *  to the last `MAX_HISTORY_TURNS` so per-turn cost stays bounded (see above). */
export function toHistory(messages: ChatMessage[]): ChatTurn[] {
  return messages
    .map((m): ChatTurn =>
      m.role === "user"
        ? { role: "user", content: m.content }
        : { role: "assistant", content: stripCitationMarkers(m.answer) },
    )
    .filter((turn) => turn.content.trim() !== "")
    .slice(-MAX_HISTORY_TURNS);
}
