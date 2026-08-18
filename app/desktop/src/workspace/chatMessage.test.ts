// The pure chat view-model fold: each ChatEvent variant lands in the right
// slot, `retrieved` merges into its `searching` row and onto the node that ran
// it, deltas accumulate, and a run ends (done clears the working state) on both
// `done` and `error`. What a turn hands to the NEXT request is its own file:
// `chatHistory.test.ts`.

import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../lib/types";
import {
  emptyAssistant,
  isPartialSkillRun,
  markAssistantStopped,
  reasoningSegments,
  reduceAssistant,
  reduceAssistantForTurn,
  resolveAnswerMarkers,
  searchOutcome,
  showsNothingFoundCard,
  summarizeActivity,
  modelReportedProvenance,
  userMessage,
  type ActivityStep,
  type AssistantMessage,
  type ChatMessage,
  type CitationView,
} from "./chatMessage";

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

  it("returns the same list for an event that changed nothing", () => {
    // Identity, not deep equality: a fresh array would commit a React render,
    // and the transcript's scroll-follow re-asserts its pin on every commit.
    // A progress line naming a call this turn never saw live is the only event
    // left with nothing to say — and the wire cannot produce one, because a
    // tool emits through `CallChannel` with the dispatched id. A keepalive does
    // not qualify: it refreshes the liveness the live head reads (see
    // `chatMessageLive.test.ts`), which has to commit.
    expect(
      reduceAssistantForTurn(messages, "turn-1", {
        type: "toolProgress",
        id: "never-dispatched",
        message: "3 of 8 videos",
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

  it("settles an in-flight tool after stop and still hides late answer or error", () => {
    // Stop marks the turn done so the composer re-opens. A later toolResult
    // used to be dropped, leaving the playlist-enumeration node spinning.
    const live = reduceAssistant(emptyAssistant(false, "turn-1"), {
      type: "toolCall",
      id: "c1",
      name: "select_playlist_videos",
      title: "Choose playlist videos",
      arguments: "{}",
      stepId: null,
    });
    const stopped = markAssistantStopped([live], "turn-1");
    const settled = reduceAssistantForTurn(stopped, "turn-1", {
      type: "toolResult",
      id: "c1",
      status: "cancelled",
      summary: null,
      detail: "YouTube capture was cancelled",
      durationMs: 0,
    });
    const withPartial = reduceAssistantForTurn(settled, "turn-1", {
      type: "partialRun",
      reason: "the run was stopped before it finished every item",
    });
    const afterLate = reduceAssistantForTurn(withPartial, "turn-1", {
      type: "answer",
      delta: "late answer must stay hidden",
    });
    const turn = afterLate[0] as AssistantMessage;

    expect(turn.toolCalls[0]?.status).toBe("cancelled");
    expect(turn.partialRun).toBe(
      "the run was stopped before it finished every item",
    );
    expect(turn.answer).toBe("");
    expect(turn.error).toBeNull();
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
    // name, and a cue arriving without one must attach to nothing and leave the
    // trace it has always driven untouched.
    const uncorrelated = run([
      { type: "toolCall", id: "call-7", name: "search_notes", title: "Search notes",
        arguments: "{}", stepId: null, },
      { type: "searching", query: "spacing", callId: null },
      { type: "retrieved", query: "spacing", hitCount: 2, callId: null },
      { type: "reading", relPath: "n.md", startLine: 1, endLine: 2, callId: null },
    ]);

    expect(uncorrelated.toolCalls[0].searches).toBeUndefined();
    expect(uncorrelated.toolCalls[0].reads).toBeUndefined();
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

  it("puts each query and its own hit count on the call that ran it", () => {
    // Two searches in flight at once. Correlation is on the call id the cue
    // carries, never arrival order: parallel calls are supported, so ordering
    // would put one call's query on the other call's node — a provenance lie in
    // the one surface whose whole job is provenance. The counts stay per query
    // rather than summed, because "12 spans" and "0 spans" are two facts.
    const turn = run([
      { type: "toolCall", id: "c1", name: "search_notes", title: "Search notes",
        arguments: '{"query":"spacing"}', stepId: null, },
      { type: "toolCall", id: "c2", name: "search_notes", title: "Search notes",
        arguments: '{"query":"chloroplasts"}', stepId: null, },
      { type: "searching", query: "spacing", callId: "c1" },
      { type: "searching", query: "chloroplasts", callId: "c2" },
      { type: "retrieved", query: "chloroplasts", hitCount: 0, callId: "c2" },
      { type: "retrieved", query: "spacing", hitCount: 12, callId: "c1" },
    ]);

    expect(turn.toolCalls[0].searches).toEqual([{ query: "spacing", hitCount: 12 }]);
    expect(turn.toolCalls[1].searches).toEqual([{ query: "chloroplasts", hitCount: 0 }]);
  });

  it("holds a query's count as unknown until its own retrieval reports", () => {
    // Between `searching` and `retrieved` the count has not been said yet, and
    // "hasn't said yet" must never render as zero — that is the #122 failure,
    // telling a user their vault holds nothing on a subject it covers.
    const turn = run([
      { type: "toolCall", id: "c1", name: "search_notes", title: "Search notes",
        arguments: "{}", stepId: null, },
      { type: "searching", query: "spacing", callId: "c1" },
    ]);

    expect(turn.toolCalls[0].searches).toEqual([{ query: "spacing", hitCount: null }]);
  });

  it("puts the note and the lines it opened on the call that read them", () => {
    const turn = run([
      { type: "toolCall", id: "c1", name: "read_note", title: "Read note",
        arguments: '{"rel_path":"Spaced.md"}', stepId: null, },
      { type: "reading", relPath: "Spaced.md", startLine: 12, endLine: 28, callId: "c1" },
    ]);

    expect(turn.toolCalls[0].reads).toEqual([
      { relPath: "Spaced.md", startLine: 12, endLine: 28 },
    ]);
  });

  it("keeps the activity trace as the one ledger the settled summary counts", () => {
    // The enrichment is a view onto the node, not a second ledger:
    // `summarizeActivity` and `searchOutcome` still read `activity`, and two
    // independently-computed provenance lines in one turn eventually disagree.
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
