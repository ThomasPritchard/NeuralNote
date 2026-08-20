// ChatMessages — the skill-turn surface: the labelled activation header, live
// skill-step narration (activation failures visually distinct from progress),
// the elicitation card wired through the transcript's answered state, the
// report card fed by run ids, and the honesty rule that an empty retrieval
// trace shows no "Searching your vault" spinner while a skill run waits.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAssistant, type AssistantMessage } from "./chatMessage";
import { reduceAssistant } from "./chatMessageReducer";

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

// The backend reports an activation failure twice: a display-only narration step
// and the structured event that carries the remedy. Both strings are composed in
// Rust and identical, which is what lets the UI drop the duplicate row without
// matching any prose of its own — `missingBinary` is what drives the install
// affordance now, so re-wording this sentence can no longer disable it.
const MISSING_YTDLP_MESSAGE =
  "Skill 'youtube-distil' could not be activated: skill 'youtube-distil' is not eligible: unmet requirements: required binary 'yt-dlp' is missing from the app-data bin directory — continuing without it";
const MISSING_YTDLP_FAILURE = {
  id: "youtube-distil",
  name: "YouTube distil",
  message: MISSING_YTDLP_MESSAGE,
  missingBinary: "yt-dlp",
};

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
        toolCalls: [
          {
            id: "call-1",
            name: "search_notes",
            title: "Search notes",
            arguments: '{"query":"provider"}',
            status: "ok",
            summary: "0 spans",
            detail: null,
            stepId: null,
          },
        ],
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

  it("renders an activation failure from the structured event, once, not from its narration", () => {
    const message =
      "Skill 'fixture-note-workflow' could not be activated: it is disabled — continuing without it";
    renderMessages(
      skillTurn({
        // The backend emits both, exactly as it does in a real run.
        skillSteps: [message],
        skillActivationFailures: [
          {
            id: "fixture-note-workflow",
            name: "Fixture note workflow",
            message,
            missingBinary: null,
          },
        ],
      }),
    );

    // Exactly one row: the structured node wins and the duplicate narration is
    // dropped, so the same problem is never stated twice in one turn.
    const rows = screen.getAllByText(message);
    expect(rows).toHaveLength(1);
    expect(rows[0].className).toContain("text-destructive");
    // No structured remedy → no install action is invented for it.
    expect(screen.queryByRole("button", { name: /Download yt-dlp/ })).not.toBeInTheDocument();
  });

  it("shows no install action for a missing binary this app cannot fetch", () => {
    renderMessages(
      skillTurn({
        skillActivationFailures: [
          {
            id: "transcribe",
            name: "Transcribe",
            message: "Skill 'transcribe' could not be activated: ffmpeg is missing",
            missingBinary: "ffmpeg",
          },
        ],
      }),
    );

    expect(
      screen.getByText(/Skill 'transcribe' could not be activated/),
    ).toBeInTheDocument();
    // The download allowlist holds yt-dlp alone; offering to fetch anything else
    // would be a promise the app cannot keep.
    expect(screen.queryByRole("region", { name: "Set up YouTube imports" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });

  it("offers the pinned yt-dlp download inline for the exact missing requirement", async () => {
    let onEvent!: Parameters<typeof api.downloadRequirement>[1];
    mockDownloadRequirement.mockImplementation((_name, listener) => {
      onEvent = listener;
      return Promise.resolve();
    });
    const { user } = renderMessages(
      skillTurn({
        skillActivations: [],
        skillSteps: [MISSING_YTDLP_MESSAGE],
        skillActivationFailures: [MISSING_YTDLP_FAILURE],
        done: true,
      }),
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
      skillTurn({
        skillActivations: [],
        skillSteps: [MISSING_YTDLP_MESSAGE],
        skillActivationFailures: [MISSING_YTDLP_FAILURE],
        done: true,
      }),
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

  it("names each phase only once the event that grounds it has arrived", () => {
    // The head used to say "Thinking" on `processing` — an event emitted before
    // a single token had been asked for. Every label below is now backed by the
    // event that makes it true, and "Thinking" belongs to the one event that
    // proves reasoning is arriving.
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
    expect(screen.getByText("Sending message")).toBeInTheDocument();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.queryByText("Searching your vault")).not.toBeInTheDocument();

    const planning = reduceAssistant(accepted, {
      type: "planningRound",
      round: 1,
      maxRounds: 8,
      playlist: null,
    });
    rerender(
      <ChatMessages
        messages={[{ role: "user", content: "question" }, planning]}
        onOpenCitation={vi.fn()}
        onOpenNote={vi.fn()}
        onSendFollowUp={vi.fn()}
        busy
        runIds={{}}
      />,
    );
    expect(screen.getByText("Planning")).toBeInTheDocument();

    const reasoning = reduceAssistant(planning, { type: "thinking", delta: "weighing" });
    rerender(
      <ChatMessages
        messages={[{ role: "user", content: "question" }, reasoning]}
        onOpenCitation={vi.fn()}
        onOpenNote={vi.fn()}
        onSendFollowUp={vi.fn()}
        busy
        runIds={{}}
      />,
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();

    const searching = reduceAssistant(reasoning, { type: "searching", query: "notes", callId: null });
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
      callId: null,
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

  it("keeps a narrating tool's progress line out of every live region on the turn", () => {
    // The deliberate decision this guards is at `ChatMessages.tsx:95`: the
    // per-row churn of a run (15-20 mutations) stays silent, and liveness is
    // scoped to the phase line, the answer, and the error box. A long tool now
    // narrates itself every few seconds on its node, which under a turn-wide
    // live region would be a screen reader interrupted through a four-minute
    // transcription.
    //
    // Asserted HERE, through the whole turn, and not in `ChatTimeline.test.tsx`:
    // the rail rendered on its own cannot see a live region added to the turn
    // wrapper ABOVE it, which is exactly where one would be added.
    renderMessages(
      skillTurn({
        toolCalls: [
          {
            id: "c1",
            name: "transcribe_audio",
            title: "Transcribe audio",
            arguments: '{"url":"https://youtu.be/abc"}',
            status: null,
            summary: null,
            detail: null,
            stepId: null,
            progress: "Transcribing the audio locally with Whisper",
          },
        ],
      }),
    );

    const line = screen.getByText("Transcribing the audio locally with Whisper");
    expect(line.closest("[aria-live], [role='status'], output")).toBeNull();
    // Nor is it hidden: for a long call this is the only account of what is
    // happening, so it stays readable to anyone who navigates to the node.
    expect(line.closest("[aria-hidden='true']")).toBeNull();
  });
});
