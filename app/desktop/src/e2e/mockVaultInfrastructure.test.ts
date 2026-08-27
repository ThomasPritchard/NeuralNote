import { afterEach, describe, expect, it } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";

import {
  answerElicitation,
  answerToolApproval,
  cancelChatRun,
  cancelPull,
  chat,
  createNoteFromTemplate,
  downloadRequirement,
  listLocalModels,
  listTemplates,
  pullLocalModel,
  readLinkGraph,
  readNote,
  searchVault,
} from "../lib/api";
import type { AgentActivityEnvelope, ChatEvent } from "../lib/types";
import { createMockVault, VAULT_ROOT } from "./mockVault";
import { MockScheduler } from "./mockScheduler";

afterEach(clearMocks);

describe("mockVault contract infrastructure", () => {
  it("keeps ordinary streamed work manual by default", async () => {
    const backend = createMockVault();
    const delivered: string[] = [];

    backend.scheduler.schedule(() => delivered.push("frame"));
    await Promise.resolve();

    expect(delivered).toEqual([]);
    expect(backend.scheduler.runAll()).toBe(1);
    expect(delivered).toEqual(["frame"]);
  });

  it("replays and consumes a Rust-generated command response", async () => {
    const backend = createMockVault({ mockIpcScenario: "fixture-validation" });
    backend.install();

    await expect(searchVault("neural")).resolves.toEqual({
      hits: [],
      truncated: false,
      skippedFiles: 0,
    });
    expect(backend.remainingContractExchanges()).toBe(0);
  });

  it("keeps streamed frames and cancellation tails under manual scheduler control", async () => {
    const scheduler = new MockScheduler();
    const backend = createMockVault({
      scheduler,
      chatScript: [{ type: "processing" }],
      cancelChatAfterEvents: 1,
      cancelChatTail: [
        { type: "answer", delta: "late" },
        { type: "done" },
      ],
    });
    backend.install();
    const turnId = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e31";
    const events: string[] = [];

    const run = chat(turnId, "hello", [], (event) =>
      events.push((event as unknown as ChatEvent).type),
    );
    expect(events).toEqual([]);
    scheduler.runAll();
    expect(events).toEqual(["processing"]);

    await expect(cancelChatRun(turnId)).resolves.toMatchObject({ status: "cancelled" });
    expect(events).toEqual(["processing"]);
    scheduler.runAll();

    await expect(run).resolves.toBe(turnId);
    expect(events).toEqual(["processing", "answer", "done"]);
  });

  it("resolves chat only after its final streamed frame is delivered", async () => {
    const scheduler = new MockScheduler();
    const backend = createMockVault({
      scheduler,
      chatScript: [
        { type: "answer", delta: "hello" },
        { type: "done" },
      ],
    });
    backend.install();
    const events: string[] = [];
    let settled = false;

    const run = chat("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e32", "hello", [], (event) =>
      events.push((event as unknown as ChatEvent).type),
    );
    void run.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(scheduler.runNext()).toBe(true);
    expect(events).toEqual(["answer"]);
    expect(settled).toBe(false);
    expect(scheduler.runNext()).toBe(true);
    expect(events).toEqual(["answer", "done"]);
    expect(settled).toBe(false);
    expect(scheduler.runNext()).toBe(true);
    await expect(run).resolves.toMatch(/.+/u);
    expect(settled).toBe(true);
  });

  it("streams explicit envelope-v1 fixtures through the real chat Channel", async () => {
    const scheduler = new MockScheduler();
    const turnId = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e39";
    const activityScript: AgentActivityEnvelope[] = [
      {
        schemaVersion: 1,
        turnId,
        sequence: 1,
        cycleId: null,
        activityId: null,
        payload: { type: "runStarted" },
      },
      {
        schemaVersion: 1,
        turnId,
        sequence: 2,
        cycleId: null,
        activityId: null,
        payload: { type: "runCompleted" },
      },
    ];
    const backend = createMockVault({ scheduler, activityScript });
    backend.install();
    const delivered: string[] = [];

    const run = chat(turnId, "hello", [], (event) => {
      delivered.push(event.payload.type);
    });
    scheduler.runAll();

    await expect(run).resolves.toBe(turnId);
    expect(delivered).toEqual(["runStarted", "runCompleted"]);
  });

  it("builds an envelope-v1 fixture from the chat turn id without rewriting it", async () => {
    const scheduler = new MockScheduler();
    const actualTurnId = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e40";
    const builtFor: string[] = [];
    const backend = createMockVault({
      scheduler,
      activityScriptFactory: (turnId) => {
        builtFor.push(turnId);
        return [
          {
            schemaVersion: 1,
            turnId,
            sequence: 1,
            cycleId: null,
            activityId: null,
            payload: { type: "runStarted" },
          },
          {
            schemaVersion: 1,
            turnId: "deliberately-not-the-chat-turn",
            sequence: 2,
            cycleId: null,
            activityId: null,
            payload: { type: "runCompleted" },
          },
        ];
      },
    });
    backend.install();
    const deliveredTurnIds: string[] = [];

    const run = chat(actualTurnId, "hello", [], (event) => {
      deliveredTurnIds.push(event.turnId);
    });
    scheduler.runAll();

    await expect(run).resolves.toBe(actualTurnId);
    expect(builtFor).toEqual([actualTurnId]);
    expect(deliveredTurnIds).toEqual([
      actualTurnId,
      "deliberately-not-the-chat-turn",
    ]);
  });

  it("keeps an explicit envelope fixture's wrong turn id untouched", async () => {
    const scheduler = new MockScheduler();
    const actualTurnId = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e41";
    const fixtureTurnId = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e42";
    const backend = createMockVault({
      scheduler,
      activityScript: [
        {
          schemaVersion: 1,
          turnId: fixtureTurnId,
          sequence: 1,
          cycleId: null,
          activityId: null,
          payload: { type: "runStarted" },
        },
      ],
    });
    backend.install();
    const deliveredTurnIds: string[] = [];

    const run = chat(actualTurnId, "hello", [], (event) => {
      deliveredTurnIds.push(event.turnId);
    });
    scheduler.runAll();

    await expect(run).resolves.toBe(actualTurnId);
    expect(deliveredTurnIds).toEqual([fixtureTurnId]);
  });

  it("resumes a parked v1 approval with the next envelope, never a legacy frame", async () => {
    const scheduler = new MockScheduler();
    const turnId = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e43";
    const scope = { cycleId: "cycle-a", activityId: "write-1" };
    const backend = createMockVault({
      scheduler,
      activityScriptFactory: (actualTurnId) => [
        { schemaVersion: 1, turnId: actualTurnId, sequence: 1, cycleId: null, activityId: null, payload: { type: "runStarted" } },
        { schemaVersion: 1, turnId: actualTurnId, sequence: 2, cycleId: "cycle-a", activityId: null, payload: { type: "cycleStarted", round: 1, maxRounds: 8, playlist: null } },
        { schemaVersion: 1, turnId: actualTurnId, sequence: 3, ...scope, payload: { type: "activityStarted", name: "write_note", title: "Write note", arguments: "{}", stepId: null } },
        { schemaVersion: 1, turnId: actualTurnId, sequence: 4, ...scope, payload: { type: "approvalRequested", tool: "writeNote", relPath: "Notes/Test.md", reason: "modeAlwaysAsk", expiresInSecs: 120 } },
        { schemaVersion: 1, turnId: actualTurnId, sequence: 6, ...scope, payload: { type: "activitySettled", status: "ok", summary: "Created note", detail: null, durationMs: 2 } },
        { schemaVersion: 1, turnId: actualTurnId, sequence: 7, cycleId: null, activityId: null, payload: { type: "runCompleted" } },
      ],
    });
    backend.install();
    const delivered: unknown[] = [];

    const run = chat(turnId, "write it", [], (event) => delivered.push(event));
    scheduler.runAll();
    await answerToolApproval(turnId, "write-1", true);
    scheduler.runAll();
    await expect(run).resolves.toBe(turnId);

    expect(delivered).toHaveLength(7);
    expect(delivered.every((frame) =>
      typeof frame === "object" && frame !== null && "payload" in frame,
    )).toBe(true);
    expect((delivered[4] as AgentActivityEnvelope)).toMatchObject({
      schemaVersion: 1,
      turnId,
      sequence: 5,
      cycleId: "cycle-a",
      activityId: "write-1",
      payload: { type: "approvalResolved", decision: "approved" },
    });
  });

  it("refuses an elicitation answer from a sibling turn with the same prompt id", async () => {
    const scheduler = new MockScheduler();
    const owner = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e44";
    const sibling = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e45";
    const backend = createMockVault({
      scheduler,
      chatScript: [
        {
          type: "elicit",
          id: "prompt-1",
          question: "Continue?",
          options: [{ id: "yes", label: "Yes", description: null, imageDataUri: null }],
          multiSelect: false,
        },
        { type: "done" },
      ],
    });
    backend.install();
    const run = chat(owner, "continue", [], () => undefined);
    scheduler.runAll();

    await expect(
      answerElicitation(sibling, "prompt-1", ["yes"]),
    ).rejects.toMatchObject({ kind: "notFound" });
    await answerElicitation(owner, "prompt-1", ["yes"]);
    scheduler.runAll();
    await expect(run).resolves.toBe(owner);
  });

  it("resolves a requirement download only after its terminal frame is delivered", async () => {
    const scheduler = new MockScheduler();
    const backend = createMockVault({
      scheduler,
      requirementDownloadScript: [
        {
          type: "progress",
          status: "Downloading…",
          digest: null,
          completed: 1,
          total: 2,
          percent: 50,
        },
        { type: "success" },
      ],
    });
    backend.install();
    const events: string[] = [];
    let settled = false;

    const download = downloadRequirement("yt-dlp", (event) => events.push(event.type));
    void download.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(scheduler.runNext()).toBe(true);
    expect(events).toEqual(["progress"]);
    expect(settled).toBe(false);
    expect(scheduler.runNext()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["progress"]);
    expect(settled).toBe(false);
    expect(scheduler.runNext()).toBe(true);
    await expect(download).resolves.toBeUndefined();
    expect(events).toEqual(["progress", "success"]);
    expect(settled).toBe(true);
  });

  it("cancels queued local-AI frames before they can install or report success", async () => {
    const scheduler = new MockScheduler();
    const backend = createMockVault({ scheduler });
    backend.install();
    const events: string[] = [];

    const pull = pullLocalModel("qwen2.5:7b", (event) => events.push(event.type));
    expect(events).toEqual([]);
    await cancelPull();
    await pull;
    scheduler.runAll();

    expect(events).toEqual([]);
    await expect(listLocalModels()).resolves.toEqual([]);
  });

  it("routes unexpected arguments for the next owned command through replay validation", async () => {
    const backend = createMockVault({ mockIpcScenario: "fixture-validation" });
    backend.install();

    await expect(searchVault("changed")).rejects.toThrow(/argument drift/u);
  });

  it("rejects a duplicate contract-owned command instead of falling through", async () => {
    const backend = createMockVault({ mockIpcScenario: "templates-feature" });
    backend.install();

    await expect(listTemplates()).resolves.toEqual([
      { name: "Starter", relPath: "Templates/Starter.md" },
    ]);
    await expect(listTemplates()).rejects.toThrow(
      /command drift.*create_note_from_template.*list_templates/u,
    );
  });

  it("rejects an out-of-order contract-owned command through replay", async () => {
    const backend = createMockVault({ mockIpcScenario: "templates-feature" });
    backend.install();

    await expect(
      createNoteFromTemplate(VAULT_ROOT, "Project Plan", "Templates/Starter.md"),
    ).rejects.toThrow(/command drift.*list_templates.*create_note_from_template/u);
  });

  it("allows unrelated infrastructure commands while a contract replay is active", async () => {
    const backend = createMockVault({
      mockIpcScenario: "templates-feature",
      seed: [{ kind: "file", relPath: "Bootstrap.md", content: "bootstrap" }],
    });
    backend.install();

    await expect(readNote(`${VAULT_ROOT}/Bootstrap.md`)).resolves.toMatchObject({
      raw: "bootstrap",
    });
    await expect(listTemplates()).resolves.toEqual([
      { name: "Starter", relPath: "Templates/Starter.md" },
    ]);
  });

  it("allows an explicit failure for the next owned command without consuming its replay", async () => {
    const backend = createMockVault({ mockIpcScenario: "graph-linked" });
    backend.setFailure("read_link_graph", { kind: "io", message: "graph scan failed" });
    backend.install();

    await expect(readLinkGraph()).rejects.toEqual({
      kind: "io",
      message: "graph scan failed",
    });
    expect(backend.remainingContractExchanges()).toBe(1);

    backend.clearFailure("read_link_graph");
    await expect(readLinkGraph()).resolves.toMatchObject({
      nodes: expect.any(Array),
      links: expect.any(Array),
    });
    expect(backend.remainingContractExchanges()).toBe(0);
  });

  it("fails when a selected Rust contract is left unconsumed", () => {
    const backend = createMockVault({ mockIpcScenario: "fixture-validation" });

    expect(() => backend.assertContractConsumed()).toThrow(
      /fixture-validation.*1 exchange.*search_vault/u,
    );
  });

  it("rejects a scripted failure kind not present in the Rust-generated contract", () => {
    const backend = createMockVault();

    expect(() =>
      backend.setFailure("read_note", {
        kind: "futureError",
        message: "not generated by Rust",
      } as never),
    ).toThrow(/CoreError.*futureError/u);
  });

  it("applies a generated template mutation to the in-memory filesystem", async () => {
    const backend = createMockVault({
      mockIpcScenario: "templates-feature",
      seed: [{ kind: "file", relPath: "Templates/Starter.md", content: "ignored by replay" }],
    });
    backend.install();

    await expect(listTemplates()).resolves.toEqual([
      { name: "Starter", relPath: "Templates/Starter.md" },
    ]);
    await createNoteFromTemplate(VAULT_ROOT, "Project Plan", "Templates/Starter.md");

    await expect(readNote(`${VAULT_ROOT}/Project Plan.md`)).resolves.toMatchObject({
      raw: "Template body for Project Plan.",
    });
    expect(backend.remainingContractExchanges()).toBe(0);
  });
});
