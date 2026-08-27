import { describe, expect, it } from "vitest";
import type { AgentActivityEnvelope } from "../lib/bindings/AgentActivityEnvelope";
import {
  emptyActivityJournal,
  selectCurrentActivity,
  selectRunningSiblingCount,
} from "./activityJournal";
import { reduceActivityJournal } from "./activityJournalReducer";

function envelope(
  sequence: number,
  payload: AgentActivityEnvelope["payload"],
  scope: { cycleId?: string | null; activityId?: string | null } = {},
): AgentActivityEnvelope {
  return {
    schemaVersion: 1,
    turnId: "turn-generic",
    sequence,
    cycleId: scope.cycleId ?? null,
    activityId: scope.activityId ?? null,
    payload,
  };
}

describe("compact activity-journal reduction", () => {
  it("keeps causal cycle order while coalescing streamed thinking, progress, and previews", () => {
    const events: AgentActivityEnvelope[] = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "thinking", source: "toolTurn", delta: "Inspecting " }, { cycleId: "cycle-a" }),
      envelope(4, { type: "thinking", source: "toolTurn", delta: "the source." }, { cycleId: "cycle-a" }),
      envelope(5, { type: "cycleSummary", source: "model", message: "I found the relevant material. I’ll turn it into a note.", protocolIssues: [] }, { cycleId: "cycle-a" }),
      envelope(6, { type: "noteEditPreview", relPath: "Notes/Topic.md", kind: "atomic", body: "Draft", complete: false }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(7, { type: "activityStarted", name: "write_note", title: "Write note", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(8, { type: "activityProgress", message: "Writing the introduction" }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(9, { type: "noteEditPreview", relPath: "Notes/Topic.md", kind: "atomic", body: "Draft complete", complete: true }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(10, { type: "activityProgress", message: "Checking the finished note" }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(11, { type: "activitySettled", status: "ok", summary: "Created note", detail: null, durationMs: 18 }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(12, { type: "verifying" }),
      envelope(13, { type: "thinking", source: "finalAnswer", delta: "Checking the final account." }),
      envelope(14, { type: "runCompleted" }),
    ];

    const journal = events.reduce(reduceActivityJournal, emptyActivityJournal());

    expect(journal.cycles).toHaveLength(1);
    expect(journal.cycles[0]).toMatchObject({
      id: "cycle-a",
      firstSequence: 2,
      lastSequence: 11,
      thinking: { text: "Inspecting the source.", firstSequence: 3, lastSequence: 4 },
      summary: {
        source: "model",
        message: "I found the relevant material. I’ll turn it into a note.",
        protocolIssues: [],
        sequence: 5,
      },
      activityIds: ["write-1"],
    });
    expect(journal.activities["write-1"]).toMatchObject({
      firstSequence: 6,
      lastSequence: 11,
      title: "Write note",
      progress: "Checking the finished note",
      preview: { body: "Draft complete", complete: true },
      state: "succeeded",
    });
    expect(journal.finalThinking).toEqual({
      text: "Checking the final account.",
      firstSequence: 13,
      lastSequence: 13,
    });
    expect(journal.terminal).toEqual({ kind: "completed", message: null });
  });

  it("selects the most recently started or progressed live activity and counts active siblings", () => {
    const events: AgentActivityEnvelope[] = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "activityStarted", name: "read_note", title: "Read first note", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "read-1" }),
      envelope(4, { type: "activityStarted", name: "search_notes", title: "Search related notes", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "search-1" }),
    ];
    const afterStarts = events.reduce(reduceActivityJournal, emptyActivityJournal());

    expect(selectCurrentActivity(afterStarts)?.id).toBe("search-1");
    expect(selectRunningSiblingCount(afterStarts)).toBe(1);

    const afterProgress = reduceActivityJournal(
      afterStarts,
      envelope(5, { type: "activityProgress", message: "Reading the relevant passage" }, { cycleId: "cycle-a", activityId: "read-1" }),
    );
    expect(selectCurrentActivity(afterProgress)?.id).toBe("read-1");
    expect(selectRunningSiblingCount(afterProgress)).toBe(1);
  });

  it("parks approval and elicitation activities instead of counting them as running", () => {
    const started = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "activityStarted", name: "write_note", title: "Write note", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(4, { type: "approvalRequested", tool: "writeNote", relPath: "Notes/Topic.md", reason: "modeAlwaysAsk", expiresInSecs: 120 }, { cycleId: "cycle-a", activityId: "write-1" }),
    ].reduce(reduceActivityJournal, emptyActivityJournal());

    expect(started.activities["write-1"].state).toBe("awaitingUser");
    expect(selectCurrentActivity(started)).toBeNull();
    expect(selectRunningSiblingCount(started)).toBe(0);
  });

  it.each([
    ["denied", "denied"],
    ["timedOut", "timedOut"],
    ["cancelled", "cancelled"],
  ] as const)(
    "records an approval %s decision without pre-empting its authoritative settlement",
    (decision, status) => {
      const journal = [
        envelope(1, { type: "runStarted" }),
        envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
        envelope(3, { type: "activityStarted", name: "write_note", title: "Write note", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "write-1" }),
        envelope(4, { type: "approvalRequested", tool: "writeNote", relPath: "Notes/Topic.md", reason: "modeAlwaysAsk", expiresInSecs: 120 }, { cycleId: "cycle-a", activityId: "write-1" }),
        envelope(5, { type: "approvalResolved", decision }, { cycleId: "cycle-a", activityId: "write-1" }),
        envelope(6, { type: "activitySettled", status, summary: null, detail: "Nothing was written.", durationMs: 2 }, { cycleId: "cycle-a", activityId: "write-1" }),
      ].reduce(reduceActivityJournal, emptyActivityJournal());

      expect(journal.warning).toBeNull();
      expect(journal.activities["write-1"]).toMatchObject({
        state: status,
        approvalResolution: decision,
        settlement: { status },
      });
    },
  );

  it("keeps a failed preview account live until the matching activity settlement", () => {
    const journal = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "noteEditPreview", relPath: "Notes/Topic.md", kind: "atomic", body: "Draft", complete: true }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(4, { type: "activityStarted", name: "write_note", title: "Write note", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(5, { type: "noteEditAbandoned", reason: "The draft was not committed." }, { cycleId: "cycle-a", activityId: "write-1" }),
      envelope(6, { type: "activitySettled", status: "rejected", summary: null, detail: "Invalid arguments.", durationMs: 1 }, { cycleId: "cycle-a", activityId: "write-1" }),
    ].reduce(reduceActivityJournal, emptyActivityJournal());

    expect(journal.warning).toBeNull();
    expect(journal.activities["write-1"]).toMatchObject({
      state: "rejected",
      abandonmentReason: "The draft was not committed.",
      settlement: { status: "rejected" },
    });
  });

  it("surfaces an unknown settlement and stops live state without discarding safe history", () => {
    const safe = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "thinking", source: "toolTurn", delta: "Safe context" }, { cycleId: "cycle-a" }),
      envelope(4, { type: "activityStarted", name: "read_note", title: "Read note", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "read-1" }),
    ].reduce(reduceActivityJournal, emptyActivityJournal());

    const broken = reduceActivityJournal(
      safe,
      envelope(5, { type: "activitySettled", status: "ok", summary: "Done", detail: null, durationMs: 2 }, { cycleId: "cycle-a", activityId: "unknown" }),
    );

    expect(broken.warning).toBe("Activity history is incomplete.");
    expect(broken.terminal.kind).toBe("incomplete");
    expect(broken.cycles[0].thinking.text).toBe("Safe context");
    expect(broken.activities["read-1"].state).toBe("abandoned");
    expect(selectCurrentActivity(broken)).toBeNull();
  });

  it("rejects progress that tries to revive an already-settled activity", () => {
    const settled = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
      envelope(3, { type: "activityStarted", name: "read_note", title: "Read note", arguments: "{}", stepId: null }, { cycleId: "cycle-a", activityId: "read-1" }),
      envelope(4, { type: "activitySettled", status: "ok", summary: "Read note", detail: null, durationMs: 4 }, { cycleId: "cycle-a", activityId: "read-1" }),
    ].reduce(reduceActivityJournal, emptyActivityJournal());

    const broken = reduceActivityJournal(
      settled,
      envelope(5, { type: "activityProgress", message: "late progress" }, { cycleId: "cycle-a", activityId: "read-1" }),
    );

    expect(broken.warning).toBe("Activity history is incomplete.");
    expect(broken.activities["read-1"].state).toBe("succeeded");
    expect(broken.activities["read-1"].progress).toBeNull();
  });

  it("rejects a run-scoped payload that claims cycle ownership", () => {
    const safe = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null }, { cycleId: "cycle-a" }),
    ].reduce(reduceActivityJournal, emptyActivityJournal());

    const broken = reduceActivityJournal(
      safe,
      envelope(3, { type: "answer", delta: "mis-scoped" }, { cycleId: "cycle-a" }),
    );

    expect(broken.warning).toBe("Activity history is incomplete.");
    expect(broken.terminal.kind).toBe("incomplete");
  });

  it("accepts a run-scoped keepalive during the final-answer phase", () => {
    const journal = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "verifying" }),
      envelope(3, { type: "keepalive" }),
      envelope(4, { type: "thinking", source: "finalAnswer", delta: "Checking." }),
    ].reduce(reduceActivityJournal, emptyActivityJournal());

    expect(journal.warning).toBeNull();
    expect(journal.lastSequence).toBe(4);
    expect(journal.finalThinking?.text).toBe("Checking.");
  });

  it("keeps only the latest typed host run status for replace-in-place presentation", () => {
    const journal = [
      envelope(1, { type: "runStarted" }),
      envelope(2, { type: "hostStatus", message: "Preparing the skill" }),
      envelope(3, { type: "hostStatus", message: "Checking its requirements" }),
    ].reduce(reduceActivityJournal, emptyActivityJournal());

    expect(journal.hostStatus).toEqual({
      message: "Checking its requirements",
      sequence: 3,
    });
  });
});
