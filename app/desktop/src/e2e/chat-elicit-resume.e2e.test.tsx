// Journey: a run asks the user a question mid-stream, is answered, and carries
// on working — issue #125.
//
// **One test in this file is EXPECTED-RED against today's code**
// ("keeps saying the run is working once the question is answered"). It pins a
// live defect in the RENDER layer, not in the fold: `ChatMessages.tsx` derives
// the timeline's `suppressLive` from `hasSkillNarrative`, which ORs
// `turn.pendingElicitation !== null`. No `ChatEvent` ever clears
// `pendingElicitation` — the reducer pins the question deliberately and the
// answer is recorded in `ChatMessages`' own `elicitAnswers` state — so that term
// stays true for the REST of the turn. The live head is therefore switched off
// permanently the moment a turn asks anything, and a resumed run renders
// identically to one still parked on the user.
//
// The scripts below mirror what Rust actually puts on the wire around an
// `ask_user`: the call is announced, the question is emitted, the run parks, and
// answering settles the call with `toolResult(ok)` — after which the
// orchestrator emits NOTHING until the next provider round-trip produces a tool
// call (`orchestrator.rs` issues the turn at the `complete_tool_turn` call site
// with no beacon before it, and re-runs it buffered when the provider doesn't
// stream tool turns). That silent stretch is the window under test.
//
// The three green tests are the controls that make the red one mean something:
// a run genuinely waiting on the user must stay silent, the SAME stream minus
// the question must show its progress at the same point, and the answered run
// must go on to finish. Without them "nothing on screen" could just as well be
// a script that never had anything to show.

import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type CreateMockVaultOptions } from "./mockVault";
import type { ChatEvent } from "../lib/types";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];
const ASK_ID = "call-ask";
const ELICIT_ID = "ask-continue";
const WRITE_ID = "call-write";
const NOTE_REL = "Atomic/Spaced recall.md";
const PROMPT = "write up what I said about recall";

/** The model dispatches `ask_user`, then the question goes out. Rust announces
 *  the call before the prompt, so the rail already carries a node. */
const asks: ChatEvent[] = [
  {
    type: "toolCall",
    id: ASK_ID,
    name: "ask_user",
    title: "Ask you a question",
    arguments: `{"question":"Write this up as a note?"}`,
    stepId: null,
  },
  {
    type: "elicit",
    id: ELICIT_ID,
    question: "Write this up as a note?",
    options: [
      { id: "continue", label: "Continue", description: null, imageDataUri: null },
      { id: "stop", label: "Stop", description: null, imageDataUri: null },
    ],
    multiSelect: false,
  },
];

/** The one event Rust emits on resume: the `ask_user` node settles. Everything
 *  after it waits on a fresh provider round-trip that emits nothing at all. */
const answered: ChatEvent = {
  type: "toolResult",
  id: ASK_ID,
  status: "ok",
  summary: "Continue",
  detail: `{"chosen_ids":["continue"]}`,
  durationMs: 0,
};

const gatedWrite: ChatEvent[] = [
  {
    type: "toolCall",
    id: WRITE_ID,
    name: "write_note",
    title: "Write note",
    arguments: `{"rel_path":"${NOTE_REL}"}`,
    stepId: null,
  },
  {
    type: "toolApprovalRequested",
    id: WRITE_ID,
    tool: "writeNote",
    relPath: NOTE_REL,
    reason: "modeAlwaysAsk",
    expiresInSecs: 120,
  },
];

const approvedTail: ChatEvent[] = [
  { type: "toolResult", id: WRITE_ID, status: "ok", summary: NOTE_REL, detail: null, durationMs: 0 },
  { type: "noteWritten", relPath: NOTE_REL, kind: "atomic" },
  { type: "answer", delta: "Saved that as a note." },
  { type: "done" },
];

/** Keep the `chat` invoke pending after the script drains, so a run that has run
 *  out of scripted frames is still genuinely in flight — exactly the state Rust
 *  is in while it waits on the model. */
const IN_FLIGHT = { cancelChatAfterEvents: 99 } as const;

const options = (
  chatScript: ChatEvent[],
  extra: Partial<CreateMockVaultOptions> = {},
): CreateMockVaultOptions => ({
  recents,
  seed: [{ kind: "folder", relPath: "Atomic" }],
  chatScript,
  approvalTails: { approved: approvedTail, denied: [{ type: "done" }] },
  ...extra,
});

/** Land in the chat view and send the prompt, delivering every queued frame —
 *  so the run sits exactly where the mock parked it. */
async function ask(opts: CreateMockVaultOptions) {
  const ctx = renderApp(opts);
  await ctx.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  const composer = await screen.findByLabelText("Ask across your vault");
  await ctx.user.type(composer, PROMPT);
  await ctx.user.click(screen.getByRole("button", { name: "Send" }));
  await ctx.advanceAllFrames();
  return ctx;
}

const rail = () => screen.queryByRole("region", { name: "What the assistant did" });

/** Whether the pane is telling the user the run is working. The rail's live head
 *  is a live region carrying the phase word; a settled head is a plain summary,
 *  and a suppressed one renders nothing at all. */
const saysItIsWorking = () => {
  const section = rail();
  return section !== null && within(section).queryAllByRole("status").length > 0;
};

/** The pane still considers the run in flight. */
const stillRunning = () =>
  screen.queryByRole("button", { name: "Stop response" }) !== null;

const wroteNote = () => screen.queryByRole("button", { name: new RegExp(NOTE_REL) });

describe("Journey: a question answered mid-run (#125)", () => {
  it("claims no progress while the question is genuinely waiting on the user", async () => {
    await ask(options([...asks, answered], IN_FLIGHT));

    // Parked, not working. A spinner here would claim progress over a run that
    // is doing nothing at all — this is what `suppressLive` exists to produce,
    // and a fix must not simply delete it.
    expect(await screen.findByText("Write this up as a note?")).toBeInTheDocument();
    expect(stillRunning()).toBe(true);
    expect(saysItIsWorking()).toBe(false);
  });

  it("keeps saying the run is working once the question is answered", async () => {
    const { user, advanceNextFrame } = await ask(options([...asks, answered], IN_FLIGHT));

    await user.click(await screen.findByRole("button", { name: /Continue/ }));
    await advanceNextFrame(); // the `ask_user` settlement — Rust's last word for a while

    // The run is now working: the question is answered, no prompt is live, the
    // composer is disabled and Stop is up. The pane owes the user a live
    // indicator for however long the provider takes. Today it shows a SETTLED
    // summary instead, for the rest of the turn.
    expect(stillRunning()).toBe(true);
    expect(saysItIsWorking()).toBe(true);
  });

  it("says the run is working at the same point when no question was asked", async () => {
    // The control, and the whole reason the assertion above means anything: the
    // identical stream minus the `elicit`, stopped at the identical point. The
    // only thing that differs in the folded turn is `pendingElicitation`.
    const ctx = renderApp(options([asks[0], answered], IN_FLIGHT));
    await ctx.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
    const composer = await screen.findByLabelText("Ask across your vault");
    await ctx.user.type(composer, PROMPT);
    await ctx.user.click(screen.getByRole("button", { name: "Send" }));
    await ctx.advanceAllFrames();

    expect(stillRunning()).toBe(true);
    expect(saysItIsWorking()).toBe(true);
  });

  it("carries the answered run through to the write and frees the composer", async () => {
    // The run was never stuck. Answering resumes it, the gated write goes
    // through, and the turn settles — which is what makes the silence above a
    // reporting defect rather than a hang.
    const { user, advanceAllFrames } = await ask(
      options([...asks, answered, ...gatedWrite]),
    );

    await user.click(await screen.findByRole("button", { name: /Continue/ }));
    await advanceAllFrames();
    await user.click(await screen.findByRole("button", { name: "Allow" }));
    await advanceAllFrames();

    await waitFor(() => expect(wroteNote()).not.toBeNull());
    expect(stillRunning()).toBe(false);
    expect(screen.getByLabelText("Ask across your vault")).toBeEnabled();
  });
});
