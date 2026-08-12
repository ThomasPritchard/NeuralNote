// The chat / skill-run / elicitation / requirement-download runtime: a
// self-contained slice of the mock command surface with its own state (run ids,
// one parked elicitation, the undo ledger, the pending requirement download).
// Wired into the dispatch table in `mockVault.ts`.
//
// Mirrors the shell: `chat` resolves with a run id; an `elicit` frame parks the
// stream exactly as `UserPrompt::ask` parks the Rust run (the remainder plays
// only after a validated `answer_elicitation`); `undo_skill_run` reports
// per-file outcomes over what the run actually wrote.
//
// A `toolApprovalRequested` frame parks the same way, and for the same reason:
// the gate blocks the dispatch until the user answers. The two parks are kept
// separate all the way down — separate state, separate command — because a
// webview answer meant for a model-authored question must never be able to
// satisfy a security prompt. Answering emits the settlement itself, as Rust
// does, so the sheet is cleared by the EVENT and never by the click.

import type { ChatEvent, PullEvent, UndoReport } from "../lib/types";
import {
  fail,
  type ApprovalAnswerRecord,
  type ChatCallRecord,
  type CreateMockVaultOptions,
} from "./mockVaultTypes";
import { channelSender } from "./mockVaultChannel";
import { DEFAULT_REQUIREMENT_DOWNLOAD_SCRIPT } from "./mockVaultDefaults";
import type { MockScheduledTask, MockScheduler } from "./mockScheduler";

type CommandHandler = (a: Record<string, unknown>) => unknown;

export interface ChatRuntime {
  handlers: Record<string, CommandHandler>;
  expireElicitation: () => void;
  readonly chatCalls: readonly ChatCallRecord[];
  readonly approvalAnswers: readonly ApprovalAnswerRecord[];
  readonly profileFolder: string | null;
}

export const createChatRuntime = (
  opts: CreateMockVaultOptions,
  scheduler: MockScheduler,
): ChatRuntime => {
  const chatScript = opts.chatScript ?? [];

  const chatCalls: ChatCallRecord[] = [];
  const approvalAnswers: ApprovalAnswerRecord[] = [];
  const writtenByRun = new Map<string, string[]>();
  const completedChatRuns = new Set<string>();
  let profileFolder: string | null = null;

  interface ParkedApproval {
    id: string;
    send: (message: unknown) => void;
    remainder: ChatEvent[];
    runId: string;
    finish: () => void;
  }
  let parkedApproval: ParkedApproval | null = null;

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
    tasks: MockScheduledTask[];
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
    let queuedFrame = false;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      send(event);
      queuedFrame = true;
      if (event.type === "noteWritten") {
        const written = writtenByRun.get(runId) ?? [];
        written.push(event.relPath);
        writtenByRun.set(runId, written);
      }
      if (event.type === "toolApprovalRequested") {
        // The gate blocks the dispatch here. The `chat` invoke stays pending,
        // exactly as it does for an elicitation — a run waiting on a security
        // answer has not finished.
        parkedApproval = { id: event.id, send, remainder: events.slice(i + 1), runId, finish };
        return;
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
    // The native command cannot resolve before its terminal event has crossed
    // the Channel. Queue completion after the final frame so manual journeys
    // observe the same ordering and React cannot batch the whole run away.
    if (queuedFrame) scheduler.schedule(finish);
    else finish();
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
      const send = channelSender(a.onEvent, scheduler);
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
      scheduler.scheduleManual(() => {
        advanceChatScript(
          paused.send,
          opts.cancelChatTail ?? [],
          paused.runId,
          paused.finish,
        );
      });
      return { turnId, status: "cancelled" };
    },
    answer_tool_approval: (a) => {
      // A SEPARATE command from `answer_elicitation`, mirroring the shell, so a
      // webview answer meant for a model-authored question can never satisfy a
      // security prompt.
      const id = a.id as string;
      const turnId = a.turnId as string;
      // Anything that is not an explicit `true` denies, as the shell does. The
      // fail-safe direction is the only one a coercion may go in here.
      const approved = a.approved === true;
      const parked = parkedApproval;
      // Rust is the only expiry authority, and the answer is scoped to its own
      // run: an id reused by a sibling run must never resolve this one. With
      // nothing parked, a late "yes" gets exactly what it gets from the shell
      // once the 120s expiry has fired.
      if (parked === null || parked.id !== id || parked.runId !== turnId) {
        return fail(
          "notFound",
          `approval '${id}' is not live (it may have timed out or ended)`,
        );
      }
      approvalAnswers.push({ turnId, id, approved });
      parkedApproval = null;
      const branch = opts.approvalTails;
      const tail = branch === undefined
        ? parked.remainder
        : (approved ? branch.approved : branch.denied);
      advanceChatScript(
        parked.send,
        // The settlement is the BACKEND's, exactly as in the shell: the UI's
        // sheet is cleared by this event, never by its own click.
        [
          { type: "toolApprovalResolved", id, decision: approved ? "approved" : "denied" },
          ...tail,
        ],
        parked.runId,
        parked.finish,
      );
      return undefined;
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
      if (pendingRequirementDownload !== null) {
        const send = channelSender(a.onEvent, scheduler);
        send({
          type: "error",
          message: "a skill requirement download is already in progress",
        } satisfies PullEvent);
        return undefined;
      }
      return new Promise<void>((resolve) => {
        const state: NonNullable<typeof pendingRequirementDownload> = {
          tasks: [],
          send: () => {},
          finish: resolve,
        };
        const send = channelSender(a.onEvent, scheduler, (message) => {
          const event = message as PullEvent;
          if (
            pendingRequirementDownload === state
            && (event.type === "success" || event.type === "error")
          ) {
            pendingRequirementDownload = null;
            state.finish();
          }
        });
        state.send = send;
        state.tasks.push(send(script[0]));
        if (script.length > 1) {
          state.tasks.push(
            scheduler.scheduleManual(() => {
              state.tasks.push(...script.slice(1).map(send));
            }),
          );
        }
        pendingRequirementDownload = state;
      });
    },
    cancel_requirement_download: () => {
      const pending = pendingRequirementDownload;
      if (pending !== null) {
        pending.tasks.forEach((task) => scheduler.cancel(task));
        pending.send({
          type: "error",
          message: "Download cancelled.",
        } satisfies PullEvent);
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
    approvalAnswers,
    get profileFolder() {
      return profileFolder;
    },
  };
};
