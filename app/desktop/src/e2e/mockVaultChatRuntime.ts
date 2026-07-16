// The chat / skill-run / elicitation / requirement-download runtime: a
// self-contained slice of the mock command surface with its own state (run ids,
// one parked elicitation, the undo ledger, the pending requirement download).
// Wired into the dispatch table in `mockVault.ts`.
//
// Mirrors the shell: `chat` resolves with a run id; an `elicit` frame parks the
// stream exactly as `UserPrompt::ask` parks the Rust run (the remainder plays
// only after a validated `answer_elicitation`); `undo_skill_run` reports
// per-file outcomes over what the run actually wrote.

import type { ChatEvent, PullEvent, UndoReport } from "../lib/types";
import {
  fail,
  type ChatCallRecord,
  type CreateMockVaultOptions,
} from "./mockVaultTypes";
import { channelSender } from "./mockVaultChannel";
import { DEFAULT_REQUIREMENT_DOWNLOAD_SCRIPT } from "./mockVaultDefaults";

type CommandHandler = (a: Record<string, unknown>) => unknown;

export interface ChatRuntime {
  handlers: Record<string, CommandHandler>;
  expireElicitation: () => void;
  readonly chatCalls: readonly ChatCallRecord[];
  readonly profileFolder: string | null;
}

export const createChatRuntime = (opts: CreateMockVaultOptions): ChatRuntime => {
  const chatScript = opts.chatScript ?? [];

  const chatCalls: ChatCallRecord[] = [];
  const writtenByRun = new Map<string, string[]>();
  const completedChatRuns = new Set<string>();
  let profileFolder: string | null = null;

  interface ParkedElicitation {
    id: string;
    offeredIds: ReadonlySet<string>;
    multiSelect: boolean;
    send: (message: unknown) => void;
    remainder: ChatEvent[];
    runId: string;
    /** Resolves the still-pending `chat` invoke with its run id. */
    finish: () => void;
  }
  let parkedElicitation: ParkedElicitation | null = null;
  interface PausedChat {
    send: (message: unknown) => void;
    runId: string;
    finish: () => void;
  }
  let pausedChat: PausedChat | null = null;
  let pendingRequirementDownload: {
    timer: ReturnType<typeof setTimeout>;
    send: (message: unknown) => void;
    finish: () => void;
  } | null = null;

  /** Play script events until the stream parks on an `elicit` (the elicit
   *  frame itself is emitted first) or drains, recording every `noteWritten`
   *  into the run's undo ledger. Calls `finish` only when the script drains —
   *  a parked run keeps its `chat` invoke pending, exactly like the shell. */
  const advanceChatScript = (
    send: (message: unknown) => void,
    events: ChatEvent[],
    runId: string,
    finish: () => void,
  ): void => {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      send(event);
      if (event.type === "noteWritten") {
        const written = writtenByRun.get(runId) ?? [];
        written.push(event.relPath);
        writtenByRun.set(runId, written);
      }
      if (event.type === "elicit") {
        parkedElicitation = {
          id: event.id,
          offeredIds: new Set(event.options.map((o) => o.id)),
          multiSelect: event.multiSelect,
          send,
          remainder: events.slice(i + 1),
          runId,
          finish,
        };
        return;
      }
    }
    finish();
  };

  const handlers: Record<string, CommandHandler> = {
    chat: (a) => {
      // Replay the scripted stream through the real Channel, then resolve
      // with the run id — mirroring the Rust run that emits events, ends on
      // `done`/`error`, and returns the id `undo_skill_run` takes. A script
      // holding an `elicit` parks there; `answer_elicitation` resumes it.
      const runId = a.turnId as string;
      chatCalls.push({
        prompt: a.prompt as string,
        activeSkills: [...((a.activeSkills as string[] | undefined) ?? [])],
      });
      const send = channelSender(a.onEvent);
      return new Promise<string>((resolve) => {
        const finish = () => {
          completedChatRuns.add(runId);
          resolve(runId);
        };
        const pauseAfter = opts.cancelChatAfterEvents;
        if (pauseAfter !== undefined) {
          advanceChatScript(send, chatScript.slice(0, pauseAfter), runId, () => {
            pausedChat = { send, runId, finish };
          });
        } else {
          advanceChatScript(send, [...chatScript], runId, finish);
        }
      });
    },
    cancel_chat_run: (a) => {
      const turnId = a.turnId as string;
      const paused = pausedChat;
      if (paused === null || paused.runId !== turnId) {
        return {
          turnId,
          status: completedChatRuns.has(turnId) ? "alreadyCompleted" : "notCurrent",
        };
      }
      pausedChat = null;
      // The native command returns its typed acknowledgement as soon as the
      // exact run signal wins. Provider/skill wind-down happens afterwards;
      // scheduling the tail in the next task preserves that causal order and
      // prevents a terminal tail from clearing the active turn before the UI
      // can apply the matching `cancelled` outcome.
      setTimeout(() => {
        advanceChatScript(
          paused.send,
          opts.cancelChatTail ?? [],
          paused.runId,
          paused.finish,
        );
      }, 0);
      return { turnId, status: "cancelled" };
    },
    answer_elicitation: (a) => {
      // Validation mirrors the shell (skills/elicitation.rs `answer`):
      // invalid choices reject and LEAVE the question parked for a retry;
      // only a valid answer consumes it and resumes the run.
      const id = a.id as string;
      const choices = a.choices as string[];
      const parked = parkedElicitation;
      if (parked === null || parked.id !== id) {
        return fail(
          "notFound",
          `elicitation '${id}' is not live (it may have timed out or ended)`,
        );
      }
      if (!parked.multiSelect && choices.length !== 1) {
        return fail(
          "invalidName",
          `elicitation '${id}' is single-select and requires exactly one choice`,
        );
      }
      const chosen = new Set<string>();
      for (const choice of choices) {
        if (!parked.offeredIds.has(choice)) {
          return fail(
            "invalidName",
            `choice '${choice}' was not offered by elicitation '${id}'`,
          );
        }
        if (chosen.has(choice)) {
          return fail(
            "invalidName",
            `choice '${choice}' was supplied more than once for elicitation '${id}'`,
          );
        }
        chosen.add(choice);
      }
      if (id === opts.profileFolderElicitationId) {
        profileFolder = choices[0] ?? null;
      }
      parkedElicitation = null;
      advanceChatScript(parked.send, parked.remainder, parked.runId, parked.finish);
      return undefined;
    },
    undo_skill_run: (a) => {
      const runId = a.runId as string;
      const written = writtenByRun.get(runId);
      if (!written || written.length === 0) {
        return fail("notFound", `no undoable skill run '${runId}'`);
      }
      const report: UndoReport =
        opts.undoReport ??
        ({
          files: written.map((relPath) => ({
            relPath,
            status: "deleted",
            message: null,
          })),
        } satisfies UndoReport);
      // Mirror the shell: a fully terminal report consumes the run; any
      // failed file keeps it reserved so "Retry undo" can hit it again.
      if (!report.files.some((f) => f.status === "failed")) {
        writtenByRun.delete(runId);
      }
      return report;
    },
    download_requirement: (a) => {
      const name = a.name as string;
      if (name !== "yt-dlp") {
        return fail("invalidName", `unknown requirement '${name}'`);
      }
      const script = opts.requirementDownloadScript ?? DEFAULT_REQUIREMENT_DOWNLOAD_SCRIPT;
      if (script.length === 0) return undefined;
      const send = channelSender(a.onEvent);
      if (pendingRequirementDownload !== null) {
        send({
          type: "error",
          message: "a skill requirement download is already in progress",
        } satisfies PullEvent);
        return undefined;
      }
      send(script[0]);
      if (script.length === 1) return undefined;
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          script.slice(1).forEach(send);
          pendingRequirementDownload = null;
          resolve();
        }, 50);
        pendingRequirementDownload = {
          timer,
          send,
          finish: resolve,
        };
      });
    },
    cancel_requirement_download: () => {
      const pending = pendingRequirementDownload;
      if (pending !== null) {
        clearTimeout(pending.timer);
        pending.send({
          type: "error",
          message: "Download cancelled.",
        } satisfies PullEvent);
        pendingRequirementDownload = null;
        pending.finish();
      }
      return undefined;
    },
  };

  const expireElicitation = (): void => {
    const parked = parkedElicitation;
    if (parked === null) {
      throw new Error("expireElicitation: no elicitation is parked");
    }
    // Retire the question FIRST (dead-id semantics for any late answer),
    // then let the run end: the remainder streams and `chat` resolves.
    parkedElicitation = null;
    advanceChatScript(parked.send, parked.remainder, parked.runId, parked.finish);
  };

  return {
    handlers,
    expireElicitation,
    chatCalls,
    get profileFolder() {
      return profileFolder;
    },
  };
};
