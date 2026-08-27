// Turn-specific transport ingestion. The first event locks a turn to legacy or
// envelope v1; v1 sequence validation happens here before the pure journal fold.

import type { AgentActivityEnvelope } from "../lib/bindings/AgentActivityEnvelope";
import type { ChatEvent } from "../lib/types";
import { INCOMPLETE_ACTIVITY_HISTORY } from "./activityJournal";
import {
  markActivityJournalCancelled,
  markActivityJournalIncomplete,
  reduceActivityJournal,
} from "./activityJournalReducer";
import { reduceAssistant } from "./chatMessageReducer";
import type { AssistantMessage, ChatMessage } from "./chatMessage";

export type ChatStreamEvent = ChatEvent | AgentActivityEnvelope;

function isEnvelope(event: ChatStreamEvent): event is AgentActivityEnvelope {
  return "payload" in event;
}

/** Fold one transport event into the assistant turn that owns its caller ID. */
export function reduceAssistantForTurn(
  messages: ChatMessage[],
  turnId: string,
  event: ChatStreamEvent,
  now: number = Date.now(),
): ChatMessage[] {
  const index = messages.findIndex(
    (message) => message.role === "assistant" && message.turnId === turnId,
  );
  if (index < 0) return messages;
  const turn = messages[index] as AssistantMessage;
  if (turn.done) {
    // A normal v1 terminal envelope is the last item on its authoritative
    // clock. Anything after it means the history is broken, including a bare
    // legacy frame trying to start a second clock. A user stop is different:
    // native wind-down may still deliver the small allowlist of already-caused
    // settlements below.
    if (turn.activityProtocol === "v1" && !turn.stopped) {
      const next = messages.slice();
      next[index] = incompleteTurn(turn, now);
      return next;
    }
    if (!turn.stopped || !isPostStopSettlement(event)) return messages;
  }

  const reduced = isEnvelope(event)
    ? foldEnvelope(turn, turnId, event, now)
    : foldLegacy(turn, event, now);
  if (reduced === turn) return messages;
  const next = messages.slice();
  next[index] = reduced;
  return next;
}

function foldLegacy(
  turn: AssistantMessage,
  event: ChatEvent,
  now: number,
): AssistantMessage {
  if (turn.activityProtocol === "v1") return incompleteTurn(turn, now);
  const folded = foldLegacyWithLiveness(turn, event, now);
  if (folded === turn || turn.activityProtocol === "legacy") return folded;
  return { ...folded, activityProtocol: "legacy" };
}

function foldEnvelope(
  turn: AssistantMessage,
  turnId: string,
  envelope: AgentActivityEnvelope,
  now: number,
): AssistantMessage {
  if (turn.activityProtocol === "legacy") return incompleteTurn(turn, now);
  const locked = turn.activityProtocol === null
    ? { ...turn, activityProtocol: "v1" as const }
    : turn;
  const expected = locked.activityJournal.lastSequence + 1;
  if (
    envelope.schemaVersion !== 1 ||
    envelope.turnId !== turnId ||
    !Number.isSafeInteger(envelope.sequence) ||
    envelope.sequence !== expected
  ) return incompleteTurn(locked, now);

  const activityJournal = reduceActivityJournal(locked.activityJournal, envelope);
  if (activityJournal.warning !== null) {
    return incompleteTurn({ ...locked, activityJournal }, now);
  }

  let projected = { ...locked, activityJournal };
  for (const legacyEvent of compatibilityEvents(projected, envelope)) {
    projected = reduceAssistant(projected, legacyEvent);
  }
  return dateEnvelope(projected, turn, envelope, now);
}

function dateEnvelope(
  projected: AssistantMessage,
  previous: AssistantMessage,
  envelope: AgentActivityEnvelope,
  now: number,
): AssistantMessage {
  if (envelope.payload.type === "keepalive") {
    return { ...projected, lastAliveAt: now };
  }
  return {
    ...projected,
    startedAt: previous.startedAt === 0 ? now : previous.startedAt,
    lastEventAt: now,
    lastAliveAt: now,
  };
}

function foldLegacyWithLiveness(
  turn: AssistantMessage,
  event: ChatEvent,
  now: number,
): AssistantMessage {
  if (event.type === "keepalive") return { ...turn, lastAliveAt: now };
  const folded = reduceAssistant(turn, event);
  if (folded === turn) return turn;
  return {
    ...folded,
    startedAt: turn.startedAt === 0 ? now : turn.startedAt,
    lastEventAt: now,
    lastAliveAt: now,
  };
}

/** Compatibility-only projection for established non-journal view fields. */
function compatibilityEvents(
  turn: AssistantMessage,
  envelope: AgentActivityEnvelope,
): ChatEvent[] {
  const payload = envelope.payload;
  const id = envelope.activityId;
  switch (payload.type) {
    case "runStarted": return [{ type: "processing" }];
    case "cycleStarted": return [{ type: "planningRound", round: payload.round, maxRounds: payload.maxRounds, playlist: payload.playlist }];
    case "keepalive": return [{ type: "keepalive" }];
    case "activityProgress": return id === null ? [] : [{ type: "toolProgress", id, message: payload.message }];
    case "videoPreview": return id === null ? [] : [{ type: "videoPreview", id, videoId: payload.videoId, title: payload.title, durationSecs: payload.durationSecs, channel: payload.channel, thumbnailDataUri: payload.thumbnailDataUri }];
    case "skillActivated": return [{ type: "skillActivated", id: payload.id, name: payload.name }];
    case "hostStatus": return [{ type: "skillStep", message: payload.message }];
    case "cycleSummary": return [{ type: "skillStep", message: payload.message }];
    case "elicit": return [{ type: "elicit", id: payload.id, question: payload.question, options: payload.options, multiSelect: payload.multiSelect }];
    case "skillActivationFailed": return [{ type: "skillActivationFailed", id: payload.id, name: payload.name, message: payload.message, missingBinary: payload.missingBinary }];
    case "activityStarted": return id === null ? [] : [{ type: "toolCall", id, name: payload.name, title: payload.title, arguments: payload.arguments, stepId: payload.stepId }];
    case "activitySettled": return id === null ? [] : [{ type: "toolResult", id, status: payload.status, summary: payload.summary, detail: payload.detail, durationMs: payload.durationMs }];
    case "transcriptSource": return id === null ? [] : [{ type: "transcriptSource", id, label: payload.label, relPath: payload.relPath }];
    case "partialRun": return [{ type: "partialRun", reason: payload.reason }];
    case "noteWritten": return id === null ? [] : [{ type: "noteWritten", id, relPath: payload.relPath, kind: payload.kind }];
    case "noteExists": return id === null ? [] : [{ type: "noteExists", id, relPath: payload.relPath, kind: payload.kind }];
    case "noteEditPreview": return id === null ? [] : [{ type: "noteEditPreview", id, relPath: payload.relPath, kind: payload.kind, body: payload.body, complete: payload.complete }];
    case "noteEditAbandoned": return id === null ? [] : [{ type: "noteEditAbandoned", id, reason: payload.reason }];
    case "approvalChecking": return id === null ? [] : [{ type: "toolApprovalChecking", id }];
    case "approvalRequested": return id === null ? [] : [{ type: "toolApprovalRequested", id, tool: payload.tool, relPath: payload.relPath, reason: payload.reason, expiresInSecs: payload.expiresInSecs }];
    case "autoApproved": return id === null ? [] : [{ type: "toolAutoApproved", id, tool: payload.tool, rule: payload.rule }];
    case "approvalResolved": return id === null ? [] : [{ type: "toolApprovalResolved", id, decision: payload.decision }];
    case "approvalDegraded": return [{ type: "toolApprovalDegraded", reason: payload.reason }];
    case "searching": return [{ type: "searching", query: payload.query, callId: id }];
    case "retrieved": return [{ type: "retrieved", query: payload.query, hitCount: payload.hitCount, callId: id }];
    case "reading": return [{ type: "reading", relPath: payload.relPath, startLine: payload.startLine, endLine: payload.endLine, callId: id }];
    case "thinking": return [{ type: "thinking", delta: payload.delta }];
    case "verifying": return [{ type: "verifying" }];
    case "citationDropped": return [{ type: "citationDropped", reason: payload.reason }];
    case "answer": return [{ type: "answer", delta: payload.delta }];
    case "answerTruncated": return [{ type: "answerTruncated" }];
    case "citation": return [{ type: "citation", id: payload.id, relPath: payload.relPath, startLine: payload.startLine, endLine: payload.endLine, text: payload.text }];
    case "coverage": return [{ type: "coverage", searchedTerms: payload.searchedTerms, notesRead: payload.notesRead, truncated: payload.truncated, skippedFiles: payload.skippedFiles }];
    case "plan": return [{ type: "plan", steps: payload.steps }];
    case "planStepStatus": return [{ type: "planStepStatus", id: payload.id, status: payload.status }];
    case "usage": return [{ type: "usage", elapsedMs: payload.elapsedMs, tokensIn: payload.tokensIn, tokensOut: payload.tokensOut, model: payload.model }];
    case "activityAbandoned": return abandonedCompatibilityEvents(turn, id, payload.reason);
    case "runFailed": return [{ type: "error", message: payload.message }];
    case "runCompleted": return [{ type: "done" }];
  }
}

function abandonedCompatibilityEvents(
  turn: AssistantMessage,
  id: string | null,
  reason: "runCompleted" | "runFailed",
): ChatEvent[] {
  if (id === null) return [];
  const events: ChatEvent[] = [];
  if (turn.toolCalls.some((call) => call.id === id && call.status === null)) {
    events.push({
      type: "toolResult",
      id,
      status: reason === "runFailed" ? "error" : "cancelled",
      summary: null,
      detail: "The activity ended before it settled.",
      durationMs: 0,
    });
  }
  if (turn.noteEdits.some((edit) => edit.id === id && edit.abandoned === null)) {
    events.push({
      type: "noteEditAbandoned",
      id,
      reason: "The activity ended before the note was written.",
    });
  }
  return events;
}

function incompleteTurn(turn: AssistantMessage, now: number): AssistantMessage {
  const activityJournal = markActivityJournalIncomplete(turn.activityJournal);
  return {
    ...turn,
    activityJournal,
    pendingElicitation: null,
    pendingApproval: null,
    reasoningStreaming: false,
    error: INCOMPLETE_ACTIVITY_HISTORY,
    done: true,
    startedAt: turn.startedAt === 0 ? now : turn.startedAt,
    lastEventAt: now,
    lastAliveAt: now,
  };
}

function isPostStopSettlement(event: ChatStreamEvent): boolean {
  if (isEnvelope(event)) {
    return [
      "activitySettled",
      "activityAbandoned",
      "noteWritten",
      "noteExists",
      "noteEditAbandoned",
      "approvalResolved",
      "partialRun",
      "usage",
      "coverage",
    ].includes(event.payload.type);
  }
  return ["noteWritten", "toolResult", "partialRun", "usage", "coverage"].includes(event.type);
}

/** Settle a channel/invoke closure without injecting an event from another protocol. */
export function markAssistantActivityStreamClosed(
  messages: ChatMessage[],
  turnId: string,
  transportError: string = INCOMPLETE_ACTIVITY_HISTORY,
): ChatMessage[] {
  const index = messages.findIndex(
    (message) => message.role === "assistant" && message.turnId === turnId && !message.done,
  );
  if (index < 0) return messages;
  const turn = messages[index] as AssistantMessage;
  const settled = turn.activityProtocol === "v1"
    ? incompleteTurn(turn, Date.now())
    : settleLegacyTransportFailure(turn, transportError);
  const next = messages.slice();
  next[index] = settled;
  return next;
}

function settleLegacyTransportFailure(
  turn: AssistantMessage,
  message: string,
): AssistantMessage {
  return {
    ...turn,
    pendingElicitation: null,
    pendingApproval: null,
    reasoningStreaming: false,
    toolCalls: turn.toolCalls.map((call) => call.status === null
      ? { ...call, status: "error", detail: message }
      : call),
    noteEdits: turn.noteEdits.map((edit) => edit.abandoned === null
      ? { ...edit, abandoned: message }
      : edit),
    error: message,
    done: true,
  };
}

/** Set the neutral stopped terminal state only on the matching active turn. */
export function markAssistantStopped(
  messages: ChatMessage[],
  turnId: string,
): ChatMessage[] {
  const index = messages.findIndex(
    (message) => message.role === "assistant" && message.turnId === turnId && !message.done,
  );
  if (index < 0) return messages;
  const turn = messages[index] as AssistantMessage;
  const next = messages.slice();
  next[index] = {
    ...turn,
    activityJournal: turn.activityProtocol === "v1"
      ? markActivityJournalCancelled(turn.activityJournal)
      : turn.activityJournal,
    pendingElicitation: null,
    pendingApproval: null,
    reasoningStreaming: false,
    error: null,
    done: true,
    stopped: true,
  };
  return next;
}
