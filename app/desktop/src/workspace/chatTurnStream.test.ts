// Applying the live stream to the transcript: which turn in the list an event is
// routed to, and what a user's Stop settles.
//
// The clock these functions stamp is covered by `chatMessageLive.test.ts`, which
// drives the same entry point with explicit timestamps. Split out of
// `chatMessage.test.ts` alongside the module it covers.

import { describe, expect, it } from "vitest";
import { emptyAssistant, userMessage, type AssistantMessage, type ChatMessage } from "./chatMessage";
import { reduceAssistant } from "./chatMessageReducer";
import { markAssistantStopped, reduceAssistantForTurn } from "./chatTurnStream";

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
