// Journey: a gated tool call, answered, through the REAL Tauri IPC seam — in
// each of the three approval modes.
//
// **Why this file has to exist.** The ChatPane component tests `vi.mock` the
// whole api module, so a wrong Tauri command name, a renamed argument, or a
// payload shape Rust never sends all pass them. Only the mockVault seam drives
// `api.ts` through the same `invoke` path the app uses. `tool-approval.e2e.test.tsx`
// covers the settings commands; this file covers the one that resolves a live
// request, and the journey around it.
//
// The load-bearing assertion is the denial arm: **deny ⇒ the write does not
// happen.** It is only worth anything next to the approval arm, which proves the
// same script DOES write when the answer is yes — otherwise "no note appeared"
// could just as well mean the script never had one.

import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type CreateMockVaultOptions } from "./mockVault";
import type { ChatEvent } from "../lib/types";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];
const NOTE_REL = "Atomic/Spaced recall.md";
const CALL_ID = "call-write";

/** The model announces the write, and the gate stops it before dispatch. */
const gatedWrite: ChatEvent[] = [
  {
    type: "toolCall",
    id: CALL_ID,
    name: "write_note",
    title: "Write note",
    arguments: `{"rel_path":"${NOTE_REL}"}`,
    stepId: null,
  },
  {
    type: "toolApprovalRequested",
    id: CALL_ID,
    tool: "writeNote",
    relPath: NOTE_REL,
    reason: "modeAlwaysAsk",
    expiresInSecs: 120,
  },
];

/** The gate said yes: the call dispatches, the note lands, the run ends. */
const approvedTail: ChatEvent[] = [
  { type: "toolResult", id: CALL_ID, status: "ok", summary: NOTE_REL, detail: null, durationMs: 0 },
  { type: "noteWritten", relPath: NOTE_REL, kind: "atomic" },
  { type: "answer", delta: "Saved that as a note." },
  { type: "done" },
];

/** The gate said no: the call settles as denied and nothing is written. */
const deniedTail: ChatEvent[] = [
  { type: "toolResult", id: CALL_ID, status: "denied", summary: null, detail: null, durationMs: 0 },
  { type: "answer", delta: "I did not write anything." },
  { type: "done" },
];

/** A run whose gated call never reaches the user: the judge (or YOLO) allowed
 *  it, so the timeline gets the record and the user gets no prompt. */
const autoApproved = (rule: "yolo" | "newNoteInVault", checking: boolean): ChatEvent[] => [
  gatedWrite[0],
  ...(checking ? ([{ type: "toolApprovalChecking", id: CALL_ID }] as ChatEvent[]) : []),
  { type: "toolAutoApproved", id: CALL_ID, tool: "writeNote", rule },
  ...approvedTail,
];

const options = (opts: CreateMockVaultOptions): CreateMockVaultOptions => ({
  recents,
  seed: [{ kind: "folder", relPath: "Atomic" }],
  ...opts,
});

/** Land in the chat view, ask a question that trips the gate, and deliver every
 *  frame the mock queued — so the run is parked exactly where Rust would park
 *  it: on the request, with the `chat` invoke still pending. */
async function ask(opts: CreateMockVaultOptions) {
  const ctx = renderApp(options(opts));
  await ctx.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  const composer = await screen.findByLabelText("Ask across your vault");
  await ctx.user.type(composer, "capture that idea about recall");
  await ctx.user.click(screen.getByRole("button", { name: "Send" }));
  await ctx.advanceAllFrames();
  return ctx;
}

const allow = () => screen.getByRole("button", { name: "Allow" });
const deny = () => screen.getByRole("button", { name: "Don't allow" });

/** The report card's ledger of what actually landed on disk. */
const wroteNote = () => screen.queryByRole("button", { name: new RegExp(NOTE_REL) });

describe("always-ask: the user is the gate", () => {
  it("asks before the write, then lets it through", async () => {
    const { user, backend, advanceAllFrames } = await ask({
      chatScript: gatedWrite,
      approvalTails: { approved: approvedTail, denied: deniedTail },
    });

    // Parked on the user: the sheet is up and nothing has been written.
    expect(await screen.findByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(wroteNote()).toBeNull();

    await user.click(allow());
    await advanceAllFrames();

    await waitFor(() => expect(wroteNote()).not.toBeNull());
    // The command's NAME and its argument keys, checked at the one place they
    // are real: the run id scopes the answer, and the decision is a bare bool.
    expect(backend.calls).toContain("answer_tool_approval");
    expect(backend.approvalAnswers).toEqual([
      { turnId: expect.any(String), id: CALL_ID, approved: true },
    ]);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("denies the write, and the write does not happen", async () => {
    const { user, backend, advanceAllFrames } = await ask({
      chatScript: gatedWrite,
      approvalTails: { approved: approvedTail, denied: deniedTail },
    });

    await screen.findByRole("button", { name: "Don't allow" });
    await user.click(deny());
    await advanceAllFrames();

    await waitFor(() =>
      expect(screen.getByText("You said no. Nothing ran.")).toBeInTheDocument(),
    );
    // THE assertion. The approval arm above proves this same script writes when
    // the answer is yes, so an absent note here is the denial doing its job and
    // not a script that never had one.
    expect(wroteNote()).toBeNull();
    expect(backend.approvalAnswers.map((answer) => answer.approved)).toEqual([false]);
  });

  it("scopes the answer to its own run", async () => {
    const { user, backend, advanceAllFrames } = await ask({
      chatScript: gatedWrite,
      approvalTails: { approved: approvedTail, denied: deniedTail },
    });
    await screen.findByRole("button", { name: "Allow" });

    await user.click(allow());
    await advanceAllFrames();
    await waitFor(() => expect(backend.approvalAnswers).toHaveLength(1));

    // A model-authored id reused by a sibling run must never resolve this one.
    // The mock refuses any answer whose run id does not match the parked one, so
    // a journey that reached this line sent the right run id.
    expect(backend.approvalAnswers[0].turnId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("approve-for-me: the judge is the gate", () => {
  it("records the automatic approval and never prompts", async () => {
    const { backend } = await ask({ chatScript: autoApproved("newNoteInVault", true) });

    await waitFor(() => expect(wroteNote()).not.toBeNull());
    expect(
      screen.getByText("Approved automatically (new note in your vault)"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(backend.calls).not.toContain("answer_tool_approval");
  });

  it("says out loud when automatic checking gives up for the rest of the turn", async () => {
    await ask({
      chatScript: [
        { type: "toolApprovalDegraded", reason: "providerUnsupported" },
        ...gatedWrite,
      ],
      approvalTails: { approved: approvedTail, denied: deniedTail },
    });

    // A silent fallback is the exact failure this design exists to prevent: the
    // user picked "approve for me", sees prompts, and concludes the feature is
    // broken rather than that their provider cannot support it.
    expect(
      await screen.findByText(/Automatic checking is off for the rest of this turn/),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Allow" })).toBeInTheDocument();
  });
});

describe("yolo: no gate, and the record is the compensating control", () => {
  it("writes without asking and still puts the approval on the timeline", async () => {
    const { backend } = await ask({ chatScript: autoApproved("yolo", false) });

    await waitFor(() => expect(wroteNote()).not.toBeNull());
    // The prompt is skipped; the record is not. A skipped prompt that leaves no
    // trace is the failure §9.6.3 exists to prevent.
    expect(screen.getByText("Approved automatically (YOLO)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(backend.calls).not.toContain("answer_tool_approval");
  });

  it("keeps Undo on the note it wrote unasked", async () => {
    // Undo is MORE important under YOLO, not less: a user who cannot intervene
    // must still be able to see what happened and take it back.
    await ask({ chatScript: autoApproved("yolo", false) });

    await waitFor(() => expect(wroteNote()).not.toBeNull());
    expect(screen.getByRole("button", { name: /undo/i })).toBeInTheDocument();
  });
});
