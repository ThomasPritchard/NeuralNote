// The pure chat view-model fold: each ChatEvent variant lands in the right
// slot, `retrieved` merges into its `searching` row and onto the node that ran
// it, deltas accumulate, and a run ends (done clears the working state) on both
// `done` and `error`.
//
// Its siblings each cover one neighbouring file: `chatMessageApproval`,
// `chatMessagePlan` and `chatMessageLive` cover the rest of the same fold;
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

describe("reduceAssistant — the tool timeline", () => {
  it("opens a node when a call is announced and settles it in place", () => {
    const turn = run([
      {
        type: "toolCall",
        id: "c1",
        name: "search_notes",
        title: "Search notes",
        arguments: '{"query":"spaced repetition"}',
        stepId: null,
      },
      {
        type: "toolResult",
        id: "c1",
        status: "ok",
        summary: "12 spans",
        detail: null,
        durationMs: 0,
      },
    ]);

    expect(turn.toolCalls).toEqual([
      {
        id: "c1",
        name: "search_notes",
        title: "Search notes",
        arguments: '{"query":"spaced repetition"}',
        status: "ok",
        summary: "12 spans",
        detail: null,
        stepId: null,
      },
    ]);
  });

  it("leaves an unsettled call visibly in flight rather than guessing at it", () => {
    const turn = run([
      {
        type: "toolCall",
        id: "c1",
        name: "list_notes",
        title: "List notes",
        arguments: "{}",
        stepId: null,
      },
    ]);

    expect(turn.toolCalls[0].status).toBeNull();
    expect(turn.toolCalls[0].summary).toBeNull();
  });

  it("settles each call against its own id, not the most recent one", () => {
    const turn = run([
      { type: "toolCall", id: "c1", name: "list_notes", title: "List notes", arguments: "{}",
        stepId: null, },
      { type: "toolCall", id: "c2", name: "list_folders", title: "List folders", arguments: "{}",
        stepId: null, },
      { type: "toolResult", id: "c2", status: "rejected", summary: null, detail: "nope", durationMs: 0 },
    ]);

    expect(turn.toolCalls.map((call) => call.status)).toEqual([null, "rejected"]);
    expect(turn.toolCalls[1].detail).toBe("nope");
  });

  it("keeps a settlement whose call never arrived rather than dropping it", () => {
    // Mirrors `withHitCount`: a backend that breaks its own pairing contract
    // must produce a visible anomaly, never a silently discarded event.
    const turn = run([
      { type: "toolResult", id: "ghost", status: "error", summary: null, detail: "boom", durationMs: 0 },
    ]);

    expect(turn.toolCalls).toEqual([
      {
        id: "ghost",
        name: "",
        title: "",
        arguments: "",
        status: "error",
        summary: null,
        detail: "boom",
        // No announcement means no dispatch we ever saw, so there is no step to
        // affiliate it with. Null, never a guess at whichever step is current.
        stepId: null,
      },
    ]);
  });

  it("carries the step the call was dispatched under onto the node", () => {
    const turn = run([
      {
        type: "toolCall",
        id: "c1",
        name: "search_notes",
        title: "Search notes",
        arguments: "{}",
        stepId: "s2",
      },
    ]);

    expect(turn.toolCalls[0].stepId).toBe("s2");
  });

  it("leaves a call dispatched under no plan unaffiliated, and folds it as before", () => {
    // The pre-plan case, which is the common one: no step, no grouping, and a
    // node otherwise identical to the one the reducer built before plans existed.
    const turn = run([
      {
        type: "toolCall",
        id: "c1",
        name: "search_notes",
        title: "Search notes",
        arguments: '{"query":"widgets"}',
        stepId: null,
      },
      { type: "toolResult", id: "c1", status: "ok", summary: "3 spans", detail: null, durationMs: 0 },
    ]);

    expect(turn.planSteps).toEqual([]);
    expect(turn.toolCalls).toEqual([
      {
        id: "c1",
        name: "search_notes",
        title: "Search notes",
        arguments: '{"query":"widgets"}',
        status: "ok",
        summary: "3 spans",
        detail: null,
        stepId: null,
      },
    ]);
  });

  it("settles a call on its id alone, whatever step it was affiliated with", () => {
    // `toolResult` carries no step of its own, and the affiliation must play no
    // part in the match — nor be blanked by the settlement that lands on it.
    const turn = run([
      {
        type: "toolCall",
        id: "c1",
        name: "search_notes",
        title: "Search notes",
        arguments: "{}",
        stepId: "s1",
      },
      {
        type: "toolCall",
        id: "c2",
        name: "list_notes",
        title: "List notes",
        arguments: "{}",
        stepId: null,
      },
      { type: "toolResult", id: "c2", status: "ok", summary: null, detail: null, durationMs: 0 },
      { type: "toolResult", id: "c1", status: "rejected", summary: null, detail: "nope", durationMs: 0 },
    ]);

    expect(turn.toolCalls.map((call) => [call.id, call.status, call.stepId])).toEqual([
      ["c1", "rejected", "s1"],
      ["c2", "ok", null],
    ]);
  });

  it("does not re-parent an already-dispatched node when a later step starts", () => {
    // The affiliation is stamped by the backend at dispatch. A plan arriving
    // afterwards restatuses the rail; it must never reach back into a node that
    // already went out.
    const turn = run([
      {
        type: "toolCall",
        id: "c1",
        name: "search_notes",
        title: "Search notes",
        arguments: "{}",
        stepId: null,
      },
      {
        type: "plan",
        steps: [
          { id: "s1", label: "Search the vault" },
          { id: "s2", label: "Read the best matches" },
        ],
      },
      { type: "planStepStatus", id: "s1", status: "running" },
    ]);

    expect(turn.planSteps.map((step) => step.status)).toEqual(["running", "pending"]);
    expect(turn.toolCalls[0].stepId).toBeNull();
  });

  it("never re-settles a call that already settled", () => {
    const turn = run([
      { type: "toolCall", id: "c1", name: "list_notes", title: "List notes", arguments: "{}",
        stepId: null, },
      { type: "toolResult", id: "c1", status: "ok", summary: null, detail: null, durationMs: 0 },
      { type: "toolResult", id: "c1", status: "rejected", summary: null, detail: "late", durationMs: 0 },
    ]);

    expect(turn.toolCalls).toHaveLength(2);
    expect(turn.toolCalls[0].status).toBe("ok");
  });

  it("leaves a running tool's latest progress line on the node that sent it", () => {
    // `toolProgress` is keyed to its call so it renders on that node rather than
    // on a surface of its own, and it is last-writer-wins: the line worth
    // leaving standing while the tool works is the one sent last.
    const turn = run([
      { type: "toolCall", id: "c1", name: "distil_youtube", title: "Distil a YouTube video",
        arguments: "{}", stepId: null, },
      { type: "toolCall", id: "c2", name: "search_notes", title: "Search notes", arguments: "{}",
        stepId: null, },
      { type: "toolProgress", id: "c1", message: "Fetching captions" },
      { type: "toolProgress", id: "c1", message: "Transcribing audio" },
    ]);

    expect(turn.toolCalls[0].progress).toBe("Transcribing audio");
    // Nothing narrated the second call, so it says nothing — never the first
    // call's line, which is what arrival-order correlation would have given it.
    expect(turn.toolCalls[1].progress).toBeUndefined();
  });

  it("never re-opens a settled call with a late progress line", () => {
    // The tool's channel is dropped before its settlement is emitted, so
    // progress after a result is a broken contract, and the one thing it must
    // not do is make a finished node look like it is still working.
    const turn = run([
      { type: "toolCall", id: "c1", name: "list_notes", title: "List notes", arguments: "{}",
        stepId: null, },
      { type: "toolResult", id: "c1", status: "ok", summary: null, detail: null, durationMs: 0 },
      { type: "toolProgress", id: "c1", message: "still going" },
    ]);

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].progress).toBeUndefined();
  });

  it("keeps the activity trace as the one ledger the settled summary counts", () => {
    // A retrieval cue has one destination. `summarizeActivity` and
    // `searchOutcome` read `activity`, and nothing copies the query or the count
    // onto the call's own node — two independently-maintained provenance lines
    // in one turn eventually disagree, and the node already carries both facts
    // (the query as its argument hint, the count in its settled summary).
    const turn = run([
      { type: "toolCall", id: "c1", name: "search_notes", title: "Search notes",
        arguments: "{}", stepId: null, },
      { type: "searching", query: "spacing", callId: "c1" },
      { type: "retrieved", query: "spacing", hitCount: 12, callId: "c1" },
      { type: "reading", relPath: "Spaced.md", startLine: 1, endLine: 4, callId: "c1" },
    ]);

    expect(turn.activity).toEqual([
      { kind: "search", query: "spacing", hitCount: 12 },
      { kind: "reading", relPath: "Spaced.md", startLine: 1, endLine: 4 },
    ]);
  });

  it("leaves the progress phase to the events that actually name one", () => {
    // A tool node is not a phase. Announcing a call must not overwrite the
    // phase a `searching`/`reading` event established.
    const turn = run([
      { type: "reading", relPath: "n.md", startLine: 1, endLine: 2, callId: null },
      { type: "toolCall", id: "c1", name: "list_notes", title: "List notes", arguments: "{}",
        stepId: null, },
    ]);

    expect(turn.phase).toBe("reading");
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
