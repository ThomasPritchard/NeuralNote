// The chat pane's turn lifecycle: the transcript, the busy/stop/announce state,
// and the send / stream-fold / cancel handlers. Orchestration stays in Rust —
// this hook only drives the streamed `ChatEvent` loop via `chat` and folds it
// with `reduceAssistantForTurn`. The reasoning opt-in and the active skills are
// inputs (owned by the provider hook and the pane, respectively), pinned onto
// each turn at creation.

import { useCallback, useRef, useState, type RefObject } from "react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { ChatEvent } from "../lib/types";
import {
  emptyAssistant,
  markAssistantStopped,
  reduceAssistantForTurn,
  toHistory,
  userMessage,
  type ChatMessage,
} from "./chatMessage";
import type { SkillPickerEntry } from "./skillAutocomplete";

export interface ChatPaneChat {
  messages: ChatMessage[];
  busy: boolean;
  stoppingTurnId: string | null;
  stopError: string | null;
  liveAnnouncement: string;
  runIds: Record<number, string>;
  activeTurnIdRef: RefObject<string | null>;
  sendPrompt: (prompt: string) => void;
  cancelRun: () => Promise<void>;
}

/** Own the transcript and the send/stream/cancel loop for one chat pane. */
export function useChatPaneChat({
  effectiveReasoning,
  activeSkills,
}: {
  effectiveReasoning: boolean;
  activeSkills: SkillPickerEntry[];
}): ChatPaneChat {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [stoppingTurnId, setStoppingTurnId] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  // Run ids by assistant-message index, resolved as each run settles — the
  // report card's Undo handle. Client-side only; never part of the transcript.
  const [runIds, setRunIds] = useState<Record<number, string>>({});
  const activeTurnIdRef = useRef<string | null>(null);

  // Latest transcript, read when building the next request's history without
  // rebuilding the send callback on every streamed delta.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  /** Run one chat turn. Shared by the composer and by a dormant elicitation's
   *  late answer (which is an ordinary turn by design — spec §3.4). */
  const sendPrompt = useCallback(
    (prompt: string) => {
      if (prompt === "" || busy) return;
      const turnId = crypto.randomUUID();
      const history = toHistory(messagesRef.current);
      // Where the assistant turn is about to land — the run id resolved below
      // is keyed to it so the report card's Undo targets the right run.
      const assistantIndex = messagesRef.current.length + 1;
      activeTurnIdRef.current = turnId;
      setBusy(true);
      setStopError(null);
      setLiveAnnouncement("");
      // Pin the live reasoning opt-in onto the turn at creation: the finished
      // turn is judged (the backstop notice) against the opt-in it actually ran
      // under, not a flag the user may have flipped mid-stream.
      setMessages((prev) => [
        ...prev,
        userMessage(prompt),
        emptyAssistant(effectiveReasoning, turnId),
      ]);
      const applyTurnEvent = (event: ChatEvent) => {
        setMessages((prev) => reduceAssistantForTurn(prev, turnId, event));
      };
      // A transport-level rejection is surfaced as an inline error event, so a
      // failed run is never silent and the composer always re-enables.
      void api
        .chat(turnId, prompt, history, applyTurnEvent, activeSkills.map((s) => s.id))
        .then((runId) => {
          // The caller UUID is the sole run identity. A mismatched native echo
          // never receives an Undo handle.
          if (runId === turnId) {
            setRunIds((prev) => ({ ...prev, [assistantIndex]: runId }));
          }
        })
        .catch((e) => applyTurnEvent({ type: "error", message: errorMessage(e) }))
        .finally(() => {
          if (activeTurnIdRef.current === turnId) {
            activeTurnIdRef.current = null;
            setBusy(false);
          }
          setStoppingTurnId((current) => (current === turnId ? null : current));
        });
    },
    [busy, effectiveReasoning, activeSkills],
  );

  const cancelRun = useCallback(async () => {
    const turnId = activeTurnIdRef.current;
    if (!busy || turnId === null || stoppingTurnId === turnId) return;
    setStoppingTurnId(turnId);
    setStopError(null);
    try {
      const outcome = await api.cancelChatRun(turnId);
      if (activeTurnIdRef.current !== turnId) return;
      if (outcome.turnId !== turnId) {
        setStopError("Couldn't stop the response");
        setStoppingTurnId(null);
        return;
      }
      if (outcome.status === "cancelled") {
        // TODO(done-cancel-announcement): announce stopped only when
        // markAssistantStopped actually transitions this turn; Done must keep
        // its completed announcement if native guard cleanup is still pending.
        setMessages((prev) => markAssistantStopped(prev, turnId));
        setLiveAnnouncement("Response stopped.");
      } else {
        setStoppingTurnId(null);
      }
    } catch {
      if (activeTurnIdRef.current === turnId) {
        setStopError("Couldn't stop the response");
        setStoppingTurnId(null);
      }
    }
  }, [busy, stoppingTurnId]);

  return {
    messages,
    busy,
    stoppingTurnId,
    stopError,
    liveAnnouncement,
    runIds,
    activeTurnIdRef,
    sendPrompt,
    cancelRun,
  };
}
