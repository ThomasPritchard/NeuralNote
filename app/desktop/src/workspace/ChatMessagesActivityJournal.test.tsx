import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  ActivityJournalState,
  JournalActivity,
  JournalCycle,
} from "./activityJournal";
import { emptyAssistant, type AssistantMessage } from "./chatMessage";
import { ChatMessages } from "./ChatMessages";

function journalActivity(
  id: string,
  cycleId: string,
  firstSequence: number,
  overrides: Partial<JournalActivity> = {},
): JournalActivity {
  return {
    id,
    cycleId,
    firstSequence,
    lastSequence: firstSequence,
    lastActiveSequence: firstSequence,
    name: "read_note",
    title: "Read note",
    arguments: "{}",
    stepId: null,
    progress: null,
    preview: null,
    state: "active",
    settlement: null,
    approvalResolution: null,
    noteOutcome: null,
    abandonmentReason: null,
    ...overrides,
  };
}

function cycle(
  id: string,
  firstSequence: number,
  overrides: Partial<JournalCycle> = {},
): JournalCycle {
  return {
    id,
    firstSequence,
    lastSequence: firstSequence,
    thinking: {
      text: "",
      firstSequence,
      lastSequence: firstSequence,
    },
    summary: null,
    activityIds: [],
    ...overrides,
  };
}

function v1Turn(
  journal: ActivityJournalState,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    ...emptyAssistant(true, "turn-v1"),
    activityProtocol: "v1",
    activityJournal: journal,
    ...overrides,
  };
}

function renderTurn(
  turn: AssistantMessage,
  runIds: Readonly<Record<number, string>> = {},
) {
  return render(
    <ChatMessages
      messages={[{ role: "user", content: "Do the work" }, turn]}
      onOpenCitation={vi.fn()}
      onOpenNote={vi.fn()}
      onSendFollowUp={vi.fn()}
      busy={!turn.done}
      runIds={runIds}
    />,
  );
}

function follows(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("ChatMessages v1 activity journal", () => {
  it("renders cycles causally with plain summaries and one replace-in-place action", () => {
    const inspect = journalActivity("inspect", "cycle-a", 5, {
      state: "succeeded",
      settlement: {
        status: "ok",
        summary: "Read the source",
        detail: null,
        durationMs: 18,
      },
    });
    const write = journalActivity("write", "cycle-b", 11, {
      name: "write_note",
      title: "Write note",
      progress: "Writing the note",
      lastSequence: 13,
      lastActiveSequence: 13,
    });
    const sibling = journalActivity("check", "cycle-b", 12, {
      title: "Check conventions",
    });
    const journal: ActivityJournalState = {
      cycles: [
        cycle("cycle-a", 2, {
          lastSequence: 8,
          thinking: {
            text: "Inspecting **the source**.",
            firstSequence: 3,
            lastSequence: 4,
          },
          summary: {
            source: "model",
            message: "**I found the useful source.**",
            protocolIssues: [],
            sequence: 5,
          },
          activityIds: [inspect.id],
        }),
        cycle("cycle-b", 9, {
          lastSequence: 13,
          thinking: {
            text: "Planning the note.",
            firstSequence: 9,
            lastSequence: 10,
          },
          summary: {
            source: "fallback",
            message: "Next, I’ll write the note.",
            protocolIssues: [],
            sequence: 10,
          },
          activityIds: [write.id, sibling.id],
        }),
      ],
      activities: { inspect, write, check: sibling },
      finalThinking: null,
      hostStatus: null,
      plan: [],
      partialRun: null,
      terminal: { kind: "active", message: null },
      warning: null,
      lastSequence: 13,
    };

    renderTurn(v1Turn(journal));

    const thinking = screen.getAllByText("Thinking", { selector: "summary" });
    const firstSummary = screen.getByText("**I found the useful source.**");
    const secondSummary = screen.getByText("Next, I’ll write the note.");
    const status = screen.getByRole("status");
    expect(thinking).toHaveLength(2);
    expect(follows(thinking[0], firstSummary)).toBe(true);
    expect(follows(firstSummary, thinking[1])).toBe(true);
    expect(follows(thinking[1], secondSummary)).toBe(true);
    expect(follows(secondSummary, status)).toBe(true);
    expect(firstSummary.querySelector("strong")).toBeNull();
    expect(status).toHaveTextContent("Writing the note");
    expect(status).toHaveTextContent("+1 running");
    expect(screen.queryByText(/Reasoning|round\s+\d|cycle\s+\d/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "What the assistant did" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Skill progress")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Note write/)).not.toBeInTheDocument();
  });

  it("keeps the status node stable while its current action is replaced", () => {
    const first = journalActivity("work", "cycle-a", 4, {
      progress: "Fetching captions",
    });
    const base: ActivityJournalState = {
      cycles: [cycle("cycle-a", 2, { activityIds: [first.id] })],
      activities: { work: first },
      finalThinking: null,
      hostStatus: null,
      plan: [],
      partialRun: null,
      terminal: { kind: "active", message: null },
      warning: null,
      lastSequence: 4,
    };
    const { rerender } = renderTurn(v1Turn(base));
    const status = screen.getByRole("status");

    const updated = {
      ...base,
      activities: {
        work: {
          ...first,
          progress: "Listing related notes",
          lastSequence: 5,
          lastActiveSequence: 5,
        },
      },
      lastSequence: 5,
    } satisfies ActivityJournalState;
    rerender(
      <ChatMessages
        messages={[
          { role: "user", content: "Do the work" },
          v1Turn(updated),
        ]}
        onOpenCitation={vi.fn()}
        onOpenNote={vi.fn()}
        onSendFollowUp={vi.fn()}
        busy
        runIds={{}}
      />,
    );

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Listing related notes");
    expect(status).not.toHaveTextContent("Fetching captions");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("parks a user-owned activity without a spinner or running count", () => {
    const parked = journalActivity("approval", "cycle-a", 4, {
      title: "Write note",
      state: "awaitingUser",
    });
    const journal: ActivityJournalState = {
      cycles: [cycle("cycle-a", 2, { activityIds: [parked.id] })],
      activities: { approval: parked },
      finalThinking: null,
      hostStatus: null,
      plan: [],
      partialRun: null,
      terminal: { kind: "active", message: null },
      warning: null,
      lastSequence: 4,
    };

    renderTurn(v1Turn(journal));

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Waiting for you");
    expect(status).not.toHaveTextContent(/running/i);
    expect(status.querySelector(".animate-spin")).toBeNull();
  });

  it("retains the authoritative approval prompt on a parked v1 activity", () => {
    const parked = journalActivity("approval", "cycle-a", 4, {
      title: "Write note",
      state: "awaitingUser",
    });
    const journal: ActivityJournalState = {
      cycles: [cycle("cycle-a", 2, { activityIds: [parked.id] })],
      activities: { approval: parked },
      finalThinking: null,
      hostStatus: null,
      plan: [],
      partialRun: null,
      terminal: { kind: "active", message: null },
      warning: null,
      lastSequence: 4,
    };
    const approval = {
      id: "approval",
      tool: "writeNote" as const,
      relPath: "Notes/Approved.md",
      reason: "modeAlwaysAsk" as const,
      expiresInSecs: 120,
      checking: false,
      resolution: null,
      autoApprovedRule: null,
    };

    renderTurn(
      v1Turn(journal, {
        pendingApproval: approval,
        toolApprovals: [approval],
      }),
    );

    expect(
      screen.getByRole("region", {
        name: "Allow NeuralNote to create or change a note in your vault?",
      }),
    ).toBeVisible();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for you");
  });

  it("retains the authoritative elicitation on a parked v1 activity", () => {
    const parked = journalActivity("question", "cycle-a", 4, {
      title: "Choose a source",
      state: "awaitingUser",
    });
    const journal: ActivityJournalState = {
      cycles: [cycle("cycle-a", 2, { activityIds: [parked.id] })],
      activities: { question: parked },
      finalThinking: null,
      hostStatus: null,
      plan: [],
      partialRun: null,
      terminal: { kind: "active", message: null },
      warning: null,
      lastSequence: 4,
    };

    renderTurn(
      v1Turn(journal, {
        pendingElicitation: {
          id: "question",
          question: "Which source should I use?",
          options: [
            {
              id: "first",
              label: "The first source",
              description: null,
              imageDataUri: null,
            },
          ],
          multiSelect: false,
        },
      }),
    );

    expect(screen.getByText("Which source should I use?")).toBeVisible();
    expect(screen.getByRole("button", { name: /The first source/ })).toBeEnabled();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for you");
  });

  it("lazy-mounts settled actions in first-sequence order", async () => {
    const later = journalActivity("later", "cycle-a", 7, {
      title: "Second action",
      state: "failed",
      settlement: {
        status: "error",
        summary: null,
        detail: "The second action failed.",
        durationMs: 6,
      },
    });
    const earlier = journalActivity("earlier", "cycle-a", 4, {
      title: "First action",
      state: "succeeded",
      settlement: {
        status: "ok",
        summary: "Finished first",
        detail: null,
        durationMs: 5,
      },
    });
    const journal: ActivityJournalState = {
      cycles: [
        cycle("cycle-a", 2, {
          summary: {
            source: "model",
            message: "I’ll do both actions.",
            protocolIssues: [{ kind: "missing" }],
            sequence: 3,
          },
          activityIds: [later.id, earlier.id],
        }),
      ],
      activities: { later, earlier },
      finalThinking: null,
      hostStatus: null,
      plan: [],
      partialRun: null,
      terminal: { kind: "completed", message: null },
      warning: null,
      lastSequence: 9,
    };
    const user = userEvent.setup();

    renderTurn(v1Turn(journal, { done: true }));

    const actions = screen.getByText(/Actions \(2\)/, { selector: "summary" });
    expect(screen.queryByText("First action")).not.toBeInTheDocument();
    expect(screen.queryByText("Second action")).not.toBeInTheDocument();
    expect(screen.queryByText("Cycle summary was missing.")).not.toBeInTheDocument();
    await user.click(actions);
    const first = screen.getByText("First action");
    const second = screen.getByText("Second action");
    expect(follows(first, second)).toBe(true);
    expect(actions).toHaveTextContent("1 failed");
    expect(screen.getByText("Cycle summary was missing.")).toBeVisible();
  });

  it("places final-answer Thinking directly before the answer and keeps early-end truth visible", () => {
    const journal: ActivityJournalState = {
      cycles: [
        cycle("cycle-a", 2, {
          summary: {
            source: "model",
            message: "I checked the source.",
            protocolIssues: [],
            sequence: 3,
          },
        }),
      ],
      activities: {},
      finalThinking: {
        text: "Checking the final account.",
        firstSequence: 7,
        lastSequence: 7,
      },
      hostStatus: null,
      plan: [],
      partialRun: "the remaining task could not run",
      terminal: { kind: "completed", message: null },
      warning: null,
      lastSequence: 9,
    };

    renderTurn(
      v1Turn(journal, {
        answer: "The final answer.",
        done: true,
      }),
    );

    const thinking = screen.getByText("Thinking", { selector: "summary" });
    const answer = screen.getByText("The final answer.");
    expect(follows(thinking, answer)).toBe(true);
    expect(screen.getByText(/Run ended early: the remaining task could not run/)).toBeVisible();
    expect(thinking.closest("details")).not.toHaveTextContent("summary");
    expect(answer.closest("[aria-live]")).toBeNull();
    expect(screen.queryByText(/didn.t return any/i)).toBeNull();
  });

  it("uses typed host status when no activity owns the current line", () => {
    const journal: ActivityJournalState = {
      cycles: [cycle("cycle-a", 2, { summary: null })],
      activities: {},
      finalThinking: null,
      hostStatus: { message: "Preparing caption extraction", sequence: 4 },
      plan: [],
      partialRun: null,
      terminal: { kind: "active", message: null },
      warning: null,
      lastSequence: 4,
    };

    renderTurn(v1Turn(journal));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing caption extraction",
    );
  });

  it("shows one incomplete-history account when the shared error repeats it", () => {
    const message = "Activity history is incomplete.";
    const journal: ActivityJournalState = {
      cycles: [],
      activities: {},
      finalThinking: null,
      hostStatus: null,
      plan: [],
      partialRun: null,
      terminal: { kind: "incomplete", message },
      warning: message,
      lastSequence: 4,
    };

    renderTurn(v1Turn(journal, { done: true, error: message }));

    expect(screen.getAllByText(message)).toHaveLength(1);
  });

  it("retains activation remedies, video context, degradation, and the active plan", () => {
    const activity = journalActivity("video", "cycle-a", 4);
    const journal: ActivityJournalState = {
      cycles: [cycle("cycle-a", 2, { activityIds: [activity.id] })],
      activities: { video: activity },
      finalThinking: null,
      hostStatus: null,
      plan: [{ id: "collect", label: "Collect the captions", status: "running" }],
      partialRun: null,
      terminal: { kind: "active", message: null },
      warning: null,
      lastSequence: 4,
    };

    renderTurn(
      v1Turn(journal, {
        skillActivations: [{ id: "youtube-distil", name: "YouTube distil" }],
        skillActivationFailures: [
          {
            id: "fixture",
            name: "Fixture",
            message: "Fixture could not be activated.",
            missingBinary: null,
          },
        ],
        approvalDegraded: "providerUnsupported",
        playlist: { position: 1, total: 2 },
        videoPreview: {
          videoId: "video-1",
          title: "A useful talk",
          durationSecs: 120,
          channel: "NeuralNote",
          thumbnailDataUri: null,
        },
      }),
    );

    expect(screen.getByText("YouTube distil")).toBeVisible();
    expect(screen.getByText("Fixture could not be activated.")).toBeVisible();
    expect(screen.getByText(/Automatic checking is off/)).toBeVisible();
    expect(screen.getByText("A useful talk")).toBeVisible();
    expect(screen.getByRole("region", { name: "Task plan" })).toHaveTextContent(
      "Collect the captions",
    );
  });

  it("keeps the final answer, report, citations, coverage, usage, and Undo shared", () => {
    const journal: ActivityJournalState = {
      cycles: [],
      activities: {},
      finalThinking: null,
      hostStatus: null,
      plan: [],
      partialRun: null,
      terminal: { kind: "completed", message: null },
      warning: null,
      lastSequence: 8,
    };

    renderTurn(
      v1Turn(journal, {
        answer: "The note is ready [e1].",
        done: true,
        writtenNotes: [{ relPath: "Literature/Talk.md", kind: "literature" }],
        citations: [
          {
            id: "e1",
            relPath: "Sources/Talk.md",
            startLine: 4,
            endLine: 8,
            text: "Useful evidence",
          },
        ],
        coverage: {
          searchedTerms: ["talk"],
          notesRead: ["Sources/Talk.md"],
          truncated: true,
          skippedFiles: 0,
        },
        usage: {
          elapsedMs: 1_200,
          tokensIn: 100,
          tokensOut: 40,
          model: "local-model",
        },
      }),
      { 1: "run-1" },
    );

    expect(screen.getByText(/The note is ready/)).toBeVisible();
    expect(screen.getByRole("list", { name: "Cited sources" })).toBeVisible();
    expect(screen.getByText(/Partial coverage/)).toBeVisible();
    expect(screen.getByRole("list", { name: "What this turn cost" })).toBeVisible();
    expect(screen.getByText("1 note written")).toBeVisible();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("keeps one note viewport owner across parallel selection and retires it into Actions", async () => {
    class NoopResizeObserver implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    const first = journalActivity("first", "cycle-a", 4, {
      preview: {
        relPath: "Notes/First.md",
        kind: "atomic",
        body: "First draft",
        complete: false,
      },
      lastActiveSequence: 4,
    });
    const second = journalActivity("second", "cycle-a", 5, {
      preview: {
        relPath: "Notes/Second.md",
        kind: "atomic",
        body: "Second draft",
        complete: false,
      },
      lastActiveSequence: 5,
    });
    const base: ActivityJournalState = {
      cycles: [cycle("cycle-a", 2, { activityIds: [first.id, second.id] })],
      activities: { first, second },
      finalThinking: null,
      hostStatus: null,
      plan: [],
      partialRun: null,
      terminal: { kind: "active", message: null },
      warning: null,
      lastSequence: 5,
    };
    const view = renderTurn(v1Turn(base));
    const viewport = screen.getByRole("region", { name: "Note draft content" });
    expect(viewport).toHaveTextContent("Second draft");

    const secondSettled: JournalActivity = {
      ...second,
      state: "succeeded",
      settlement: {
        status: "ok",
        summary: "Wrote the second note",
        detail: null,
        durationMs: 20,
      },
      noteOutcome: {
        kind: "written",
        relPath: "Notes/Second.md",
        noteKind: "atomic",
      },
      lastSequence: 6,
    };
    const oneRemaining: ActivityJournalState = {
      ...base,
      activities: { first, second: secondSettled },
      lastSequence: 6,
    };
    view.rerender(
      <ChatMessages
        messages={[{ role: "user", content: "Do the work" }, v1Turn(oneRemaining)]}
        onOpenCitation={vi.fn()}
        onOpenNote={vi.fn()}
        onSendFollowUp={vi.fn()}
        busy
        runIds={{}}
      />,
    );
    expect(screen.getByRole("region", { name: "Note draft content" })).toBe(viewport);
    expect(viewport).toHaveTextContent("First draft");

    const firstSettled: JournalActivity = {
      ...first,
      state: "succeeded",
      settlement: {
        status: "ok",
        summary: "Wrote the first note",
        detail: null,
        durationMs: 20,
      },
      lastSequence: 7,
    };
    view.rerender(
      <ChatMessages
        messages={[
          { role: "user", content: "Do the work" },
          v1Turn(
            {
              ...base,
              activities: { first: firstSettled, second: secondSettled },
              terminal: { kind: "completed", message: null },
              lastSequence: 7,
            },
            { done: true },
          ),
        ]}
        onOpenCitation={vi.fn()}
        onOpenNote={vi.fn()}
        onSendFollowUp={vi.fn()}
        busy={false}
        runIds={{}}
      />,
    );
    expect(screen.queryByRole("region", { name: "Note draft content" })).toBeNull();
    await userEvent.click(screen.getByText(/Actions \(2\)/, { selector: "summary" }));
    expect(screen.getByRole("button", { name: "Notes/Second.md" })).toBeVisible();
    vi.unstubAllGlobals();
  });
});
