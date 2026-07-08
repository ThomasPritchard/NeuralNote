// The pure chat view-model fold: each ChatEvent variant lands in the right
// slot, `retrieved` merges into its `searching` row, deltas accumulate, and a
// run ends (done clears the working state) on both `done` and `error`. History
// building drops blank turns.

import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../lib/types";
import {
  emptyAssistant,
  groupActivity,
  reduceAssistant,
  resolveAnswerMarkers,
  summarizeActivity,
  toHistory,
  userMessage,
  type ActivityStep,
  type AssistantMessage,
  type ChatMessage,
  type CitationView,
} from "./chatMessage";

/** Fold a whole event script over a fresh assistant turn. */
function run(events: ChatEvent[]): AssistantMessage {
  return events.reduce(reduceAssistant, emptyAssistant());
}

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
