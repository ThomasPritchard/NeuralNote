// What the live head is allowed to say, and on the strength of which event.
// The rule the whole file is about: every word the head shows must be backed by
// something the backend actually sent, and must stop being shown when that
// thing stops being true.

import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../lib/types";
import {
  emptyAssistant,
  reduceAssistant,
  reduceAssistantForTurn,
  userMessage,
  type AssistantMessage,
  type ChatMessage,
} from "./chatMessage";

function run(events: ChatEvent[]): AssistantMessage {
  return events.reduce((turn, event) => reduceAssistant(turn, event), emptyAssistant());
}

const beacon = (
  round: number,
  maxRounds: number,
  playlist: { position: number; total: number } | null = null,
): ChatEvent => ({ type: "planningRound", round, maxRounds, playlist });

const preview: ChatEvent = {
  type: "videoPreview",
  videoId: "V1",
  title: "Spaced repetition, explained",
  durationSecs: 742,
  channel: "Study Lab",
  thumbnailDataUri: "data:image/jpeg;base64,AAAA",
};

describe("the phase the head names", () => {
  it("reads processing as the run being accepted, not as thinking", () => {
    // `processing` is emitted at the top of the orchestrator, before a single
    // token has been asked for. Calling that "Thinking" claimed reasoning that
    // had not started and could not be seen.
    expect(run([{ type: "processing" }]).phase).toBe("sending");
  });

  it("names planning while a tool-deciding round is in flight", () => {
    const turn = run([{ type: "processing" }, beacon(2, 12)]);

    expect(turn.phase).toBe("planning");
    expect(turn.round).toEqual({ current: 2, max: 12 });
  });

  it("takes the denominator from the latest beacon rather than remembering one", () => {
    // A skill activating mid-run raises the ceiling, so the pair is re-read
    // every round and never cached.
    expect(run([beacon(2, 8), beacon(3, 16)]).round).toEqual({ current: 3, max: 16 });
  });

  it("says thinking only while reasoning deltas are arriving", () => {
    const reasoning = run([beacon(1, 8), { type: "thinking", delta: "weighing" }]);
    expect(reasoning.reasoningStreaming).toBe(true);

    // The deltas stopped and something else happened. The word has to go with
    // them — it is a claim about right now, not a phase the run sits in.
    const moved = reduceAssistant(reasoning, {
      type: "searching",
      query: "recall",
      callId: null,
    });
    expect(moved.reasoningStreaming).toBe(false);
    expect(moved.thinking).toBe("weighing");
  });

  it("does not let an inert event unsay the reasoning that is still arriving", () => {
    const reasoning = run([{ type: "thinking", delta: "weighing" }]);

    const nudged = reduceAssistant(reasoning, {
      type: "toolProgress",
      id: "c1",
      message: "3 of 8 videos",
    });

    expect(nudged).toBe(reasoning);
  });
});

describe("playlist progress", () => {
  it("counts videos while a playlist is in flight", () => {
    const turn = run([beacon(9, 16, { position: 2, total: 3 })]);

    expect(turn.playlist).toEqual({ position: 2, total: 3 });
    // The round pair still travels: a playlist run is still spending rounds,
    // and the head decides which of the two to show.
    expect(turn.round).toEqual({ current: 9, max: 16 });
  });

  it("stops counting videos when the playlist is over", () => {
    // The last beacon of a finished playlist carries no position, and "video 3
    // of 3" left standing over the answer turn would claim work still in hand.
    const turn = run([beacon(9, 16, { position: 3, total: 3 }), beacon(10, 16)]);

    expect(turn.playlist).toBeNull();
  });

  it("drops the preview card when the beacon moves to the next video", () => {
    // The preview is emitted after the beacon that announces its item, so a
    // beacon naming a new item retires the card belonging to the old one. A
    // video whose preview never arrives then shows no card, rather than the
    // previous video's title under the new video's number.
    const turn = run([
      beacon(2, 16, { position: 1, total: 3 }),
      preview,
      beacon(9, 16, { position: 2, total: 3 }),
    ]);

    expect(turn.videoPreview).toBeNull();
  });

  it("keeps the preview card across further rounds on the same video", () => {
    const turn = run([
      beacon(2, 16, { position: 1, total: 3 }),
      preview,
      beacon(3, 16, { position: 1, total: 3 }),
    ]);

    expect(turn.videoPreview).toEqual({
      videoId: "V1",
      title: "Spaced repetition, explained",
      durationSecs: 742,
      channel: "Study Lab",
      thumbnailDataUri: "data:image/jpeg;base64,AAAA",
    });
  });

  it("carries a missing thumbnail as absent rather than as a broken image", () => {
    const turn = run([
      { ...preview, thumbnailDataUri: null, durationSecs: null, channel: null },
    ]);

    expect(turn.videoPreview).toEqual({
      videoId: "V1",
      title: "Spaced repetition, explained",
      durationSecs: null,
      channel: null,
      thumbnailDataUri: null,
    });
  });
});

const turnAfter = (next: ChatMessage[]) => next[1] as AssistantMessage;

describe("liveness stamping", () => {
  const messages: ChatMessage[] = [
    userMessage("distil this playlist"),
    emptyAssistant(false, "turn-1"),
  ];

  it("starts the clock on the first event and never restarts it", () => {
    const accepted = reduceAssistantForTurn(messages, "turn-1", { type: "processing" }, 1_000);
    const later = reduceAssistantForTurn(accepted, "turn-1", beacon(1, 8), 4_000);

    expect(turnAfter(accepted).startedAt).toBe(1_000);
    expect(turnAfter(later).startedAt).toBe(1_000);
    expect(turnAfter(later).lastEventAt).toBe(4_000);
  });

  it("refreshes liveness on a keepalive without calling it progress", () => {
    // This is the whole reason the two timestamps are separate. A keepalive
    // proves the socket is alive; it proves nothing about the work.
    const accepted = reduceAssistantForTurn(messages, "turn-1", { type: "processing" }, 1_000);

    const pinged = reduceAssistantForTurn(accepted, "turn-1", { type: "keepalive" }, 30_000);

    expect(turnAfter(pinged).lastAliveAt).toBe(30_000);
    expect(turnAfter(pinged).lastEventAt).toBe(1_000);
  });
});
