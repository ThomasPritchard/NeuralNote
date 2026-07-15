// ChatMessages — the skill-turn surface: the labelled activation header, live
// skill-step narration (activation failures visually distinct from progress),
// the elicitation card wired through the transcript's answered state, the
// report card fed by run ids, and the honesty rule that an empty retrieval
// trace shows no "Searching your vault" spinner while a skill run waits.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAssistant, reduceAssistant, type AssistantMessage } from "./chatMessage";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    answerElicitation: vi.fn(),
    openYoutubeTimestamp: vi.fn(),
    undoSkillRun: vi.fn(),
    downloadRequirement: vi.fn(),
    cancelRequirementDownload: vi.fn(),
  };
});

import * as api from "../lib/api";
import { ChatMessages } from "./ChatMessages";

const mockAnswer = vi.mocked(api.answerElicitation);
const mockOpenYoutube = vi.mocked(api.openYoutubeTimestamp);
const mockDownloadRequirement = vi.mocked(api.downloadRequirement);
const mockCancelRequirementDownload = vi.mocked(api.cancelRequirementDownload);

const MISSING_YTDLP_STEP =
  "Skill 'youtube-distil' could not be activated: skill 'youtube-distil' is not eligible: unmet requirements: required binary 'yt-dlp' is missing from the app-data bin directory — continuing without it";

const PLAYFUL_PROGRESS_PAIRS = [
  ["Sending message", "Thinking"],
  ["Dispatching a tiny messenger", "Connecting the dots"],
  ["Knocking on the model's door", "Rummaging through the mental drawers"],
  ["Launching a thought balloon", "Consulting the inner librarian"],
] as const;

function renderMessages(turn: AssistantMessage, runIds: Record<number, string> = {}) {
  const onOpenCitation = vi.fn();
  const onOpenNote = vi.fn();
  const onSendFollowUp = vi.fn();
  const user = userEvent.setup();
  render(
    <ChatMessages
      messages={[{ role: "user", content: "run the fixture" }, turn]}
      onOpenCitation={onOpenCitation}
      onOpenNote={onOpenNote}
      onSendFollowUp={onSendFollowUp}
      busy={!turn.done}
      runIds={runIds}
    />,
  );
  return { onOpenCitation, onOpenNote, onSendFollowUp, user };
}

const skillTurn = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
  ...emptyAssistant(),
  skillActivations: [{ id: "fixture-note-workflow", name: "Fixture note workflow" }],
  ...overrides,
});

beforeEach(() => {
  mockAnswer.mockReset();
  mockAnswer.mockResolvedValue(undefined);
  mockOpenYoutube.mockReset();
  mockOpenYoutube.mockResolvedValue(undefined);
  mockDownloadRequirement.mockReset();
  mockDownloadRequirement.mockResolvedValue(undefined);
  mockCancelRequirementDownload.mockReset();
  mockCancelRequirementDownload.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ChatMessages — skill turns", () => {
  it("renders a user-stopped turn as neutral while preserving its partial answer", () => {
    renderMessages(
      skillTurn({
        turnId: "turn-1",
        answer: "The partial answer remains visible.",
        activity: [{ kind: "search", query: "partial" }],
        stopped: true,
        done: true,
      }),
    );

    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("The partial answer remains visible.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces a calm truncation notice when the answer was cut off", () => {
    renderMessages(
      skillTurn({
        done: true,
        answer: "The answer stops mid-thought",
        truncated: true,
      }),
    );

    // The partial answer stays visible…
    expect(screen.getByText("The answer stops mid-thought")).toBeInTheDocument();
    // …alongside a visible, informational notice — never the alert register.
    expect(screen.getByText(/Response was cut off/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows no truncation notice for a complete answer", () => {
    renderMessages(
      skillTurn({
        done: true,
        answer: "The complete answer",
      }),
    );

    expect(screen.getByText("The complete answer")).toBeInTheDocument();
    expect(screen.queryByText(/Response was cut off/i)).not.toBeInTheDocument();
  });

  it("labels provider failure context as Failed rather than Stopped", () => {
    renderMessages(
      skillTurn({
        activity: [{ kind: "search", query: "provider" }],
        error: "provider failed",
        done: true,
      }),
    );

    expect(screen.getByText(/^Failed —/)).toBeInTheDocument();
    expect(screen.queryByText(/^Stopped —/)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("provider failed");
  });

  it("offers a verified YouTube timestamp jump beside the note action", async () => {
    const { user } = renderMessages(
      skillTurn({
        done: true,
        citations: [
          {
            id: "e1",
            relPath: "Transcripts/Agent talk transcript.md",
            startLine: 14,
            endLine: 14,
            text:
              "[00:14:32](https://youtu.be/jNQXAC9IVRw?t=872) Verification loops keep the agent honest.",
          },
        ],
      }),
    );

    await user.click(screen.getByRole("button", { name: "Watch at 14:32 on YouTube" }));
    expect(mockOpenYoutube).toHaveBeenCalledExactlyOnceWith(
      "https://youtu.be/jNQXAC9IVRw?t=872",
    );
    expect(
      screen.getByRole("button", { name: /Agent talk transcript\.md:14/ }),
    ).toBeInTheDocument();
  });

  it("keeps the current note-only source behaviour without both an anchor and YouTube id", () => {
    renderMessages(
      skillTurn({
        done: true,
        citations: [
          {
            id: "e1",
            relPath: "Transcripts/Agent talk transcript.md",
            startLine: 14,
            endLine: 14,
            text: "[00:14:32] Verification loops keep the agent honest.",
          },
        ],
      }),
    );

    expect(screen.queryByRole("button", { name: /Watch at/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Agent talk transcript\.md:14/ }),
    ).toBeInTheDocument();
  });

  it("does not trust a linked timestamp on a non-YouTube or malformed URL", () => {
    renderMessages(
      skillTurn({
        done: true,
        citations: [
          {
            id: "e1",
            relPath: "Transcripts/One.md",
            startLine: 2,
            endLine: 2,
            text: "[00:00:05](https://example.com/jNQXAC9IVRw?t=5) Not YouTube.",
          },
          {
            id: "e2",
            relPath: "Transcripts/Two.md",
            startLine: 3,
            endLine: 3,
            text: "[00:00:06](https://[bad) Malformed.",
          },
        ],
      }),
    );

    expect(screen.queryByRole("button", { name: /Watch at/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Transcripts\/One\.md:2/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Transcripts\/Two\.md:3/ })).toBeEnabled();
  });

  it("surfaces a rejected YouTube jump without hiding the note action", async () => {
    mockOpenYoutube.mockRejectedValueOnce({ kind: "io", message: "browser unavailable" });
    const { user } = renderMessages(
      skillTurn({
        done: true,
        citations: [
          {
            id: "e1",
            relPath: "Transcripts/Talk.md",
            startLine: 2,
            endLine: 2,
            text: "[00:00:05](https://youtu.be/jNQXAC9IVRw?t=5) Start.",
          },
        ],
      }),
    );

    await user.click(screen.getByRole("button", { name: "Watch at 00:05 on YouTube" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("browser unavailable");
    expect(screen.getByRole("button", { name: /Transcripts\/Talk\.md:2/ })).toBeEnabled();
  });

  it("labels the turn with each activated skill", () => {
    renderMessages(
      skillTurn({
        skillActivations: [
          { id: "fixture-note-workflow", name: "Fixture note workflow" },
          { id: "youtube-distil", name: "YouTube distil" },
        ],
      }),
    );
    expect(screen.getByText("Fixture note workflow")).toBeInTheDocument();
    expect(screen.getByText("YouTube distil")).toBeInTheDocument();
    expect(screen.getAllByText("Skill")).toHaveLength(2);
  });

  it("renders every skill step, in order, inside the progress list", () => {
    renderMessages(
      skillTurn({
        skillSteps: ["Fetching captions…", "Transcribing locally — this takes a few minutes"],
      }),
    );
    const list = screen.getByRole("list", { name: "Skill progress" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Fetching captions…");
    expect(rows[1]).toHaveTextContent("Transcribing locally — this takes a few minutes");
  });

  it("renders an activation failure as an honest destructive notice, not normal progress", () => {
    renderMessages(
      skillTurn({
        skillSteps: [
          "Skill 'fixture-note-workflow' could not be activated: it is disabled — continuing without it",
        ],
      }),
    );
    const row = screen.getByText(/could not be activated/);
    expect(row.className).toContain("text-destructive");
    expect(screen.queryByRole("button", { name: /Download yt-dlp/ })).not.toBeInTheDocument();
  });

  it("offers the pinned yt-dlp download inline for the exact missing requirement", async () => {
    let onEvent!: Parameters<typeof api.downloadRequirement>[1];
    mockDownloadRequirement.mockImplementation((_name, listener) => {
      onEvent = listener;
      return Promise.resolve();
    });
    const { user } = renderMessages(
      skillTurn({ skillActivations: [], skillSteps: [MISSING_YTDLP_STEP], done: true }),
    );

    const card = screen.getByRole("region", { name: "Set up YouTube imports" });
    expect(within(card).getByText(/isn't installed yet/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Download yt-dlp" }));
    expect(mockDownloadRequirement).toHaveBeenCalledWith("yt-dlp", expect.any(Function));
    const initialProgress = within(card).getByRole("progressbar", {
      name: "Downloading yt-dlp",
    });
    expect(initialProgress).not.toHaveAttribute("value");
    expect(initialProgress).not.toHaveAttribute("aria-valuenow");

    act(() => {
      onEvent({
        type: "progress",
        status: "Downloading…",
        digest: null,
        completed: 25,
        total: 100,
        percent: 25,
      });
    });
    expect(within(card).getByRole("progressbar", { name: "Downloading yt-dlp" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );

    act(() => onEvent({ type: "success" }));
    const readyAnnouncement = within(card).getByRole("status");
    expect(readyAnnouncement).toHaveAttribute("aria-live", "polite");
    expect(readyAnnouncement).toHaveAttribute("aria-atomic", "true");
    expect(readyAnnouncement).toHaveTextContent(/yt-dlp is ready/);
  });

  it("cancels an in-flight inline yt-dlp download", async () => {
    let onEvent!: Parameters<typeof api.downloadRequirement>[1];
    mockDownloadRequirement.mockImplementation((_name, listener) => {
      onEvent = listener;
      return new Promise(() => undefined);
    });
    const { user } = renderMessages(
      skillTurn({ skillActivations: [], skillSteps: [MISSING_YTDLP_STEP], done: true }),
    );

    await user.click(screen.getByRole("button", { name: "Download yt-dlp" }));
    await user.click(screen.getByRole("button", { name: "Cancel yt-dlp download" }));

    expect(mockCancelRequirementDownload).toHaveBeenCalledOnce();
    act(() => {
      onEvent({
        type: "progress",
        status: "Finishing current chunk…",
        digest: null,
        completed: 50,
        total: 100,
        percent: 50,
      });
    });
    expect(screen.getByRole("button", { name: "Cancel yt-dlp download" })).toBeDisabled();
    const progressStatus = screen
      .getByRole("progressbar", { name: "Downloading yt-dlp" })
      .closest("output");
    expect(within(progressStatus as HTMLElement).getByText("Cancelling…")).toBeInTheDocument();
  });

  it("shows no 'Searching your vault' spinner while a skill run waits with an empty retrieval trace", () => {
    renderMessages(
      skillTurn({
        skillSteps: ["Waiting for your answer"],
        pendingElicitation: {
          id: "q1",
          question: "Proceed?",
          options: [
            { id: "yes", label: "Yes", description: null, imageDataUri: null },
            { id: "no", label: "No", description: null, imageDataUri: null },
          ],
          multiSelect: false,
        },
      }),
    );
    expect(screen.queryByText("Searching your vault")).not.toBeInTheDocument();
  });

  it("shows sending before the backend accepts a plain turn without claiming search", () => {
    renderMessages({ ...emptyAssistant() });
    expect(screen.getByText("Sending message")).toBeInTheDocument();
    expect(screen.queryByText("Searching your vault")).not.toBeInTheDocument();
  });

  it("varies the playful copy across prompts while keeping one voice per prompt", () => {
    const labels = [
      "Summarise my project notes",
      "What did I decide about search?",
      "Find the meeting follow-ups",
      "Explain the citation strategy",
      "Draft a short release note",
      "Connect the ideas in this folder",
    ].map((prompt) => {
      const view = render(
        <ChatMessages
          messages={[{ role: "user", content: prompt }, emptyAssistant()]}
          onOpenCitation={vi.fn()}
          onOpenNote={vi.fn()}
          onSendFollowUp={vi.fn()}
          busy
          runIds={{}}
        />,
      );
      const first = view.container.querySelector("output")?.textContent;
      view.rerender(
        <ChatMessages
          messages={[
            { role: "user", content: prompt },
            reduceAssistant(emptyAssistant(), { type: "processing" }),
          ]}
          onOpenCitation={vi.fn()}
          onOpenNote={vi.fn()}
          onSendFollowUp={vi.fn()}
          busy
          runIds={{}}
        />,
      );
      const thinking = view.container.querySelector("output")?.textContent;
      expect(
        PLAYFUL_PROGRESS_PAIRS.some(
          ([sending, matchingThinking]) =>
            sending === first && matchingThinking === thinking,
        ),
      ).toBe(true);
      view.unmount();
      return first;
    });

    expect(new Set(labels).size).toBeGreaterThan(1);
    expect(
      labels.every((label) =>
        PLAYFUL_PROGRESS_PAIRS.some(([sending]) => sending === label),
      ),
    ).toBe(true);
  });

  it("shows thinking only after Processing and search only after Searching", () => {
    const accepted = reduceAssistant(emptyAssistant(), { type: "processing" });
    const { rerender } = render(
      <ChatMessages
        messages={[{ role: "user", content: "question" }, accepted]}
        onOpenCitation={vi.fn()}
        onOpenNote={vi.fn()}
        onSendFollowUp={vi.fn()}
        busy
        runIds={{}}
      />,
    );
    const thinkingLabel = document.querySelector("output")?.textContent;
    expect(PLAYFUL_PROGRESS_PAIRS.map(([, thinking]) => thinking)).toContain(
      thinkingLabel,
    );
    expect(screen.queryByText("Searching your vault")).not.toBeInTheDocument();

    const searching = reduceAssistant(accepted, { type: "searching", query: "notes" });
    rerender(
      <ChatMessages
        messages={[{ role: "user", content: "question" }, searching]}
        onOpenCitation={vi.fn()}
        onOpenNote={vi.fn()}
        onSendFollowUp={vi.fn()}
        busy
        runIds={{}}
      />,
    );
    expect(screen.getByText("Searching your vault")).toBeInTheDocument();

    const reading = reduceAssistant(searching, {
      type: "reading",
      relPath: "Notes/Example.md",
      startLine: 1,
      endLine: 2,
    });
    rerender(
      <ChatMessages
        messages={[{ role: "user", content: "question" }, reading]}
        onOpenCitation={vi.fn()}
        onOpenNote={vi.fn()}
        onSendFollowUp={vi.fn()}
        busy
        runIds={{}}
      />,
    );
    expect(screen.getByText("Reading notes")).toBeInTheDocument();

    const verifying = reduceAssistant(reading, { type: "verifying" });
    rerender(
      <ChatMessages
        messages={[{ role: "user", content: "question" }, verifying]}
        onOpenCitation={vi.fn()}
        onOpenNote={vi.fn()}
        onSendFollowUp={vi.fn()}
        busy
        runIds={{}}
      />,
    );
    expect(screen.getByText("Verifying citations")).toBeInTheDocument();
  });

  it("pins an answered elicitation through the transcript's own state", async () => {
    const { user } = renderMessages(
      skillTurn({
        turnId: "turn-1",
        pendingElicitation: {
          id: "q1",
          question: "Write the note?",
          options: [
            { id: "yes", label: "Yes, write it", description: null, imageDataUri: null },
            { id: "no", label: "No", description: null, imageDataUri: null },
          ],
          multiSelect: false,
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: /Yes, write it/ }));
    expect(mockAnswer).toHaveBeenCalledExactlyOnceWith("turn-1", "q1", ["yes"]);
    // The answered state lives in ChatMessages (there is no resolution
    // ChatEvent), so the card pins and disables without any new event.
    expect(await screen.findByText("Answered.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Yes, write it/ })).toBeDisabled();
  });

  it("routes a dormant elicitation's late click into an ordinary chat turn", async () => {
    const { user, onSendFollowUp } = renderMessages(
      skillTurn({
        turnId: "turn-1",
        done: true,
        pendingElicitation: {
          id: "q1",
          question: "Write the note?",
          options: [
            { id: "yes", label: "Yes, write it", description: null, imageDataUri: null },
          ],
          multiSelect: false,
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: /Yes, write it/ }));
    expect(mockAnswer).not.toHaveBeenCalled();
    expect(onSendFollowUp).toHaveBeenCalledExactlyOnceWith("Yes, write it");
  });

  it("feeds the report card the turn's resolved run id", () => {
    renderMessages(
      skillTurn({
        done: true,
        writtenNotes: [{ relPath: "Literature/Talk.md", kind: "literature" }],
      }),
      { 1: "run-42" }, // the assistant turn sits at message index 1
    );
    expect(screen.getByText("1 note written")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });
});
