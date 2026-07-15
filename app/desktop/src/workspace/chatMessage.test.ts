// The pure chat view-model fold: each ChatEvent variant lands in the right
// slot, `retrieved` merges into its `searching` row, deltas accumulate, and a
// run ends (done clears the working state) on both `done` and `error`. History
// building drops blank turns.

import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../lib/types";
import {
  emptyAssistant,
  groupActivity,
  isPartialSkillRun,
  markAssistantStopped,
  reduceAssistant,
  reduceAssistantForTurn,
  resolveAnswerMarkers,
  showsNothingFoundCard,
  stripCitationMarkers,
  summarizeActivity,
  modelReportedProvenance,
  toHistory,
  userMessage,
  type ActivityStep,
  type AssistantMessage,
  type ChatMessage,
  type CitationView,
} from "./chatMessage";

describe("skill report context", () => {
  it("extracts distinct caption and Whisper provenance in first-seen order", () => {
    const turn = {
      ...emptyAssistant(),
      skillSteps: [
        "Video 1 of 3 landed with captions:en-auto.",
        "Video 2 of 3 landed with whisper:small.en; captions:en-auto was already used.",
      ],
      answer: "Transcript provenance: whisper:small.en",
    };

    expect(modelReportedProvenance(turn)).toEqual([
      "captions:en-auto",
      "whisper:small.en",
    ]);
  });

  it("marks a settled skill run partial only when output survived a stop", () => {
    const partial = {
      ...emptyAssistant(),
      done: true,
      skillActivations: [{ id: "youtube-distil", name: "YouTube distil" }],
      writtenNotes: [{ relPath: "Literature/One.md", kind: "literature" as const }],
      skillSteps: ["Cancelled after video 1 of 4."],
    };
    expect(isPartialSkillRun(partial)).toBe(true);
    expect(isPartialSkillRun({ ...partial, writtenNotes: [] })).toBe(false);
    expect(isPartialSkillRun({ ...partial, done: false })).toBe(false);
    expect(
      isPartialSkillRun({
        ...partial,
        stopped: true,
        skillSteps: [],
        answer: "",
      }),
    ).toBe(true);
  });
});

/** Fold a whole event script over a fresh assistant turn. */
function run(events: ChatEvent[]): AssistantMessage {
  return events.reduce(reduceAssistant, emptyAssistant());
}

describe("emptyAssistant", () => {
  it("starts in the sending phase", () => {
    expect(emptyAssistant().phase).toBe("sending");
  });

  it("defaults reasoning to not requested", () => {
    expect(emptyAssistant().reasoningRequested).toBe(false);
  });

  it("pins a requested reasoning opt-in onto the turn", () => {
    expect(emptyAssistant(true).reasoningRequested).toBe(true);
  });

  it("pins the client turn id and starts in a non-stopped state", () => {
    const turn = emptyAssistant(false, "turn-1");

    expect(turn.turnId).toBe("turn-1");
    expect(turn.stopped).toBe(false);
  });

  it("starts every skill-bank accumulator empty", () => {
    const turn = emptyAssistant();
    expect(turn.skillActivations).toEqual([]);
    expect(turn.skillSteps).toEqual([]);
    expect(turn.pendingElicitation).toBeNull();
    expect(turn.writtenNotes).toEqual([]);
  });
});

describe("turn-specific event and stop routing", () => {
  const turnOne = {
    ...emptyAssistant(false, "turn-1"),
    answer: "partial one",
    citations: [
      {
        id: "e1",
        relPath: "One.md",
        startLine: 1,
        endLine: 2,
        text: "one",
      },
    ],
  };
  const turnTwo = emptyAssistant(false, "turn-2");
  const messages: ChatMessage[] = [
    userMessage("first"),
    turnOne,
    userMessage("second"),
    turnTwo,
  ];

  it("folds a streamed event into only the matching assistant turn", () => {
    const next = reduceAssistantForTurn(messages, "turn-1", {
      type: "answer",
      delta: " continued",
    });

    expect((next[1] as AssistantMessage).answer).toBe("partial one continued");
    expect((next[3] as AssistantMessage).answer).toBe("");
  });

  it("ignores an event whose turn id is absent", () => {
    expect(
      reduceAssistantForTurn(messages, "turn-missing", {
        type: "done",
      }),
    ).toBe(messages);
  });

  it("marks only the matching active turn stopped and preserves partial evidence", () => {
    const next = markAssistantStopped(messages, "turn-1");
    const stopped = next[1] as AssistantMessage;

    expect(stopped).toMatchObject({
      turnId: "turn-1",
      answer: "partial one",
      stopped: true,
      done: true,
      error: null,
    });
    expect(stopped.citations).toEqual(turnOne.citations);
    expect(next[3]).toBe(turnTwo);
  });

  it("does not relabel an already-completed or failed turn", () => {
    const completed = { ...turnOne, done: true };
    const failed = { ...turnTwo, done: true, error: "provider failed" };
    const settled: ChatMessage[] = [completed, failed];

    expect(markAssistantStopped(settled, "turn-1")).toBe(settled);
    expect(markAssistantStopped(settled, "turn-2")).toBe(settled);
  });
});

describe("reduceAssistant — grounded progress", () => {
  it("moves through only phases confirmed by backend events", () => {
    let turn = emptyAssistant();

    turn = reduceAssistant(turn, { type: "processing" });
    expect(turn.phase).toBe("thinking");

    turn = reduceAssistant(turn, { type: "searching", query: "active recall" });
    expect(turn.phase).toBe("searching");

    turn = reduceAssistant(turn, {
      type: "reading",
      relPath: "Learning.md",
      startLine: 3,
      endLine: 8,
    });
    expect(turn.phase).toBe("reading");

    turn = reduceAssistant(turn, { type: "verifying" });
    expect(turn.phase).toBe("verifying");
  });
});

describe("reduceAssistant — skills bank", () => {
  it("accumulates skill activations and progress steps in arrival order", () => {
    const turn = run([
      { type: "skillActivated", id: "first", name: "First skill" },
      { type: "skillStep", message: "Fetching source" },
      { type: "skillActivated", id: "second", name: "Second skill" },
      { type: "skillStep", message: "Writing notes" },
    ]);

    expect(turn.skillActivations).toEqual([
      { id: "first", name: "First skill" },
      { id: "second", name: "Second skill" },
    ]);
    expect(turn.skillSteps).toEqual(["Fetching source", "Writing notes"]);
  });

  it("stores the latest elicitation as the pending prompt", () => {
    const first = {
      type: "elicit" as const,
      id: "prompt-1",
      question: "Continue?",
      options: [
        {
          id: "yes",
          label: "Yes",
          description: "Proceed",
          imageDataUri: null,
        },
      ],
      multiSelect: false,
    };
    const second = {
      type: "elicit" as const,
      id: "prompt-2",
      question: "Choose notes",
      options: [
        {
          id: "a",
          label: "Note A",
          description: null,
          imageDataUri: "data:image/png;base64,abc",
        },
      ],
      multiSelect: true,
    };

    const turn = run([first, second]);

    expect(turn.pendingElicitation).toEqual({
      id: "prompt-2",
      question: "Choose notes",
      options: second.options,
      multiSelect: true,
    });
  });

  it("accumulates written notes with their actual paths and kinds", () => {
    const turn = run([
      { type: "noteWritten", relPath: "Literature/Name.md", kind: "literature" },
      { type: "noteWritten", relPath: "Atomic/Idea.md", kind: "atomic" },
    ]);

    expect(turn.writtenNotes).toEqual([
      { relPath: "Literature/Name.md", kind: "literature" },
      { relPath: "Atomic/Idea.md", kind: "atomic" },
    ]);
  });
});

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
});

describe("reduceAssistant — activity log", () => {
  it("appends a search row, then merges the retrieved count into it", () => {
    const turn = run([
      { type: "searching", query: "active recall" },
      { type: "retrieved", query: "active recall", hitCount: 3 },
    ]);
    expect(turn.activity).toEqual([
      { kind: "search", query: "active recall", hitCount: 3 },
    ]);
  });

  it("keeps two same-query searches distinct, filling each pending count once", () => {
    const turn = run([
      { type: "searching", query: "spacing" },
      { type: "searching", query: "spacing" },
      { type: "retrieved", query: "spacing", hitCount: 2 },
    ]);
    // The most recent pending search takes the count; the first stays pending.
    expect(turn.activity).toEqual([
      { kind: "search", query: "spacing" },
      { kind: "search", query: "spacing", hitCount: 2 },
    ]);
  });

  it("keeps a retrieved count even if its search row never arrived", () => {
    const turn = run([{ type: "retrieved", query: "orphan", hitCount: 5 }]);
    expect(turn.activity).toEqual([{ kind: "search", query: "orphan", hitCount: 5 }]);
  });

  it("records reading, verifying and dropped-citation rows in order", () => {
    const turn = run([
      { type: "reading", relPath: "Spaced-Repetition.md", startLine: 12, endLine: 28 },
      { type: "verifying" },
      { type: "citationDropped", reason: "quote not found" },
    ]);
    expect(turn.activity).toEqual([
      { kind: "reading", relPath: "Spaced-Repetition.md", startLine: 12, endLine: 28 },
      { kind: "verifying" },
      { kind: "dropped", reason: "quote not found" },
    ]);
  });
});

describe("reduceAssistant — streamed text", () => {
  it("accumulates answer deltas and thinking deltas independently", () => {
    const turn = run([
      { type: "thinking", delta: "let me " },
      { type: "answer", delta: "Spaced " },
      { type: "thinking", delta: "check" },
      { type: "answer", delta: "repetition works." },
    ]);
    expect(turn.thinking).toBe("let me check");
    expect(turn.answer).toBe("Spaced repetition works.");
  });
});

describe("reduceAssistant — citations, coverage, terminal events", () => {
  it("collects citations in arrival order", () => {
    const turn = run([
      { type: "citation", id: "e1", relPath: "A.md", startLine: 1, endLine: 2, text: "alpha" },
      { type: "citation", id: "e2", relPath: "B.md", startLine: 3, endLine: 4, text: "beta" },
    ]);
    expect(turn.citations.map((c) => c.id)).toEqual(["e1", "e2"]);
    expect(turn.citations[0]).toMatchObject({ relPath: "A.md", startLine: 1, text: "alpha" });
  });

  it("stores the coverage footer verbatim", () => {
    const turn = run([
      {
        type: "coverage",
        searchedTerms: ["recall", "spacing"],
        notesRead: ["A.md", "B.md"],
        truncated: true,
        skippedFiles: 1,
      },
    ]);
    expect(turn.coverage).toEqual({
      searchedTerms: ["recall", "spacing"],
      notesRead: ["A.md", "B.md"],
      truncated: true,
      skippedFiles: 1,
    });
  });

  it("retains a truncated listing-only coverage footer without showing nothing found", () => {
    const footer = {
      searchedTerms: [],
      notesRead: [],
      truncated: true,
      skippedFiles: 0,
    };
    const turn = run([{ type: "coverage", ...footer }, { type: "done" }]);
    expect(turn.coverage).not.toBeNull();
    expect(turn.coverage).toEqual(footer);
    expect(showsNothingFoundCard(turn)).toBe(false);
  });

  it("marks the turn done on `done`", () => {
    const turn = run([{ type: "answer", delta: "hi" }, { type: "done" }]);
    expect(turn.done).toBe(true);
    expect(turn.error).toBeNull();
  });

  it("surfaces an error and ends the run (done) on `error`", () => {
    const turn = run([{ type: "error", message: "rate limited" }]);
    expect(turn.error).toBe("rate limited");
    expect(turn.done).toBe(true);
  });

  it("never mutates the input turn (immutable fold)", () => {
    const start = emptyAssistant();
    const next = reduceAssistant(start, { type: "answer", delta: "x" });
    expect(start.answer).toBe("");
    expect(next).not.toBe(start);
  });
});

describe("toHistory", () => {
  it("maps turns to ChatTurns and drops blank assistant turns", () => {
    const messages: ChatMessage[] = [
      userMessage("what is spacing?"),
      { ...emptyAssistant(), answer: "It's spacing.", done: true },
      userMessage("and recall?"),
      { ...emptyAssistant(), error: "boom", done: true }, // errored, no answer
    ];
    expect(toHistory(messages)).toEqual([
      { role: "user", content: "what is spacing?" },
      { role: "assistant", content: "It's spacing." },
      { role: "user", content: "and recall?" },
    ]);
  });

  it("windows history to the most recent turns so it can't grow unbounded (PA-003)", () => {
    // 60 non-empty turns in → only the last 20 come out, and they're the newest.
    const messages: ChatMessage[] = Array.from({ length: 30 }, (_, i) => [
      userMessage(`q${i}`),
      { ...emptyAssistant(), answer: `a${i}`, done: true } as ChatMessage,
    ]).flat();
    const history = toHistory(messages);
    expect(history).toHaveLength(20);
    // The window keeps the tail: last entry is the final assistant answer.
    expect(history.at(-1)).toEqual({ role: "assistant", content: "a29" });
    expect(history[0]).toEqual({ role: "user", content: "q20" });
  });

  it("strips [eN] markers from assistant answers so stale ids can't re-enter (SUS-1)", () => {
    // Evidence ids reset per run, so a turn-1 marker means nothing in turn 2 — and
    // could collide with an unrelated new span. History must carry the prose, not the ids.
    const messages: ChatMessage[] = [
      userMessage("q"),
      { ...emptyAssistant(), answer: "Spacing is 8px [e1] and grids use it [e2].", done: true },
    ];
    expect(toHistory(messages)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "Spacing is 8px and grids use it." },
    ]);
  });
});

describe("stripCitationMarkers", () => {
  it("removes every [eN] marker (verified or not) with its leading space", () => {
    expect(stripCitationMarkers("A [e1] and B [e9].")).toBe("A and B.");
  });

  it("matches uppercase markers, mirroring the Rust extractor's case-folding", () => {
    expect(stripCitationMarkers("A [E1] then [e2]!")).toBe("A then!");
  });

  it("leaves marker-free text untouched", () => {
    expect(stripCitationMarkers("No citations here.")).toBe("No citations here.");
  });
});

describe("resolveAnswerMarkers", () => {
  const cite = (id: string): CitationView => ({
    id,
    relPath: "a.md",
    startLine: 1,
    endLine: 1,
    text: "x",
  });

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

describe("groupActivity", () => {
  it("collapses a run of consecutive reads of one note into a counted, widened row", () => {
    const steps: ActivityStep[] = [
      { kind: "reading", relPath: "AI.md", startLine: 10, endLine: 20 },
      { kind: "reading", relPath: "AI.md", startLine: 5, endLine: 12 },
      { kind: "reading", relPath: "AI.md", startLine: 30, endLine: 40 },
    ];
    // Five-in-a-row of the same note collapse to one ×N row spanning every read.
    expect(groupActivity(steps)).toEqual([
      { kind: "reading", relPath: "AI.md", startLine: 5, endLine: 40, count: 3 },
    ]);
  });

  it("keeps non-consecutive reads of the same note separate (execution order)", () => {
    const steps: ActivityStep[] = [
      { kind: "reading", relPath: "A.md", startLine: 1, endLine: 2 },
      { kind: "search", query: "x" },
      { kind: "reading", relPath: "A.md", startLine: 3, endLine: 4 },
    ];
    const grouped = groupActivity(steps);
    expect(grouped).toHaveLength(3);
    expect(grouped.filter((s) => s.kind === "reading")).toHaveLength(2);
  });

  it("leaves searches, verifying and dropped rows untouched", () => {
    const steps: ActivityStep[] = [
      { kind: "search", query: "a", hitCount: 3 },
      { kind: "verifying" },
      { kind: "dropped", reason: "quote gone" },
    ];
    expect(groupActivity(steps)).toEqual(steps);
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
