import { afterEach, describe, expect, it } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";

import {
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

    const run = chat(turnId, "hello", [], (event) => events.push(event.type));
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
      events.push(event.type),
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
