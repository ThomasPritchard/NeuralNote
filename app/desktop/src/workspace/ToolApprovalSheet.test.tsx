// The security prompt: that it appears where the request was made, that both
// answers reach the one command that can resolve it, and that it never leaves an
// answerable-looking sheet on screen once Rust has torn the request down.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, answerToolApproval: vi.fn(), answerElicitation: vi.fn() };
});

import * as api from "../lib/api";
import { ChatMessages } from "./ChatMessages";
import { ToolApprovalSheet } from "./ToolApprovalSheet";
import { emptyAssistant, type ChatMessage, type ToolApprovalView } from "./chatMessage";

const mockAnswer = vi.mocked(api.answerToolApproval);
const TURN_ID = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e21";

function approval(patch: Partial<ToolApprovalView> = {}): ToolApprovalView {
  return {
    id: "call-1",
    tool: "writeNote",
    relPath: "Atomic/Spaced recall.md",
    reason: "modeAlwaysAsk",
    expiresInSecs: 120,
    checking: false,
    resolution: null,
    autoApprovedRule: null,
    ...patch,
  };
}

function setup(view = approval(), dormant = false) {
  const user = userEvent.setup();
  const result = render(
    <ToolApprovalSheet approval={view} turnId={TURN_ID} dormant={dormant} />,
  );
  return { user, ...result };
}

const allow = () => screen.getByRole("button", { name: "Allow" });
const deny = () => screen.getByRole("button", { name: "Don't allow" });

/** A CoreError-shaped rejection, exactly as the IPC layer surfaces one. */
const coreError = (kind: string, message: string) => ({ kind, message });

beforeEach(() => {
  mockAnswer.mockReset();
  mockAnswer.mockResolvedValue(undefined);
});

describe("the approval sheet", () => {
  it("asks in plain language and shows the human the real path", () => {
    setup();

    expect(
      screen.getByRole("region", {
        name: "Allow NeuralNote to create or change a note in your vault?",
      }),
    ).toBeInTheDocument();
    // The backend hands the judge a salted digest and the human the real path —
    // two audiences, two trust profiles. This is the human's half.
    expect(screen.getByText("Atomic/Spaced recall.md")).toBeInTheDocument();
  });

  it("says why it is asking and how long the request stays live", () => {
    setup();

    expect(
      screen.getByText(/You asked to be checked with before every action\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/expires in 2 minutes/)).toBeInTheDocument();
  });

  it("counts a short window in seconds rather than rounding it to a minute", () => {
    // A request with 45 seconds left is not "1 minute", and this is the number a
    // user decides how urgently to look at it on.
    setup(approval({ expiresInSecs: 45 }));

    expect(
      screen.getByText(/This expires in 45 seconds if you do not answer\./),
    ).toBeInTheDocument();
  });

  it("says nothing about expiry when the gate gave no deadline", () => {
    setup(approval({ expiresInSecs: null }));

    expect(screen.queryByText(/expires in/)).toBeNull();
  });

  it("names no identifier when the tool is one this build does not know", () => {
    setup(approval({ tool: null, relPath: null }));

    expect(
      screen.getByRole("region", { name: "Allow NeuralNote to run this action?" }),
    ).toBeInTheDocument();
  });

  it("sends an approval through the security-only command", async () => {
    const { user } = setup();

    await user.click(allow());

    // A SEPARATE command from `answerElicitation` on purpose: `ask_user` lets
    // the model author its own question text, so one shared command would let an
    // answer meant for a model-authored question satisfy a security prompt.
    expect(mockAnswer).toHaveBeenCalledExactlyOnceWith(TURN_ID, "call-1", true);
    expect(vi.mocked(api.answerElicitation)).not.toHaveBeenCalled();
  });

  it("sends a denial as an explicit no", async () => {
    const { user } = setup();

    await user.click(deny());

    expect(mockAnswer).toHaveBeenCalledExactlyOnceWith(TURN_ID, "call-1", false);
  });

  it("takes focus on the card, never on an answer", () => {
    // A request arriving mid-run is the one thing on screen to act on, so the
    // card takes focus — but no answer to a security prompt may be one Enter
    // keypress away from someone who was typing something else.
    const { container } = setup();

    expect(document.activeElement).toBe(container.querySelector("section"));
  });

  it("puts refusing before allowing in the tab order", async () => {
    const { user } = setup();

    await user.tab();

    expect(document.activeElement).toBe(deny());
  });

  it("keeps focus on the card once the answer is away", async () => {
    const { user, container } = setup();

    await user.click(allow());

    // The buttons are about to disappear with the sheet; a keyboard user must
    // not be dropped to the document body when they do.
    await waitFor(() =>
      expect(document.activeElement).toBe(container.querySelector("section")),
    );
  });

  it("goes quiet when Rust reports the request is no longer live", async () => {
    // Rust is the only expiry authority, so a late "yes" fails rather than
    // approving after the fact.
    mockAnswer.mockRejectedValue(coreError("notFound", "approval is not live"));
    const { user } = setup();

    await user.click(allow());

    expect(
      await screen.findByText("This request expired — nothing ran."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("surfaces any other failure and leaves the request answerable", async () => {
    // A transport failure leaves the request live server-side. A security prompt
    // that quietly fails to send is indistinguishable from one never answered.
    mockAnswer.mockRejectedValueOnce(coreError("ai", "the channel dropped"));
    const { user } = setup();

    await user.click(allow());

    expect(await screen.findByRole("alert")).toHaveTextContent("the channel dropped");
    expect(allow()).toBeEnabled();

    mockAnswer.mockResolvedValueOnce(undefined);
    await user.click(allow());
    expect(mockAnswer).toHaveBeenCalledTimes(2);
  });

  it("renders dead, not answerable, once the run has ended", async () => {
    const { user } = setup(approval(), true);

    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(
      screen.getByText("The run ended before this was answered — nothing ran."),
    ).toBeInTheDocument();
    // Nothing to click, and nothing sent even so.
    await user.tab();
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it("does not take focus from a settled turn re-rendered from history", () => {
    const { container } = setup(approval(), true);

    expect(document.activeElement).not.toBe(container.querySelector("section"));
  });
});

// ── In the transcript ────────────────────────────────────────────────────────

function transcript(pending: ToolApprovalView | null, done = false): ChatMessage[] {
  return [
    { role: "user", content: "capture that idea" },
    {
      ...emptyAssistant(false, TURN_ID),
      toolCalls: [
        {
          id: "call-1",
          name: "write_note",
          title: "Write note",
          arguments: "{}",
          status: null,
          summary: null,
          detail: null,
        },
      ],
      toolApprovals: pending === null ? [] : [pending],
      pendingApproval: pending,
      done,
    },
  ];
}

function renderTranscript(messages: ChatMessage[]) {
  return render(
    <ChatMessages
      messages={messages}
      onOpenCitation={() => {}}
      onOpenNote={() => {}}
      onSendFollowUp={() => {}}
      busy
      runIds={{}}
    />,
  );
}

describe("the approval sheet in the transcript", () => {
  it("appears while a request is pending and goes when it resolves", () => {
    const { rerender } = renderTranscript(transcript(approval()));
    expect(allow()).toBeInTheDocument();

    // The reducer clears `pendingApproval` on `toolApprovalResolved`. Nothing
    // client-side decides whether a call ran.
    rerender(
      <ChatMessages
        messages={transcript(null)}
        onOpenCitation={() => {}}
        onOpenNote={() => {}}
        onSendFollowUp={() => {}}
        busy
        runIds={{}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("stops the rail claiming progress while the run is parked on the user", () => {
    renderTranscript(transcript(approval()));

    // The run is not searching or reading — it is waiting. A live phase line
    // here would be a spinner lying about what the run is doing.
    expect(screen.queryByText("Searching your vault")).toBeNull();
    expect(screen.getByText("Waiting for your approval")).toBeInTheDocument();
  });

  it("renders the sheet dormant when the run ended with it still open", () => {
    renderTranscript(transcript(approval(), true));

    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(
      screen.getByText("The run ended before this was answered — nothing ran."),
    ).toBeInTheDocument();
  });
});
