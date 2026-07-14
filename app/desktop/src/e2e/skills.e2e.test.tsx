// Journey 8: the skills bank, end-to-end through the REAL Tauri IPC seam.
//
// Drives the whole doing-loop the way the Rust core would: activate a skill
// via the composer's `@` picker (fed by the real `list_skills` command; chips
// feed `chat`'s `activeSkills` across the boundary — asserted on the backend
// record), stream a scripted run that PARKS on an `elicit` frame exactly as
// `UserPrompt::ask` parks the orchestrator, answer it through the real
// `answer_elicitation` command (server-side validation included), and land on
// the report card whose Undo reports per-file outcomes from `undo_skill_run`.
// Plus the declined-consent journey (the skill explains and stops, nothing is
// written) and the Settings › Skills loop: disable the skill through the real
// `set_skill_enabled` seam and the reopened picker no longer offers it.

import { describe, it, expect } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type CreateMockVaultOptions } from "./mockVault";
import type { ChatEvent } from "../lib/types";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

const CONSENT: ChatEvent = {
  type: "elicit",
  id: "consent-1",
  question: "Write the fixture note to your vault?",
  options: [
    { id: "yes", label: "Yes, write it", description: "Creates two notes", imageDataUri: null },
    { id: "no", label: "No, stop here", description: null, imageDataUri: null },
  ],
  multiSelect: false,
};

// A full skill run: activation → narrated step → consent question (the stream
// parks here) → more narration → two writes → the model's announced routing
// rationale as the answer → done.
const happyScript: ChatEvent[] = [
  { type: "skillActivated", id: "fixture-note-workflow", name: "Fixture note workflow" },
  { type: "skillStep", message: "Preparing the fixture note…" },
  CONSENT,
  { type: "skillStep", message: "Writing the notes…" },
  { type: "noteWritten", relPath: "Literature/Fixture talk.md", kind: "literature" },
  { type: "noteWritten", relPath: "Atomic/Fixture idea.md", kind: "atomic" },
  {
    type: "answer",
    delta:
      "I filed the capture under Literature and the concept under Atomic — say the word if you'd rather they live elsewhere.",
  },
  { type: "done" },
];

// The timed-out branch (spec §3.4): the stream parks on the consent question
// and the run then ENDS with it unanswered — the tail after the elicit is the
// run-end wind-down `expireElicitation()` streams when the "timer" fires.
const timeoutScript: ChatEvent[] = [
  { type: "skillActivated", id: "fixture-note-workflow", name: "Fixture note workflow" },
  CONSENT,
  {
    type: "answer",
    delta: "The question timed out, so I stopped — nothing was written.",
  },
  { type: "done" },
];

// The declined branch: same consent question; after a "no" the skill explains
// and stops — no writes, no report card.
const declinedScript: ChatEvent[] = [
  { type: "skillActivated", id: "fixture-note-workflow", name: "Fixture note workflow" },
  CONSENT,
  { type: "answer", delta: "Understood — I stopped there and nothing was written." },
  { type: "done" },
];

/** Render the app, open the recent vault, and wait for the chat pane. */
async function openWorkspace(opts: CreateMockVaultOptions = {}) {
  const result = renderApp({ recents, ...opts });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByText("Neural Assistant AI");
  return result;
}

/** Activate the fixture skill via the `@` picker, then send `prompt`. */
async function sendWithSkill(
  user: Awaited<ReturnType<typeof openWorkspace>>["user"],
  prompt: string,
) {
  const composer = await screen.findByLabelText("Ask across your vault");
  await user.type(composer, "@fix");
  await user.click(
    await screen.findByRole("option", { name: /Fixture note workflow/ }),
  );
  // The pick swapped the trigger for a chip.
  expect(
    within(screen.getByRole("list", { name: "Active skills" })).getByText(
      "Fixture note workflow",
    ),
  ).toBeInTheDocument();
  await user.type(composer, prompt);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

describe("Journey 8: skill run — activate via @, elicit, write, undo", () => {
  it("runs the full doing-loop and reports per-file undo outcomes", async () => {
    const { user, backend } = await openWorkspace({
      chatScript: happyScript,
      undoReport: {
        files: [
          { relPath: "Literature/Fixture talk.md", status: "deleted", message: null },
          {
            relPath: "Atomic/Fixture idea.md",
            status: "skippedEdited",
            message: "You edited this note after the run wrote it.",
          },
        ],
      },
    });

    await sendWithSkill(user, "run the fixture workflow");

    // The chips fed activeSkills across the real IPC boundary.
    expect(backend.chatCalls).toHaveLength(1);
    expect(backend.chatCalls[0].activeSkills).toEqual(["fixture-note-workflow"]);

    // The turn is labelled as a skill turn ("Skill" eyebrow — the name also
    // lives on the composer chip, hence two occurrences) and narrates its
    // progress.
    expect(await screen.findByText("Skill")).toBeInTheDocument();
    expect(screen.getAllByText("Fixture note workflow")).toHaveLength(2);
    expect(await screen.findByText("Preparing the fixture note…")).toBeInTheDocument();

    // The stream parked on the consent question; the composer is held by the
    // still-running turn while the question waits.
    expect(
      await screen.findByText("Write the fixture note to your vault?"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Ask across your vault")).toBeDisabled();
    expect(screen.queryByText(/notes written/)).not.toBeInTheDocument();

    // Answer through the real answer_elicitation command → the run resumes.
    await user.click(screen.getByRole("button", { name: /Yes, write it/ }));
    expect(await screen.findByText("Answered.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Yes, write it/ })).toBeDisabled();

    // The rest of the script streams: narration, the report card's ledger,
    // and the model's own routing rationale as the answer.
    expect(await screen.findByText("Writing the notes…")).toBeInTheDocument();
    expect(await screen.findByText("2 notes written")).toBeInTheDocument();
    expect(screen.getByText("Fixture talk.md")).toBeInTheDocument();
    expect(screen.getByText("Fixture idea.md")).toBeInTheDocument();
    expect(screen.getByText(/I filed the capture under Literature/)).toBeInTheDocument();
    expect(screen.getByText("literature")).toBeInTheDocument();
    expect(screen.getByText("atomic")).toBeInTheDocument();

    // The run settled: the composer frees and Undo appears (run id resolved).
    await waitFor(() =>
      expect(screen.getByLabelText("Ask across your vault")).toBeEnabled(),
    );
    await user.click(await screen.findByRole("button", { name: "Undo" }));

    // Per-file honesty through the real undo_skill_run seam: one removed, one
    // kept because the user edited it — never a bare "done".
    expect(await screen.findByText("Removed")).toBeInTheDocument();
    expect(
      screen.getByText("You edited this note after the run wrote it."),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 note removed, 1 note kept\./)).toBeInTheDocument();
  });

  it("timed-out consent (§3.4): the card goes dormant but stays clickable, and a late click is an ordinary chat turn", async () => {
    const { user, backend } = await openWorkspace({ chatScript: timeoutScript });

    await sendWithSkill(user, "run the fixture workflow");

    // The stream parks on the consent question.
    expect(
      await screen.findByText("Write the fixture note to your vault?"),
    ).toBeInTheDocument();

    // The shell's 5-minute timer fires: the run ends, the question is retired
    // UNANSWERED (timeout ends the RUN, not the QUESTION).
    act(() => backend.expireElicitation());

    // The run settled — composer frees — and the card is dormant: never
    // permanently disabled, every option stays clickable.
    expect(
      await screen.findByText(/The question timed out, so I stopped/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Ask across your vault")).toBeEnabled(),
    );
    const yes = screen.getByRole("button", { name: /Yes, write it/ });
    expect(yes).toBeEnabled();
    expect(screen.queryByText("Answered.")).not.toBeInTheDocument();

    // A late click continues the chat as an ORDINARY turn: a second `chat`
    // invoke carrying the option label (with the still-active skill chip),
    // and NO answer_elicitation against the dead id.
    await user.click(yes);
    await waitFor(() => expect(backend.chatCalls).toHaveLength(2));
    expect(backend.chatCalls[1].prompt).toBe("Yes, write it");
    expect(backend.chatCalls[1].activeSkills).toEqual(["fixture-note-workflow"]);
    expect(backend.calls.filter((c) => c === "answer_elicitation")).toHaveLength(0);
  });

  it("declined consent: the skill explains and stops — nothing written, no report card", async () => {
    // Asserts the SCRIPTED remainder resumes after the park — the frontend
    // loop, not real model branching (that lives in the Rust behavioural eval).
    const { user, backend } = await openWorkspace({ chatScript: declinedScript });

    await sendWithSkill(user, "run the fixture workflow");

    await user.click(
      await screen.findByRole("button", { name: /No, stop here/ }),
    );

    // The model's honest close streams after the answer resolves the park.
    expect(
      await screen.findByText(/Understood — I stopped there and nothing was written\./),
    ).toBeInTheDocument();
    expect(await screen.findByText("Answered.")).toBeInTheDocument();

    // No writes → no report card, and nothing to undo.
    expect(screen.queryByText(/notes written/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(backend.calls.filter((c) => c === "undo_skill_run")).toHaveLength(0);

    // The composer frees for the next turn.
    await waitFor(() =>
      expect(screen.getByLabelText("Ask across your vault")).toBeEnabled(),
    );
  });

  it("Settings › Skills: disabling the skill removes it from the @ picker", async () => {
    const { user, backend } = await openWorkspace();

    // Into Settings › Skills from the titlebar.
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Settings" })).getByRole(
        "button",
        { name: "Skills" },
      ),
    );

    // The fixture skill arrives from the real list_skills command, enabled as
    // it ships, with its honest no-requirements line.
    const toggle = await screen.findByRole("switch", {
      name: "Enable Fixture note workflow",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("No extra software needed.")).toBeInTheDocument();

    // Disable it: the switch renders the state set_skill_enabled read back
    // from the backend, not an optimistic flip.
    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(backend.calls).toContain("set_skill_enabled");

    // Closing Settings bumps the pane's refresh signal → the picker re-reads
    // the catalogue before offering anything.
    const listReadsBeforeClose = backend.calls.filter(
      (c) => c === "list_skills",
    ).length;
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        backend.calls.filter((c) => c === "list_skills").length,
      ).toBeGreaterThan(listReadsBeforeClose),
    );

    // A disabled skill is no longer offerable — the popup has nothing to show.
    await user.type(screen.getByLabelText("Ask across your vault"), "@fix");
    expect(
      screen.queryByRole("listbox", { name: "Skill suggestions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Fixture note workflow/ }),
    ).not.toBeInTheDocument();
  });
});
