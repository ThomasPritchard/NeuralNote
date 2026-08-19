// The pure chat view-model fold: each ChatEvent variant lands in the right
// slot, `retrieved` merges into its `searching` row and onto the node that ran
// it, deltas accumulate, and a run ends (done clears the working state) on both
// `done` and `error`.
//
// Its siblings each cover one neighbouring file: `chatMessageApproval`,
// `chatMessagePlan`, `chatMessageToolTimeline` and `chatMessageLive` cover the
// rest of the same fold — the tool-node list is entirely the third of those;
// `chatTurnStream.test.ts` covers routing an event onto the transcript;
// `chatTurnReadouts.test.ts` covers what the UI derives from a settled turn; and
// what a turn hands to the NEXT request is `chatHistory.test.ts`.

import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../lib/types";
import { emptyAssistant, type AssistantMessage } from "./chatMessage";
import { reduceAssistant } from "./chatMessageReducer";

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

  it("starts un-truncated", () => {
    expect(emptyAssistant().truncated).toBe(false);
  });
});

describe("reduceAssistant — grounded progress", () => {
  it("moves through only phases confirmed by backend events", () => {
    let turn = emptyAssistant();

    turn = reduceAssistant(turn, { type: "processing" });
    expect(turn.phase).toBe("sending");

    turn = reduceAssistant(turn, { type: "searching", query: "active recall", callId: null });
    expect(turn.phase).toBe("searching");

    turn = reduceAssistant(turn, {
      type: "reading",
      relPath: "Learning.md",
      startLine: 3,
      endLine: 8,
      callId: null,
    });
    expect(turn.phase).toBe("reading");

    turn = reduceAssistant(turn, { type: "verifying" });
    expect(turn.phase).toBe("verifying");
  });

  it("leaves the CONTENT fold untouched for a keepalive", () => {
    // It says nothing about the conversation: a keepalive says the socket is
    // alive, which the fold has no view state for — it is dated by
    // `reduceAssistantForTurn` instead, where "alive" and "progressed" are kept
    // deliberately apart.
    const searched = run([
      { type: "searching", query: "active recall", callId: "c1" },
    ]);

    expect(reduceAssistant(searched, { type: "keepalive" })).toBe(searched);
  });

  it("renders a cue with no call behind it exactly as it always did", () => {
    // The degradation guarantee, checked rather than stated: `callId` is
    // optional because at least one retrieval path has no dispatched call to
    // name, and a cue arriving without one must leave the trace it has always
    // driven untouched.
    const uncorrelated = run([
      { type: "toolCall", id: "call-7", name: "search_notes", title: "Search notes",
        arguments: "{}", stepId: null, },
      { type: "searching", query: "spacing", callId: null },
      { type: "retrieved", query: "spacing", hitCount: 2, callId: null },
      { type: "reading", relPath: "n.md", startLine: 1, endLine: 2, callId: null },
    ]);

    expect(uncorrelated.activity).toEqual([
      { kind: "search", query: "spacing", hitCount: 2 },
      { kind: "reading", relPath: "n.md", startLine: 1, endLine: 2 },
    ]);
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

  it("keeps a collided note out of the written ledger but never loses it", () => {
    // #108: a create-only write that hit an existing note wrote nothing, so it
    // must not be reported as written — and must not vanish either.
    const turn = run([
      { type: "noteWritten", relPath: "Atomic/Idea.md", kind: "atomic" },
      { type: "noteExists", relPath: "Atomic/Idea.md", kind: "atomic" },
    ]);

    expect(turn.writtenNotes).toEqual([
      { relPath: "Atomic/Idea.md", kind: "atomic" },
    ]);
    expect(turn.existingNotes).toEqual([
      { relPath: "Atomic/Idea.md", kind: "atomic" },
    ]);
  });

  it("records an activation failure with its structured install remedy", () => {
    const turn = run([
      {
        type: "skillActivationFailed",
        id: "youtube-distil",
        name: "YouTube distil",
        message: "Skill 'youtube-distil' could not be activated: …",
        missingBinary: "yt-dlp",
      },
    ]);

    expect(turn.skillActivationFailures).toEqual([
      {
        id: "youtube-distil",
        name: "YouTube distil",
        message: "Skill 'youtube-distil' could not be activated: …",
        missingBinary: "yt-dlp",
      },
    ]);
  });

  it("keeps an absent install remedy absent rather than inventing one", () => {
    const turn = run([
      {
        type: "skillActivationFailed",
        id: "no-such-skill",
        name: "no-such-skill",
        message: "unknown skill",
        missingBinary: null,
      },
    ]);

    expect(turn.skillActivationFailures[0].missingBinary).toBeNull();
  });

  it("keeps the first partial-run reason rather than overwriting it", () => {
    const turn = run([
      { type: "partialRun", reason: "the run was stopped" },
      { type: "partialRun", reason: "and also hit a limit" },
    ]);

    expect(turn.partialRun).toBe("the run was stopped");
  });
});

/** One live-preview event. A settled preview also carries the path and kind,
 *  because those only finish arriving once the arguments have closed. */
function preview(body: string, complete = false, id = "c1"): ChatEvent {
  return {
    type: "noteEditPreview",
    id,
    relPath: complete ? "Zettelkasten/Spaced.md" : null,
    kind: complete ? "atomic" : null,
    body,
    complete,
  };
}

describe("reduceAssistant — the live note preview", () => {
  it("replaces the growing body in place rather than stacking rows", () => {
    // The backend re-sends the whole body each time, so a second preview for one
    // call is the SAME note further along — appending would render the note once
    // per fragment, hundreds of times.
    const turn = run([
      preview("# Spa"),
      preview("# Spaced rep"),
      preview("# Spaced repetition", true),
    ]);

    expect(turn.noteEdits).toHaveLength(1);
    expect(turn.noteEdits[0]).toEqual({
      id: "c1",
      relPath: "Zettelkasten/Spaced.md",
      kind: "atomic",
      body: "# Spaced repetition",
      complete: true,
      abandoned: null,
    });
  });

  it("keeps two concurrent edits apart by their call id", () => {
    const turn = run([preview("first", false, "c1"), preview("second", false, "c2")]);

    expect(turn.noteEdits.map((edit) => [edit.id, edit.body])).toEqual([
      ["c1", "first"],
      ["c2", "second"],
    ]);
  });

  it("a settled preview is not a written note", () => {
    // `complete` means the arguments parsed, not that a file exists — the tool
    // still has to be dispatched, and can still be rejected.
    const turn = run([preview("# Spaced repetition", true)]);

    expect(turn.noteEdits[0].complete).toBe(true);
    expect(turn.writtenNotes).toEqual([]);
  });

  it("marks an abandoned edit so its diff stops reading as committed", () => {
    const turn = run([
      preview("# Half a n"),
      { type: "noteEditAbandoned", id: "c1", reason: "the model stopped" },
    ]);

    expect(turn.noteEdits).toHaveLength(1);
    expect(turn.noteEdits[0].abandoned).toBe("the model stopped");
    expect(turn.noteEdits[0].body).toBe("# Half a n");
  });

  it("surfaces an abandonment whose preview never arrived rather than dropping it", () => {
    // The backend abandons only what it previewed, so an unmatched one is a
    // broken contract — and a broken contract has to be visible.
    const turn = run([{ type: "noteEditAbandoned", id: "ghost", reason: "gone" }]);

    expect(turn.noteEdits).toEqual([
      {
        id: "ghost",
        relPath: null,
        kind: null,
        body: "",
        complete: false,
        abandoned: "gone",
      },
    ]);
  });

  it("never revives an edit the backend already abandoned", () => {
    const turn = run([
      preview("# Half"),
      { type: "noteEditAbandoned", id: "c1", reason: "the model stopped" },
      preview("# Half a note more"),
    ]);

    expect(turn.noteEdits[0].abandoned).toBe("the model stopped");
  });
});

describe("reduceAssistant — activity log", () => {
  it("appends a search row, then merges the retrieved count into it", () => {
    const turn = run([
      { type: "searching", query: "active recall", callId: null },
      { type: "retrieved", query: "active recall", hitCount: 3, callId: null },
    ]);
    expect(turn.activity).toEqual([
      { kind: "search", query: "active recall", hitCount: 3 },
    ]);
  });

  it("keeps two same-query searches distinct, filling each pending count once", () => {
    const turn = run([
      { type: "searching", query: "spacing", callId: null },
      { type: "searching", query: "spacing", callId: null },
      { type: "retrieved", query: "spacing", hitCount: 2, callId: null },
    ]);
    // The most recent pending search takes the count; the first stays pending.
    expect(turn.activity).toEqual([
      { kind: "search", query: "spacing" },
      { kind: "search", query: "spacing", hitCount: 2 },
    ]);
  });

  it("keeps a retrieved count even if its search row never arrived", () => {
    const turn = run([{ type: "retrieved", query: "orphan", hitCount: 5, callId: null }]);
    expect(turn.activity).toEqual([{ kind: "search", query: "orphan", hitCount: 5 }]);
  });

  it("records reading, verifying and dropped-citation rows in order", () => {
    const turn = run([
      { type: "reading", relPath: "Spaced-Repetition.md", startLine: 12, endLine: 28, callId: null },
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

describe("reduceAssistant — answer truncation", () => {
  it("flags a truncated answer without discarding the streamed text or citations", () => {
    // `answerTruncated` lands right after the final answer delta: the partial
    // answer and any citations already collected are still valid and must
    // survive untouched — the event only marks the answer incomplete.
    const turn = run([
      { type: "answer", delta: "Spaced repetition improves recall" },
      { type: "citation", id: "e1", relPath: "A.md", startLine: 1, endLine: 2, text: "alpha" },
      { type: "answerTruncated" },
    ]);
    expect(turn.truncated).toBe(true);
    expect(turn.answer).toBe("Spaced repetition improves recall");
    expect(turn.citations.map((c) => c.id)).toEqual(["e1"]);
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

  it("retains a truncated listing-only coverage footer verbatim", () => {
    const footer = {
      searchedTerms: [],
      notesRead: [],
      truncated: true,
      skippedFiles: 0,
    };
    const turn = run([{ type: "coverage", ...footer }, { type: "done" }]);
    expect(turn.coverage).not.toBeNull();
    expect(turn.coverage).toEqual(footer);
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
