// What the UI may honestly SAY about a turn: the readings derived from a run's
// accumulated state, rather than a second copy stored beside it.
//
// It lives apart from `chatMessage.ts` because that file is the vocabulary —
// what a turn accumulates — while this one is the claims made over it, and the
// claims are where the moat is kept. Every function here exists because a looser
// earlier reading told the user something untrue about their own vault:
// provenance scraped out of model prose, "nothing found" over a vault that
// demonstrably covered it, an `[eN]` marker left pointing at nothing, a summary
// that reported what had been READ as what had been FOUND.
//
// Derived, never stored. Two stores of the same fact eventually disagree, and
// the one a user reads to judge an answer is not the place for that.

import type {
  ActivityStep,
  AssistantMessage,
  CitationView,
  ReasoningSource,
} from "./chatMessage";

/** The distinct transcript-source labels this run reported, in first-seen order.
 *
 *  These come from the `transcriptSource` events the fetching tools emit, so they
 *  say where the text actually came from. They used to be regexed out of
 *  concatenated model prose, which meant any answer that merely *quoted* a label
 *  claimed it as provenance — a false claim about the source of the user's own
 *  notes, which is the one thing this app must never make. */
export function modelReportedProvenance(turn: AssistantMessage): string[] {
  return [...new Set(turn.transcriptSources.map((source) => source.label))];
}

/** Whether a settled skill run wrote notes but did not finish its work.
 *
 *  Both signals are authoritative: `stopped` is the user's own stop, and
 *  `partialRun` is the orchestrator reporting a guard it tripped or a
 *  cancellation it honoured. This used to test the model's prose for
 *  "cancelled|stopped|partial", so an answer that merely mentioned the word
 *  reported a complete run as incomplete. */
export function isPartialSkillRun(turn: AssistantMessage): boolean {
  if (
    !turn.done ||
    turn.skillActivations.length === 0 ||
    turn.writtenNotes.length === 0
  ) {
    return false;
  }
  return turn.stopped || turn.partialRun !== null;
}

/** The turn searched the vault and genuinely found nothing to cite.
 *
 *  Zero surviving citations does not mean the vault held nothing — it can also
 *  mean a note was read and the model answered without an [eN] marker, the
 *  verifier dropped the quote, or the search returned spans the model never
 *  opened. In every one of those the vault *did* cover it, so "nothing covers
 *  this" would be a false claim about the user's own notes.
 *
 *  Coverage decides whether the card is eligible; the activity log only ever
 *  vetoes it. A dropped citation is one veto and a search that reported spans is
 *  another — the second was missing, so the card made the same false claim as
 *  the rail summary in #122, one line lower and in bigger type. A search still
 *  awaiting its `retrieved` event vetoes it too: nothing has confirmed the vault
 *  is empty, and "not yet known" must not render as "no". */
export function showsNothingFoundCard(turn: AssistantMessage): boolean {
  const retrieval = searchOutcome(turn.activity).kind;
  // `none` is not a veto: the activity log simply has nothing to say about
  // retrieval, and coverage governs exactly as it did before hit counts existed.
  const retrievalAgrees = retrieval === "empty" || retrieval === "none";
  return (
    turn.done &&
    !turn.stopped &&
    turn.error === null &&
    turn.coverage !== null &&
    turn.coverage.searchedTerms.length > 0 &&
    turn.coverage.notesRead.length === 0 &&
    turn.citations.length === 0 &&
    retrievalAgrees &&
    !turn.activity.some((step) => step.kind === "dropped")
  );
}

/** One train of thought, and which turn of the run produced it. */
export interface ReasoningSegment {
  source: ReasoningSource;
  text: string;
}

/** The turn's reasoning as the separate trains of thought it actually was.
 *
 *  A run reasons on every tool-deciding round and again on the answer turn, and
 *  those are different trains of thought about different questions. Rendered as
 *  one string they read as a single rambling one, which is what the boundaries
 *  exist to end.
 *
 *  A segment that reasoned about nothing is left out rather than rendered as an
 *  empty labelled fold — a disclosure that opens onto nothing is worse than no
 *  disclosure. Text arriving before any boundary keeps its own leading segment
 *  rather than being attributed to whichever turn came next.
 */
export function reasoningSegments(turn: AssistantMessage): ReasoningSegment[] {
  const { thinking, reasoningBoundaries: boundaries } = turn;
  const segments: ReasoningSegment[] = [];
  const add = (source: ReasoningSource, from: number, to: number) => {
    const text = thinking.slice(from, to);
    if (text.trim() !== "") segments.push({ source, text });
  };
  const endOf = (index: number) => boundaries[index]?.at ?? thinking.length;

  add({ kind: "unattributed" }, 0, endOf(0));
  boundaries.forEach((boundary, index) => {
    add(boundary.source, boundary.at, endOf(index + 1));
  });
  return segments;
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

/** What a turn's searches have said about the vault. Three states, not two.
 *
 *  A search reports its hit count in a *separate* `retrieved` event, so between
 *  `searching` and `retrieved` the count is `undefined` — and `undefined` is
 *  "hasn't said yet", never zero. Collapsing those two into one boolean is what
 *  produced #122: the summary tested whether anything had been READ and then
 *  told the user nothing had been FOUND. They are different events, and the gap
 *  between them is routine — searches return spans and the model decides none
 *  are worth opening. Telling a user their vault holds nothing on a subject it
 *  demonstrably covers is a false claim about their own notes, which is the same
 *  class of failure as a wrong citation. */
export type RetrievalOutcome =
  /** No search ran, so there is no retrieval to report on. */
  | { kind: "none" }
  /** Every search that reported came back empty. The only state in which
   *  "nothing found" is a true statement about the vault. */
  | { kind: "empty" }
  /** A search is still to report and nothing has come back yet, so neither
   *  outcome may be claimed. Silence is the only honest answer here. */
  | { kind: "pending" }
  /** The vault returned `spans`. Whether any were opened is a separate question
   *  the model answers, and `notesRead` is where that is counted. */
  | { kind: "hits"; spans: number };

/** `hits` wins over `pending`: once one search has reported spans, retrieval
 *  demonstrably found something and a later straggler cannot unsay it. Only the
 *  empty-versus-not-yet distinction actually needs the pending guard. */
export function searchOutcome(activity: ActivityStep[]): RetrievalOutcome {
  let searches = 0;
  let spans = 0;
  let awaitingReport = false;
  for (const step of activity) {
    if (step.kind !== "search") continue;
    searches += 1;
    if (step.hitCount === undefined) awaitingReport = true;
    else spans += step.hitCount;
  }
  if (searches === 0) return { kind: "none" };
  if (spans > 0) return { kind: "hits", spans };
  return awaitingReport ? { kind: "pending" } : { kind: "empty" };
}
