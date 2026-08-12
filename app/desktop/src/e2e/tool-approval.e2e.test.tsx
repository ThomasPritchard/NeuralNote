// The tool-approval commands, driven through the real IPC boundary.
//
// **Why this file has to exist.** Component tests `vi.mock` the whole api module,
// so a wrong Tauri command name, a renamed argument, or a payload shape Rust
// never sends all pass them. Only the mockVault seam drives `api.ts` through the
// same `invoke` path the app uses, so this is the only place the three new
// commands' names and arguments are actually checked.
//
// The security *sheet* is presentational and belongs to the UI lane, so there is
// no click-through journey here yet. What is checked is the contract underneath
// one: the command names, the argument keys, the clamp surviving the round trip,
// and a late answer being refused rather than approving after the fact.

import { describe, expect, it } from "vitest";
import {
  aiStatus,
  answerToolApproval,
  setApprovalMode,
  setToolApprovalOverride,
} from "../lib/api";
import { createMockVault } from "./mockVault";

describe("the tool-approval command surface", () => {
  it("reports every gated tool as always-ask on a fresh install", async () => {
    const backend = createMockVault();
    backend.install();
    const status = await aiStatus();

    expect(status.approval.mode).toBe("alwaysAsk");
    expect(status.approval.toolOverrides).toEqual({});
    // The migration property, from the UI's side: nothing is opted into
    // automation by an upgrade, and that has to be true per TOOL, not just for
    // the stored global.
    expect(Object.values(status.approval.effectiveModes)).toEqual(
      Object.values(status.approval.effectiveModes).map(() => "alwaysAsk"),
    );
    expect(backend.calls).toContain("ai_status");
  });

  it("names the irreversible consequences in plain language, not tool identifiers", async () => {
    createMockVault().install();
    const { approval } = await aiStatus();

    expect(approval.irreversibleActions.length).toBeGreaterThan(0);
    for (const action of approval.irreversibleActions) {
      expect(action).not.toMatch(/_/);
    }
  });

  it("persists the global mode and returns the fresh status rather than needing a re-read", async () => {
    const backend = createMockVault();
    backend.install();
    const status = await setApprovalMode("yolo");

    expect(backend.calls).toContain("set_approval_mode");
    expect(status.approval.mode).toBe("yolo");
    expect(await aiStatus().then((s) => s.approval.mode)).toBe("yolo");
  });

  it("keeps the process-spawning tool pinned to always-ask even under a yolo global", async () => {
    createMockVault().install();
    const status = await setApprovalMode("yolo");

    expect(status.approval.effectiveModes.transcribe_audio).toBe("alwaysAsk");
    expect(status.approval.effectiveModes.write_note).toBe("yolo");
  });

  it("lets a per-tool override claw one tool back, and only that one", async () => {
    createMockVault().install();
    await setApprovalMode("yolo");
    const status = await setToolApprovalOverride("write_note", "alwaysAsk");

    expect(status.approval.toolOverrides.write_note).toBe("alwaysAsk");
    expect(status.approval.effectiveModes.write_note).toBe("alwaysAsk");
    expect(status.approval.effectiveModes.use_skill).toBe("yolo");
  });

  it("leaves a more-permissive override inert rather than widening the global", async () => {
    // The global mode is a true ceiling: a user reasoning about their own
    // configuration only has to read one value to know the worst case.
    createMockVault().install();
    const status = await setToolApprovalOverride("write_note", "yolo");

    expect(status.approval.toolOverrides.write_note).toBe("yolo");
    expect(status.approval.effectiveModes.write_note).toBe("alwaysAsk");
  });

  it("restores the compiled-in default when an override is cleared", async () => {
    createMockVault().install();
    await setApprovalMode("yolo");
    await setToolApprovalOverride("transcribe_audio", "yolo");
    const cleared = await setToolApprovalOverride("transcribe_audio", null);

    expect(cleared.approval.toolOverrides.transcribe_audio).toBeUndefined();
    // Clearing is NOT the same as storing the global: the pin comes back.
    expect(cleared.approval.effectiveModes.transcribe_audio).toBe("alwaysAsk");
  });

  it("refuses an override for a tool this build does not gate", async () => {
    createMockVault().install();
    await expect(setToolApprovalOverride("search_notes", "alwaysAsk")).rejects.toMatchObject({
      kind: "invalidName",
    });
  });

  it("refuses an answer for an approval that is not live", async () => {
    // Rust is the only expiry authority. A sheet left open past the timeout is
    // already resolved server-side, so a late "yes" must fail rather than
    // approve after the fact.
    const backend = createMockVault();
    backend.install();
    await expect(
      answerToolApproval("00000000-0000-0000-0000-000000000001", "call-1", true),
    ).rejects.toMatchObject({ kind: "notFound" });
    expect(backend.calls).toContain("answer_tool_approval");
  });
});
