// Applying the live stream to the transcript: routing one transport event to the
// turn that owns it, dating that turn by the client's clock, and the terminal
// state a user's Stop imposes.
//
// It lives apart from `chatMessageReducer.ts` because it is the impure half.
// The reducer is a function of the event alone; everything that needs the world
// outside it — the wall clock, which turn in the list an event belongs to, and
// whether a stopped run may still be written to — is here. That separation is
// what lets a caller fold a fixture with `Array.reduce` and get a pure result,
// and it is why the reducer's own file can say it is clock-free and mean it.

import type { ChatEvent } from "../lib/types";
import { reduceAssistant } from "./chatMessageReducer";
import type { AssistantMessage, ChatMessage } from "./chatMessage";

/** Fold one transport event into the assistant turn that owns its caller ID. */
export function reduceAssistantForTurn(
  messages: ChatMessage[],
  turnId: string,
  event: ChatEvent,
  now: number = Date.now(),
): ChatMessage[] {
  const index = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.turnId === turnId,
  );
  if (index < 0) return messages;
  const turn = messages[index] as AssistantMessage;
  if (turn.done && (!turn.stopped || !isPostStopSettlement(event))) {
    return messages;
  }
  const reduced = foldWithLiveness(turn, event, now);
  // An event that changed nothing returns the SAME list, not a copy of it: a
  // fresh array would still commit a render, and the transcript's scroll-follow
  // re-asserts its pin on every commit. The only event that reaches here with
  // nothing to say is a `toolProgress` naming a call this turn never saw live —
  // which the wire cannot produce (see `withLiveCall`). A `keepalive` does not
  // qualify: it refreshes the liveness the head reads, which is a real change
  // to real state.
  if (reduced === turn) return messages;
  const next = messages.slice();
  next[index] = reduced;
  return next;
}

/** Fold one event in, and date the turn by it.
 *
 *  This is where a `keepalive` finally means something. It refreshes
 *  `lastAliveAt` and deliberately leaves `lastEventAt` alone, which is the whole
 *  distinction: the socket being alive is not the work progressing, so a
 *  provider emitting comment lines forever can never clear a stall notice about
 *  a run that has stopped producing anything.
 *
 *  The clock lives here rather than in the pure fold so `reduceAssistant` stays
 *  a function of the event alone — and so a caller folding a fixture with
 *  `Array.reduce` cannot accidentally pass the array index in as the time.
 *
 *  `startedAt` is set by the first event to arrive, not by the send: the
 *  backend emits `processing` at the top of the run, before any provider call,
 *  so this is within an IPC hop of the moment `usage.elapsedMs` measures from. */
function foldWithLiveness(
  turn: AssistantMessage,
  event: ChatEvent,
  now: number,
): AssistantMessage {
  if (event.type === "keepalive") return { ...turn, lastAliveAt: now };
  const folded = reduceAssistant(turn, event);
  // An event that changed nothing has nothing to date either — and dating it
  // would cost the identity check below the render it exists to prevent.
  if (folded === turn) return turn;
  return {
    ...folded,
    startedAt: turn.startedAt === 0 ? now : turn.startedAt,
    lastEventAt: now,
    lastAliveAt: now,
  };
}

/** Events that may still arrive after the user presses Stop.
 *
 *  Stop marks the turn `done` so the composer re-opens. In-flight tools,
 *  partial-run notices, and notes already committed must still land —
 *  otherwise a playlist-enumeration node spins forever. Answer, error, and
 *  Done must not: those would revive a turn the user already ended. */
function isPostStopSettlement(event: ChatEvent): boolean {
  return (
    event.type === "noteWritten" ||
    event.type === "toolResult" ||
    event.type === "partialRun" ||
    event.type === "usage" ||
    event.type === "coverage"
  );
}

/** Set the neutral stopped terminal state only on the matching active turn. */
export function markAssistantStopped(
  messages: ChatMessage[],
  turnId: string,
): ChatMessage[] {
  const index = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.turnId === turnId &&
      !message.done,
  );
  if (index < 0) return messages;
  const turn = messages[index] as AssistantMessage;
  const next = messages.slice();
  next[index] = {
    ...turn,
    pendingElicitation: null,
    // A stopped run must not leave a security sheet on screen either — it would
    // sit there looking live while Rust, the only expiry authority, has already
    // torn the approval down.
    pendingApproval: null,
    error: null,
    done: true,
    stopped: true,
  };
  return next;
}
