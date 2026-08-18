// The readings the UI derives from a settled turn — what it may honestly SAY
// about a run, as opposed to what the run accumulated. Every case here guards a
// claim about the user's own vault: where a transcript came from, whether a
// skill run finished, whether the vault genuinely held nothing, which train of
// thought a passage of reasoning belonged to, and whether a citation marker
// still points at a verified span.
//
// Split out of `chatMessage.test.ts` alongside the module it covers.

import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../lib/types";
import {
  emptyAssistant,
  type ActivityStep,
  type AssistantMessage,
  type CitationView,
} from "./chatMessage";
import { reduceAssistant } from "./chatMessageReducer";
import {
  isPartialSkillRun,
  modelReportedProvenance,
  reasoningSegments,
  resolveAnswerMarkers,
  searchOutcome,
  showsNothingFoundCard,
  summarizeActivity,
} from "./chatTurnReadouts";

/** Fold a whole event script over a fresh assistant turn. */
function run(events: ChatEvent[]): AssistantMessage {
  return events.reduce(reduceAssistant, emptyAssistant());
}

describe("skill report context", () => {
  it("reports the transcript sources the backend named, in first-seen order", () => {
    const turn = run([
      { type: "transcriptSource", label: "captions:en-auto", relPath: null },
      { type: "transcriptSource", label: "whisper:small.en", relPath: null },
      { type: "transcriptSource", label: "captions:en-auto", relPath: null },
    ]);

    expect(modelReportedProvenance(turn)).toEqual([
      "captions:en-auto",
      "whisper:small.en",
    ]);
  });

  it("never mistakes a transcript label mentioned in prose for a real source", () => {
    // The old regex scraped `captions:`/`whisper:` out of concatenated model
    // prose, so any answer that merely QUOTED a label claimed it as provenance.
    const turn = {
      ...emptyAssistant(),
      skillSteps: ["Video 1 of 3 landed with captions:en-auto."],
      answer: "Transcript provenance: whisper:small.en",
    };

    expect(modelReportedProvenance(turn)).toEqual([]);
  });

  it("marks a settled skill run partial only when the backend said it was", () => {
    const partial = {
      ...emptyAssistant(),
      done: true,
      skillActivations: [{ id: "youtube-distil", name: "YouTube distil" }],
      writtenNotes: [{ relPath: "Literature/One.md", kind: "literature" as const }],
      partialRun: "the run was stopped before it finished every item",
    };
    expect(isPartialSkillRun(partial)).toBe(true);
    expect(isPartialSkillRun({ ...partial, writtenNotes: [] })).toBe(false);
    expect(isPartialSkillRun({ ...partial, done: false })).toBe(false);
    expect(isPartialSkillRun({ ...partial, skillActivations: [] })).toBe(false);
    expect(
      isPartialSkillRun({
        ...partial,
        partialRun: null,
        stopped: true,
      }),
    ).toBe(true);
  });

  it("never calls a whole run partial just because the answer says 'cancelled'", () => {
    // The old regex matched any answer that MENTIONED the word, so asking
    // "why was my flight cancelled?" reported the run as incomplete.
    const complete = {
      ...emptyAssistant(),
      done: true,
      skillActivations: [{ id: "youtube-distil", name: "YouTube distil" }],
      writtenNotes: [{ relPath: "Literature/One.md", kind: "literature" as const }],
      skillSteps: ["Cancelled after video 1 of 4."],
      answer: "The talk explains why the launch was cancelled.",
    };

    expect(isPartialSkillRun(complete)).toBe(false);
  });
});

/** One search, with its `retrieved` report or without it. `null` leaves the hit
 *  count undefined — the in-flight shape, which is not zero. */
const settledSearch = (query: string, hitCount: number | null): ChatEvent[] =>
  hitCount === null
    ? [{ type: "searching", query, callId: null }]
    : [{ type: "searching", query, callId: null }, { type: "retrieved", query, hitCount, callId: null }];

/** Close a run with a coverage footer that read no note — the state the empty-
 *  retrieval card is eligible in. */
const finishHavingReadNothing = (searchedTerms: string[]): ChatEvent[] => [
  { type: "coverage", searchedTerms, notesRead: [], truncated: false, skippedFiles: 0 },
  { type: "done" },
];

describe("showsNothingFoundCard", () => {
  // A genuine miss: the search surfaced nothing worth reading, so the turn read
  // no note and cited none. `notesRead` is empty — that is what makes "nothing
  // covers this" a true statement rather than a contradiction of the footer.
  const searchedCoverage = {
    searchedTerms: ["active recall"],
    notesRead: [],
    truncated: false,
    skippedFiles: 0,
  };
  const finishedMiss: AssistantMessage = {
    ...emptyAssistant(),
    coverage: searchedCoverage,
    done: true,
  };

  it("shows when a finished search read and cited nothing", () => {
    expect(showsNothingFoundCard(finishedMiss)).toBe(true);
  });

  it("stays hidden when a note was read but not cited", () => {
    // The model read a relevant note and answered in prose without an [eN]
    // marker (a hedge, or a weak model paraphrasing). Zero citations, but the
    // vault plainly *did* cover it — the footer names the note. Claiming
    // "nothing covers this" here is a false statement about the user's notes;
    // the answer and the footer carry the account instead.
    const coverage = { ...searchedCoverage, notesRead: ["Learning.md"] };
    expect(showsNothingFoundCard({ ...finishedMiss, coverage })).toBe(false);
  });

  it("stays hidden while the turn is running", () => {
    expect(showsNothingFoundCard({ ...finishedMiss, done: false })).toBe(false);
  });

  it("stays hidden when the turn failed", () => {
    expect(showsNothingFoundCard({ ...finishedMiss, error: "search failed" })).toBe(false);
  });

  it("stays hidden without coverage", () => {
    expect(showsNothingFoundCard({ ...finishedMiss, coverage: null })).toBe(false);
  });

  it("stays hidden when the turn searched no terms", () => {
    const coverage = { ...searchedCoverage, searchedTerms: [] };
    expect(showsNothingFoundCard({ ...finishedMiss, coverage })).toBe(false);
    // `CoverageView.truncated` is about SEARCH coverage and is not one of the
    // clauses here — a listing-only footer that was cut short still searched no
    // terms, so the card stays down for the same reason.
    expect(
      showsNothingFoundCard({ ...finishedMiss, coverage: { ...coverage, truncated: true } }),
    ).toBe(false);
  });

  it("stays hidden when every citation was dropped in verification", () => {
    // Zero surviving citations has two very different causes. The vault may
    // genuinely hold nothing — or it held the note and the verifier rejected
    // the quote (`a_citation_whose_note_changed_mid_answer_is_dropped`).
    // Telling the user "nothing covers this" in the second case is a false
    // statement about their own notes. The dropped rows in the activity trace
    // are the honest account; the card must stand down.
    const turn: AssistantMessage = {
      ...finishedMiss,
      activity: [{ kind: "dropped", reason: "quote not found in source" }],
    };
    expect(showsNothingFoundCard(turn)).toBe(false);
  });

  it("stays hidden when at least one citation survived", () => {
    const citation: CitationView = {
      id: "e1",
      relPath: "Learning.md",
      startLine: 3,
      endLine: 7,
      text: "Active recall improves retention.",
    };
    expect(showsNothingFoundCard({ ...finishedMiss, citations: [citation] })).toBe(false);
  });

  // ── The retrieval veto (#122) ─────────────────────────────────────────────
  // Built from events through the real reducer, because the property under test
  // is that a hit count which crossed the wire reaches this decision at all.

  it("stays hidden when the searches returned spans the model never opened", () => {
    // The reported run: no note read and no citation survived, which used to be
    // the whole test — but eleven spans came back, so the vault plainly does
    // cover this. "Nothing in your vault covers this" is then a false statement
    // about the user's own notes, and a louder one than the rail summary's.
    const turn = run([
      ...settledSearch("markdown", 6),
      ...settledSearch("spaced repetition", 5),
      ...finishHavingReadNothing(["markdown", "spaced repetition"]),
    ]);
    expect(showsNothingFoundCard(turn)).toBe(false);
  });

  it("still shows when every search reported and every one of them was empty", () => {
    // The veto must not swallow the card's real purpose: this is a genuine miss,
    // and the on-ramp is exactly what the user needs here.
    const turn = run([...settledSearch("quokka", 0), ...finishHavingReadNothing(["quokka"])]);
    expect(showsNothingFoundCard(turn)).toBe(true);
  });

  it("stays hidden when a search never reported what it found", () => {
    // The run ended with the count still undefined. Nothing established that the
    // vault is empty, so "not yet known" must not be rendered as "no".
    const turn = run([...settledSearch("focus", null), ...finishHavingReadNothing(["focus"])]);
    expect(showsNothingFoundCard(turn)).toBe(false);
  });
});

describe("reasoningSegments", () => {
  it("keeps each round's reasoning apart from the answer turn's", () => {
    // Reasoning streams on every tool-deciding round as well as on the answer
    // turn, so one turn holds several distinct trains of thought. Run together
    // they read as one blob. Both boundaries are already on the wire: the round
    // beacon opens a round, `verifying` opens the answer turn.
    const turn = run([
      { type: "planningRound", round: 1, maxRounds: 8, playlist: null },
      { type: "thinking", delta: "which notes cover this" },
      { type: "planningRound", round: 2, maxRounds: 8, playlist: null },
      { type: "thinking", delta: "the second one looked closer" },
      { type: "verifying" },
      { type: "thinking", delta: "now to answer it" },
    ]);

    expect(reasoningSegments(turn)).toEqual([
      { source: { kind: "round", round: 1 }, text: "which notes cover this" },
      { source: { kind: "round", round: 2 }, text: "the second one looked closer" },
      { source: { kind: "answer" }, text: "now to answer it" },
    ]);
    // The flat accumulation is untouched — the backstop notice reads it to tell
    // "reasoning was on and produced nothing" from "it produced something".
    expect(turn.thinking).toBe(
      "which notes cover thisthe second one looked closernow to answer it",
    );
  });

  it("leaves out a round that reasoned about nothing", () => {
    // A round with no reasoning has nothing to disclose, and an empty labelled
    // fold would be a row that opens onto nothing.
    const turn = run([
      { type: "planningRound", round: 1, maxRounds: 8, playlist: null },
      { type: "planningRound", round: 2, maxRounds: 8, playlist: null },
      { type: "thinking", delta: "one tool should do it" },
    ]);

    expect(reasoningSegments(turn)).toEqual([
      { source: { kind: "round", round: 2 }, text: "one tool should do it" },
    ]);
  });

  it("keeps reasoning no boundary claimed rather than attributing it to a guess", () => {
    // A turn whose reasoning arrived before anything named a turn for it. The
    // wire cannot produce that — the beacon precedes the first request — but a
    // turn assembled by hand can, and the reasoning must still show. It renders
    // unlabelled rather than being called the answer turn's.
    const turn = { ...emptyAssistant(), thinking: "weighing it up" };

    expect(reasoningSegments(turn)).toEqual([
      { source: { kind: "unattributed" }, text: "weighing it up" },
    ]);
  });
});

const cite = (id: string): CitationView => ({
  id,
  relPath: "a.md",
  startLine: 1,
  endLine: 1,
  text: "x",
});

describe("resolveAnswerMarkers", () => {

  it("leaves markers untouched while the turn is still streaming", () => {
    // Citations arrive after the answer streams — don't strip mid-generation.
    expect(resolveAnswerMarkers("Claim [e1]", [], false)).toBe("Claim [e1]");
  });

  it("keeps verified markers and strips dropped ones once done", () => {
    // e1 is verified; e9 was dropped by the verifier — it must not linger as a
    // live reference. The leading space goes with it (no double space).
    expect(resolveAnswerMarkers("A [e1] and B [e9].", [cite("e1")], true)).toBe(
      "A [e1] and B.",
    );
  });

  it("strips a marker with no matching citation at all", () => {
    expect(resolveAnswerMarkers("Bare claim [e3].", [], true)).toBe("Bare claim.");
  });

  it("matches an uppercase marker, mirroring the Rust extractor's case-folding", () => {
    // The verified id is lowercase e1; an uppercase [E1] must still resolve to it,
    // and an uppercase dropped [E9] must still be stripped.
    expect(resolveAnswerMarkers("A [E1] and B [E9].", [cite("e1")], true)).toBe(
      "A [E1] and B.",
    );
  });
});

describe("summarizeActivity", () => {
  it("counts searches, DISTINCT notes, drops and verification", () => {
    const steps: ActivityStep[] = [
      { kind: "search", query: "a" },
      { kind: "search", query: "b" },
      { kind: "reading", relPath: "A.md", startLine: 1, endLine: 2 },
      { kind: "reading", relPath: "A.md", startLine: 3, endLine: 4 }, // same note, read twice
      { kind: "reading", relPath: "B.md", startLine: 1, endLine: 2 },
      { kind: "verifying" },
      { kind: "dropped", reason: "x" },
    ];
    expect(summarizeActivity(steps)).toEqual({
      searches: 2,
      notesRead: 2, // A.md counted once despite two reads — provenance honesty
      dropped: 1,
      verified: true,
      totalSteps: 7,
    });
  });

  it("reports an empty trace as all-zero", () => {
    expect(summarizeActivity([])).toEqual({
      searches: 0,
      notesRead: 0,
      dropped: 0,
      verified: false,
      totalSteps: 0,
    });
  });
});

describe("searchOutcome", () => {
  // The type exists because #122 collapsed three states into two: the summary
  // asked whether anything had been READ and then reported whether anything had
  // been FOUND. Each state is pinned separately here because each one licenses a
  // different sentence in front of the user.

  it("reports no retrieval at all when no search ran", () => {
    expect(searchOutcome([])).toEqual({ kind: "none" });
    expect(searchOutcome([{ kind: "verifying" }])).toEqual({ kind: "none" });
  });

  it("totals the spans across every search that reported", () => {
    const steps: ActivityStep[] = [
      { kind: "search", query: "markdown", hitCount: 6 },
      { kind: "search", query: "spaced repetition", hitCount: 5 },
    ];
    // The total the head prints has to be the sum of what the nodes beneath it
    // print, or the summary contradicts its own children — which is the bug.
    expect(searchOutcome(steps)).toEqual({ kind: "hits", spans: 11 });
  });

  it("reports empty only when every search reported and every one was zero", () => {
    const steps: ActivityStep[] = [
      { kind: "search", query: "quokka", hitCount: 0 },
      { kind: "search", query: "wallaby", hitCount: 0 },
    ];
    expect(searchOutcome(steps)).toEqual({ kind: "empty" });
  });

  it("reports pending, never empty, while a search has yet to report", () => {
    // `hitCount` is undefined between `searching` and `retrieved`. Reading that
    // as zero is what let "nothing found" appear before the vault had answered.
    expect(searchOutcome([{ kind: "search", query: "focus" }])).toEqual({ kind: "pending" });
  });

  it("still reports pending when the searches that HAVE reported found nothing", () => {
    const steps: ActivityStep[] = [
      { kind: "search", query: "quokka", hitCount: 0 },
      { kind: "search", query: "focus" },
    ];
    expect(searchOutcome(steps)).toEqual({ kind: "pending" });
  });

  it("lets a reported hit outrank a straggler that has not answered", () => {
    // Once one search has come back with spans, retrieval demonstrably found
    // something and a later straggler cannot unsay it.
    const steps: ActivityStep[] = [
      { kind: "search", query: "markdown", hitCount: 6 },
      { kind: "search", query: "focus" },
    ];
    expect(searchOutcome(steps)).toEqual({ kind: "hits", spans: 6 });
  });
});
