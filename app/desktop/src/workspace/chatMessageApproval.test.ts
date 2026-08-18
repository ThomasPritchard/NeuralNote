// The approval-gate half of the chat fold: the `checking` node, the security
// prompt, the auto-approval record, the resolutions, and the degraded notice.
//
// Split from `chatMessage.test.ts` by concern rather than by line count — these
// cases all belong to one feature and are easier to find together.

import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../lib/types";
import { emptyAssistant, reduceAssistant, type AssistantMessage } from "./chatMessage";

const fold = (events: ChatEvent[], from: AssistantMessage = emptyAssistant()) =>
  events.reduce(reduceAssistant, from);

const requested: ChatEvent = {
  type: "toolApprovalRequested",
  id: "call-1",
  tool: "writeNote",
  relPath: "Notes/New.md",
  reason: "modeAlwaysAsk",
  expiresInSecs: 120,
};

describe("the approval gate's view state", () => {
  it("starts with nothing pending and nothing degraded", () => {
    const turn = emptyAssistant();
    expect(turn.toolApprovals).toEqual([]);
    expect(turn.pendingApproval).toBeNull();
    expect(turn.approvalDegraded).toBeNull();
  });

  it("opens a checking node that is not yet a question for the user", () => {
    // `checking` deliberately does not become a pending prompt: a pane that asks
    // you three times a turn for something you cannot act on trains you to
    // ignore the one prompt that matters.
    const turn = fold([{ type: "toolApprovalChecking", id: "call-1" }]);
    expect(turn.toolApprovals).toEqual([
      {
        id: "call-1",
        tool: null,
        relPath: null,
        reason: null,
        expiresInSecs: null,
        checking: true,
        resolution: null,
        autoApprovedRule: null,
      },
    ]);
    expect(turn.pendingApproval).toBeNull();
  });

  it("turns a request into the pending prompt and closes the checking state", () => {
    const turn = fold([{ type: "toolApprovalChecking", id: "call-1" }, requested]);
    expect(turn.toolApprovals).toHaveLength(1);
    expect(turn.toolApprovals[0]).toMatchObject({
      tool: "writeNote",
      relPath: "Notes/New.md",
      reason: "modeAlwaysAsk",
      expiresInSecs: 120,
      checking: false,
    });
    expect(turn.pendingApproval?.id).toBe("call-1");
  });

  it("keeps the path on the prompt — the human is the one who reads it", () => {
    const turn = fold([requested]);
    expect(turn.pendingApproval?.relPath).toBe("Notes/New.md");
  });

  it("clears the pending prompt when its own approval resolves", () => {
    const turn = fold([
      requested,
      { type: "toolApprovalResolved", id: "call-1", decision: "denied" },
    ]);
    expect(turn.pendingApproval).toBeNull();
    expect(turn.toolApprovals[0].resolution).toBe("denied");
  });

  it("leaves a different call's prompt open when one resolves", () => {
    const turn = fold([
      requested,
      { type: "toolApprovalResolved", id: "call-2", decision: "timedOut" },
    ]);
    expect(turn.pendingApproval?.id).toBe("call-1");
    expect(turn.toolApprovals).toHaveLength(2);
  });

  it("records an automatic approval as a node rather than omitting it", () => {
    // Visibility is the compensating control. Under YOLO the prompt is skipped;
    // the record is not, and this is the test that keeps that true.
    const turn = fold([
      { type: "toolAutoApproved", id: "call-1", tool: "fetchCaptions", rule: "yolo" },
    ]);
    expect(turn.toolApprovals[0]).toMatchObject({
      tool: "fetchCaptions",
      autoApprovedRule: "yolo",
      resolution: "approved",
      checking: false,
    });
    expect(turn.pendingApproval).toBeNull();
  });

  it("distinguishes a fresh judge allow from a within-run cache hit", () => {
    const turn = fold([
      { type: "toolAutoApproved", id: "call-1", tool: "writeNote", rule: "newNoteInVault" },
      { type: "toolAutoApproved", id: "call-2", tool: "writeNote", rule: "cachedAllow" },
    ]);
    expect(turn.toolApprovals.map((approval) => approval.autoApprovedRule)).toEqual([
      "newNoteInVault",
      "cachedAllow",
    ]);
  });

  it("settles on the user's answer, not on the unavailable notice that preceded it", () => {
    // The gate emits `unavailable` BEFORE falling through to the prompt, so the
    // real answer arrives second and is the one the node has to end on.
    const turn = fold([
      { type: "toolApprovalResolved", id: "call-1", decision: "unavailable" },
      { ...requested, reason: "judgeUnavailable" },
      { type: "toolApprovalResolved", id: "call-1", decision: "approved" },
    ]);
    expect(turn.toolApprovals).toHaveLength(1);
    expect(turn.toolApprovals[0].resolution).toBe("approved");
    expect(turn.toolApprovals[0].reason).toBe("judgeUnavailable");
  });

  it("keeps an unmatched resolution visible instead of swallowing it", () => {
    const turn = fold([
      { type: "toolApprovalResolved", id: "orphan", decision: "cancelled" },
    ]);
    expect(turn.toolApprovals).toEqual([
      {
        id: "orphan",
        tool: null,
        relPath: null,
        reason: null,
        expiresInSecs: null,
        checking: false,
        resolution: "cancelled",
        autoApprovedRule: null,
      },
    ]);
  });

  it("records every resolution the gate can report", () => {
    const decisions = [
      "approved",
      "denied",
      "timedOut",
      "cancelled",
      "unavailable",
    ] as const;
    for (const decision of decisions) {
      const turn = fold([
        { ...requested, id: decision },
        { type: "toolApprovalResolved", id: decision, decision },
      ]);
      expect(turn.toolApprovals[0].resolution).toBe(decision);
    }
  });

  it("keeps the first degradation reason, so the cause is not overwritten", () => {
    const turn = fold([
      { type: "toolApprovalDegraded", reason: "providerUnsupported" },
      { type: "toolApprovalDegraded", reason: "judgeUnreliable" },
    ]);
    expect(turn.approvalDegraded).toBe("providerUnsupported");
  });

  it("does not leave a security sheet on screen after a stop", async () => {
    const { markAssistantStopped } = await import("./chatMessage");
    const turn = fold([requested], emptyAssistant(false, "turn-1"));
    const [stopped] = markAssistantStopped([turn], "turn-1") as AssistantMessage[];
    expect(stopped.pendingApproval).toBeNull();
    // The record of the request survives the stop — only the live sheet goes.
    expect(stopped.toolApprovals).toHaveLength(1);
  });

  it("pairs an approval with the tool call of the same id", () => {
    const turn = fold([
      {
        type: "toolCall",
        id: "call-1",
        name: "write_note",
        title: "Write note",
        arguments: '{"rel_path":"Notes/New.md"}',
        stepId: null,
      },
      requested,
      { type: "toolApprovalResolved", id: "call-1", decision: "denied" },
      { type: "toolResult", id: "call-1", status: "denied", summary: null, detail: "Denied. Nothing was written.", durationMs: 0 },
    ]);
    expect(turn.toolCalls[0].status).toBe("denied");
    expect(turn.toolApprovals[0].resolution).toBe("denied");
    expect(turn.toolCalls[0].id).toBe(turn.toolApprovals[0].id);
  });
});
