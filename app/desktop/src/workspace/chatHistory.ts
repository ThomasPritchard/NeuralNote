// What a finished turn hands to the NEXT request: the prior conversation as
// plain `ChatTurn`s, plus the host-authored record of durable or incomplete run
// state that travels beside it.
//
// It lives apart from `chatMessage.ts` because it answers a different question.
// That file is about what the pane SHOWS; this one is about what the model is
// shown next, and the two have opposite instincts — the pane surfaces
// everything the run reported, while the context deliberately carries less:
// stale citation markers are stripped, provider errors are not copied in as
// instructions, reasoning never travels at all, and the window is capped.

import type { ChatTurn } from "../lib/types";
import type { AssistantMessage, ChatMessage } from "./chatMessage";

/** Strip every `[eN]` citation marker from a prior answer before it re-enters a
 *  later turn's context. Evidence ids are assigned fresh per run (the Rust registry
 *  starts empty each `run_chat`), so a marker carried forward refers to nothing in
 *  the new turn's registry — and if the model echoes it, the verifier can validate it
 *  against an *unrelated* freshly-retrieved span, surfacing as a "verified" citation
 *  whose source text doesn't match the prose claim (SUS-1 — the exact failure the moat
 *  forbids). History is plain conversational context, so the markers add nothing;
 *  dropping all of them (verified or not) closes the hole at the source. */
export function stripCitationMarkers(answer: string): string {
  return answer.replace(/ ?\[e\d+\]/gi, "");
}

/** Cap on how many prior turns are resent as context. Without it, every `chat`
 *  request carries the entire transcript, so per-turn token cost grows linearly with
 *  conversation length and a long chat eventually trips the provider's context limit
 *  (PA-003). We keep the most recent turns and drop older ones — recency is what the
 *  next answer usually needs. (The core separately caps tool-result content within a
 *  run via `max_context_chars`; this bounds the conversation history.) */
const MAX_HISTORY_TURNS = 20;
const MAX_CONTINUATION_PLAN_LABEL_CHARS = 240;

function continuationPlanLabel(label: string): string {
  const flattened = label.replace(/\s+/gu, " ").trim();
  const chars = Array.from(flattened);
  if (chars.length <= MAX_CONTINUATION_PLAN_LABEL_CHARS) return flattened;
  return `${chars.slice(0, MAX_CONTINUATION_PLAN_LABEL_CHARS).join("")}…`;
}

/** A host-authored record of durable or incomplete run state for a later turn.
 *  Provider errors are deliberately not copied into model context: the next turn
 *  needs to know what completed, not receive transport prose as an instruction. */
function continuationRecord(turn: AssistantMessage): string | null {
  if (!turn.done) return null;
  const hasRecord =
    turn.writtenNotes.length > 0 ||
    turn.existingNotes.length > 0 ||
    turn.partialRun !== null ||
    turn.stopped ||
    turn.error !== null;
  if (!hasRecord) return null;

  const lines = ["NeuralNote continuation record:"];
  if (turn.writtenNotes.length > 0) {
    lines.push(
      "Completed note writes:",
      ...turn.writtenNotes.map((note) => `- ${note.relPath} (${note.kind})`),
    );
  }
  if (turn.existingNotes.length > 0) {
    lines.push(
      "Notes already present and left unchanged:",
      ...turn.existingNotes.map((note) => `- ${note.relPath} (${note.kind})`),
    );
  }
  if (turn.planSteps.length > 0) {
    lines.push(
      "Plan state:",
      ...turn.planSteps.map(
        (step) => `- [${step.status}] ${continuationPlanLabel(step.label)}`,
      ),
    );
  }
  if (turn.partialRun !== null) {
    lines.push(`Run ended early: ${turn.partialRun}`);
  } else if (turn.stopped) {
    lines.push("The run was stopped before it completed.");
  }
  if (turn.error !== null) {
    const recordedWork =
      turn.writtenNotes.length > 0 ||
      turn.existingNotes.length > 0 ||
      turn.planSteps.length > 0;
    lines.push(
      recordedWork
        ? "The final answer failed after the recorded work."
        : "The run failed before producing a final answer.",
    );
  }
  lines.push(
    turn.writtenNotes.length > 0
      ? "Continue from this record without repeating completed note writes."
      : "Use this status when responding to the next turn.",
  );
  return lines.join("\n");
}

function assistantHistoryContent(turn: AssistantMessage): string {
  const answer = stripCitationMarkers(turn.answer);
  const record = continuationRecord(turn);
  if (answer.trim() === "") return record ?? "";
  return record === null ? answer : `${answer}\n\n${record}`;
}

/** The prior conversation as plain `ChatTurn`s, for the next `chat` request.
 *  Empty assistant turns are dropped only when they have neither an answer nor a
 *  host-authored continuation record; `[eN]` markers are stripped so stale ids
 *  can't re-enter a later run and mis-cite (see `stripCitationMarkers`); and the
 *  history is windowed to the last `MAX_HISTORY_TURNS` so per-turn cost stays
 *  bounded (see above). */
export function toHistory(messages: ChatMessage[]): ChatTurn[] {
  return messages
    .map((m): ChatTurn =>
      m.role === "user"
        ? { role: "user", content: m.content }
        : { role: "assistant", content: assistantHistoryContent(m) },
    )
    .filter((turn) => turn.content.trim() !== "")
    .slice(-MAX_HISTORY_TURNS);
}
