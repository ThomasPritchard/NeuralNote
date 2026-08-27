// Applying the live stream to the transcript: which turn in the list an event is
// routed to, and what a user's Stop settles.
//
// The clock these functions stamp is covered by `chatMessageLive.test.ts`, which
// drives the same entry point with explicit timestamps. Split out of
// `chatMessage.test.ts` alongside the module it covers.

import { describe, expect, it } from "vitest";
import { emptyAssistant, userMessage, type AssistantMessage, type ChatMessage } from "./chatMessage";
import { reduceAssistant } from "./chatMessageReducer";
import {
  markAssistantActivityStreamClosed,
  markAssistantStopped,
  reduceAssistantForTurn,
} from "./chatTurnStream";
import type { AgentActivityEnvelope } from "../lib/bindings/AgentActivityEnvelope";

function envelope(
  sequence: number,
  payload: AgentActivityEnvelope["payload"],
  overrides: Partial<Omit<AgentActivityEnvelope, "payload" | "sequence">> = {},
): AgentActivityEnvelope {
  return {
    schemaVersion: 1,
    turnId: "turn-1",
    sequence,
    cycleId: null,
    activityId: null,
    payload,
    ...overrides,
  };
}

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

  it("locks a turn to legacy and rejects a later v1 envelope without losing its answer", () => {
    const legacy = reduceAssistantForTurn(messages, "turn-2", {
      type: "answer",
      delta: "safe legacy answer",
    });
    const mixed = reduceAssistantForTurn(
      legacy,
      "turn-2",
      envelope(1, { type: "runStarted" }, { turnId: "turn-2" }),
    );
    const turn = mixed[3] as AssistantMessage;

    expect(turn.activityProtocol).toBe("legacy");
    expect(turn.answer).toBe("safe legacy answer");
    expect(turn.activityJournal.warning).toBe("Activity history is incomplete.");
    expect(turn.error).toBe("Activity history is incomplete.");
    expect(turn.done).toBe(true);
  });

  it("locks a turn to v1 and rejects a later legacy event without losing safely folded content", () => {
    const v1 = reduceAssistantForTurn(
      messages,
      "turn-2",
      envelope(1, { type: "answer", delta: "safe v1 answer" }, { turnId: "turn-2" }),
    );
    const mixed = reduceAssistantForTurn(v1, "turn-2", {
      type: "answer",
      delta: "must not be merged",
    });
    const turn = mixed[3] as AssistantMessage;

    expect(turn.activityProtocol).toBe("v1");
    expect(turn.answer).toBe("safe v1 answer");
    expect(turn.activityJournal.warning).toBe("Activity history is incomplete.");
    expect(turn.done).toBe(true);
  });

  it("rejects a mixed-protocol event even when it arrives after the v1 terminal frame", () => {
    const completed = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "runCompleted" }),
    ].reduce(
      (current, event) => reduceAssistantForTurn(current, "turn-1", event),
      [emptyAssistant(false, "turn-1")] as ChatMessage[],
    );

    const broken = reduceAssistantForTurn(completed, "turn-1", {
      type: "answer",
      delta: "must not create a second clock",
    });
    const turn = broken[0] as AssistantMessage;

    expect(turn.activityProtocol).toBe("v1");
    expect(turn.answer).toBe("");
    expect(turn.activityJournal.warning).toBe("Activity history is incomplete.");
  });

  it("rejects an envelope after the v1 terminal frame", () => {
    const completed = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "runCompleted" }),
    ].reduce(
      (current, event) => reduceAssistantForTurn(current, "turn-1", event),
      [emptyAssistant(false, "turn-1")] as ChatMessage[],
    );

    const broken = reduceAssistantForTurn(
      completed,
      "turn-1",
      envelope(3, { type: "answer", delta: "late" }),
    );

    expect((broken[0] as AssistantMessage).activityJournal.warning).toBe(
      "Activity history is incomplete.",
    );
  });

  it.each([
    ["unsupported schema", envelope(1, { type: "runStarted" }, { schemaVersion: 2 })],
    ["wrong turn", envelope(1, { type: "runStarted" }, { turnId: "another-turn" })],
    ["first sequence not one", envelope(2, { type: "runStarted" })],
  ])("rejects a v1 first event with %s", (_label, invalid) => {
    const next = reduceAssistantForTurn([emptyAssistant(false, "turn-1")], "turn-1", invalid);
    const turn = next[0] as AssistantMessage;

    expect(turn.activityProtocol).toBe("v1");
    expect(turn.activityJournal.warning).toBe("Activity history is incomplete.");
    expect(turn.error).toBe("Activity history is incomplete.");
    expect(turn.done).toBe(true);
  });

  it.each([
    ["duplicate", [envelope(2, { type: "answer", delta: "safe" })], 2],
    ["regression", [
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "answer", delta: "safe" }),
    ], 2],
    ["gap", [envelope(2, { type: "answer", delta: "safe" })], 4],
  ])("rejects a %s sequence and preserves prior v1 content", (_label, accepted, nextSequence) => {
    const withContent = accepted.reduce(
      (current, event) => reduceAssistantForTurn(current, "turn-1", event),
      reduceAssistantForTurn(
        [emptyAssistant(false, "turn-1")],
        "turn-1",
        envelope(1, { type: "runStarted" }),
      ),
    );
    const broken = reduceAssistantForTurn(
      withContent,
      "turn-1",
      envelope(nextSequence, { type: "answer", delta: "unsafe" }),
    );
    const turn = broken[0] as AssistantMessage;

    expect(turn.answer).toBe("safe");
    expect(turn.activityJournal.warning).toBe("Activity history is incomplete.");
    expect(turn.done).toBe(true);
  });

  it("projects valid v1 envelopes into established assistant fields during migration", () => {
    const events: AgentActivityEnvelope[] = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "activityStarted", name: "write_note", title: "Write note", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(4, { type: "approvalRequested", tool: "writeNote", relPath: "Notes/Topic.md", reason: "modeAlwaysAsk", expiresInSecs: 120 }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(5, { type: "approvalResolved", decision: "approved" }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(6, { type: "noteEditPreview", relPath: "Notes/Topic.md", kind: "atomic", body: "Body", complete: true }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(7, { type: "noteWritten", relPath: "Notes/Topic.md", kind: "atomic" }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(8, { type: "activitySettled", status: "ok", summary: "Created note", detail: null, durationMs: 8 }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(9, { type: "verifying" }),
      envelope(10, { type: "thinking", source: "finalAnswer", delta: "Final check" }),
      envelope(11, { type: "answer", delta: "Finished." }),
      envelope(12, { type: "citation", id: "cite-1", relPath: "Notes/Topic.md", startLine: 1, endLine: 2, text: "Evidence" }),
      envelope(13, { type: "coverage", searchedTerms: ["topic"], notesRead: ["Notes/Topic.md"], truncated: false, skippedFiles: 0 }),
      envelope(14, { type: "plan", steps: [{ id: "step-1", label: "Write the note" }] }),
      envelope(15, { type: "planStepStatus", id: "step-1", status: "done" }),
      envelope(16, { type: "usage", elapsedMs: 800, tokensIn: 10, tokensOut: 20, model: "test-model" }),
      envelope(17, { type: "runCompleted" }),
    ];

    const projected = events.reduce(
      (current, event) => reduceAssistantForTurn(current, "turn-1", event),
      [emptyAssistant(true, "turn-1")] as ChatMessage[],
    );
    const turn = projected[0] as AssistantMessage;

    expect(turn.activityProtocol).toBe("v1");
    expect(turn.answer).toBe("Finished.");
    expect(turn.thinking).toBe("Final check");
    expect(turn.citations).toHaveLength(1);
    expect(turn.coverage?.notesRead).toEqual(["Notes/Topic.md"]);
    expect(turn.writtenNotes).toEqual([{ relPath: "Notes/Topic.md", kind: "atomic" }]);
    expect(turn.toolCalls[0]).toMatchObject({ id: "write-1", status: "ok" });
    expect(turn.toolApprovals[0]).toMatchObject({ id: "write-1", resolution: "approved" });
    expect(turn.planSteps).toEqual([{ id: "step-1", label: "Write the note", status: "done" }]);
    expect(turn.activityJournal.plan).toEqual([
      { id: "step-1", label: "Write the note", status: "done" },
    ]);
    expect(turn.usage?.model).toBe("test-model");
    expect(turn.done).toBe(true);
  });

  it("keeps authoritative v1 records in their established display fields during migration", () => {
    const events: AgentActivityEnvelope[] = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "activityStarted", name: "inspect_source", title: "Inspect source", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "inspect-1" }),
      envelope(4, { type: "videoPreview", videoId: "media-1", title: "Reference recording", durationSecs: 90, channel: "Research group", thumbnailDataUri: null }, { cycleId: "cycle-a", activityId: "inspect-1" }),
      envelope(5, { type: "searching", query: "distributed systems" }, { cycleId: "cycle-a", activityId: "inspect-1" }),
      envelope(6, { type: "retrieved", query: "distributed systems", hitCount: 2 }, { cycleId: "cycle-a", activityId: "inspect-1" }),
      envelope(7, { type: "reading", relPath: "Notes/Systems.md", startLine: 4, endLine: 12 }, { cycleId: "cycle-a", activityId: "inspect-1" }),
      envelope(8, { type: "hostStatus", message: "Preparing the local helper." }),
      envelope(9, { type: "skillActivationFailed", id: "skill-1", name: "Local helper", message: "The helper is unavailable.", missingBinary: "helper" }),
      envelope(10, { type: "approvalDegraded", reason: "judgeUnreliable" }),
      envelope(11, { type: "citationDropped", reason: "The source did not support the claim." }),
      envelope(12, { type: "activityStarted", name: "ask_user", title: "Ask a question", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "ask-1" }),
      envelope(13, { type: "elicit", id: "ask-1", question: "Which note should I use?", options: [], multiSelect: false }, { cycleId: "cycle-a", activityId: "ask-1" }),
    ];
    const projected = events.reduce(
      (current, event) => reduceAssistantForTurn(current, "turn-1", event),
      [emptyAssistant(false, "turn-1")] as ChatMessage[],
    );
    const turn = projected[0] as AssistantMessage;

    expect(turn.videoPreview?.title).toBe("Reference recording");
    expect(turn.skillSteps).toEqual(["Preparing the local helper."]);
    expect(turn.skillActivationFailures[0]).toMatchObject({
      id: "skill-1",
      missingBinary: "helper",
    });
    expect(turn.approvalDegraded).toBe("judgeUnreliable");
    expect(turn.activity).toEqual([
      { kind: "search", query: "distributed systems", hitCount: 2 },
      { kind: "reading", relPath: "Notes/Systems.md", startLine: 4, endLine: 12 },
      { kind: "dropped", reason: "The source did not support the claim." },
    ]);
    expect(turn.pendingElicitation?.id).toBe("ask-1");
    expect(turn.activityJournal.activities["ask-1"].state).toBe("awaitingUser");
  });

  it("settles a closed v1 stream as incomplete without mixing in a legacy error", () => {
    const live = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "activityStarted", name: "read_note", title: "Read note", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "read-1" }),
      envelope(4, { type: "answer", delta: "safe partial answer" }),
    ].reduce(
      (current, event) => reduceAssistantForTurn(current, "turn-1", event),
      [emptyAssistant(false, "turn-1")] as ChatMessage[],
    );

    const closed = markAssistantActivityStreamClosed(live, "turn-1", "invoke failed");
    const turn = closed[0] as AssistantMessage;

    expect(turn.activityProtocol).toBe("v1");
    expect(turn.answer).toBe("safe partial answer");
    expect(turn.activityJournal.activities["read-1"].state).toBe("abandoned");
    expect(turn.activityJournal.warning).toBe("Activity history is incomplete.");
    expect(turn.error).toBe("Activity history is incomplete.");
    expect(turn.done).toBe(true);
  });

  it("preserves the transport error before a protocol has been selected", () => {
    const closed = markAssistantActivityStreamClosed(
      [emptyAssistant(false, "turn-1")],
      "turn-1",
      "Unable to start chat",
    );
    const turn = closed[0] as AssistantMessage;

    expect(turn.activityProtocol).toBeNull();
    expect(turn.error).toBe("Unable to start chat");
    expect(turn.done).toBe(true);
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

  it("keeps every authoritative post-stop settlement that has already happened", () => {
    const live = reduceAssistant(emptyAssistant(false, "turn-1"), {
      type: "toolCall",
      id: "c1",
      name: "write_note",
      title: "Write note",
      arguments: "{}",
      stepId: null,
    });
    const stopped = markAssistantStopped([live], "turn-1");
    const settledEvents = [
      {
        type: "toolResult" as const,
        id: "c1",
        status: "ok" as const,
        summary: "Created note",
        detail: null,
        durationMs: 12,
      },
      { type: "noteWritten" as const, id: "c1", relPath: "Notes/Settled.md", kind: "atomic" as const },
      { type: "partialRun" as const, reason: "the run ended after the committed write" },
      {
        type: "usage" as const,
        elapsedMs: 1200,
        tokensIn: 10,
        tokensOut: 20,
        model: "test-model",
      },
      {
        type: "coverage" as const,
        searchedTerms: ["settled"],
        notesRead: ["Notes/Settled.md"],
        truncated: true,
        skippedFiles: 2,
      },
    ];
    const afterSettlements = settledEvents.reduce(
      (current, event) => reduceAssistantForTurn(current, "turn-1", event),
      stopped,
    );
    const afterLateError = reduceAssistantForTurn(afterSettlements, "turn-1", {
      type: "error",
      message: "late error must stay hidden",
    });
    const afterLateAnswer = reduceAssistantForTurn(afterLateError, "turn-1", {
      type: "answer",
      delta: "late answer must stay hidden",
    });
    const turn = afterLateAnswer[0] as AssistantMessage;

    expect(turn.toolCalls[0]?.status).toBe("ok");
    expect(turn.writtenNotes).toEqual([
      { relPath: "Notes/Settled.md", kind: "atomic" },
    ]);
    expect(turn.partialRun).toBe("the run ended after the committed write");
    expect(turn.usage).toEqual({
      elapsedMs: 1200,
      tokensIn: 10,
      tokensOut: 20,
      model: "test-model",
    });
    expect(turn.coverage).toEqual({
      searchedTerms: ["settled"],
      notesRead: ["Notes/Settled.md"],
      truncated: true,
      skippedFiles: 2,
    });
    expect(turn.answer).toBe("");
    expect(turn.error).toBeNull();
  });

  it("accepts a cancelled approval resolution before its post-stop activity settlement", () => {
    const live = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "activityStarted", name: "write_note", title: "Write note", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(4, { type: "approvalRequested", tool: "writeNote", relPath: "Notes/Test.md", reason: "modeAlwaysAsk", expiresInSecs: 120 }, { cycleId: "cycle-a", activityId: "write-1" }),
    ].reduce(
      (current, event) => reduceAssistantForTurn(current, "turn-1", event),
      [emptyAssistant(false, "turn-1")] as ChatMessage[],
    );
    const stopped = markAssistantStopped(live, "turn-1");
    const resolved = reduceAssistantForTurn(
      stopped,
      "turn-1",
      envelope(5, { type: "approvalResolved", decision: "cancelled" }, { cycleId: "cycle-a", activityId: "write-1" }),
    );
    const settled = reduceAssistantForTurn(
      resolved,
      "turn-1",
      envelope(6, { type: "activitySettled", status: "cancelled", summary: null, detail: "The run ended.", durationMs: 0 }, { cycleId: "cycle-a", activityId: "write-1" }),
    );
    const turn = settled[0] as AssistantMessage;

    expect(turn.stopped).toBe(true);
    expect(turn.activityJournal.warning).toBeNull();
    expect(turn.activityJournal.activities["write-1"]).toMatchObject({
      state: "cancelled",
      approvalResolution: "cancelled",
      settlement: { status: "cancelled" },
    });
  });
});
