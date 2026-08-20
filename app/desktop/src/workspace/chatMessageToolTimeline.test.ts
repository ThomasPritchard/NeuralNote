// The tool-timeline half of the chat fold: a node opens when a call is
// announced and settles in place, `retrieved` merges into the `searching` row
// that ran it, evidence and read spans land on the node that produced them, and
// a batch of calls keeps its announced order.
//
// Split from `chatMessage.test.ts` by concern, following `chatMessageApproval`
// and `chatMessagePlan`. It was the largest single block left in that file and
// the one with the clearest edge: every case here is about the `toolCalls` list.

import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../lib/types";
import { emptyAssistant, type AssistantMessage } from "./chatMessage";
import { reduceAssistant } from "./chatMessageReducer";

/** Fold a whole event script over a fresh assistant turn. */
function run(events: ChatEvent[]): AssistantMessage {
  return events.reduce(reduceAssistant, emptyAssistant());
}

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

  it("keeps the activity trace as the one ledger the settled summary counts", () => {
    // A retrieval cue has one destination. `summarizeActivity` and
    // `searchOutcome` read `activity`, and nothing copies the query or the count
    // onto the call's own node — two independently-maintained provenance lines
    // in one turn eventually disagree, and the node already carries both facts
    // (the query as its argument hint, the count in its settled summary).
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
