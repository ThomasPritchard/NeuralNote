// ElicitCard: single-select buttons and the multi-select tick-list call
// `answer_elicitation` exactly once and pin the choice; validation errors are
// surfaced and retryable (the backend leaves the question parked); and a
// timed-out question renders DORMANT BUT CLICKABLE — never disabled — with a
// late click continuing the chat as an ordinary turn (spec §3.4).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingElicitation } from "./chatMessage";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, answerElicitation: vi.fn() };
});

import * as api from "../lib/api";
import { ElicitCard } from "./ElicitCard";

const mockAnswer = vi.mocked(api.answerElicitation);

const TURN_ID = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e21";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const singleSelect = (): PendingElicitation => ({
  id: "q1",
  question: "Write the fixture note?",
  options: [
    { id: "yes", label: "Yes, write it", description: "Creates one note", imageDataUri: null },
    { id: "no", label: "No, stop here", description: null, imageDataUri: null },
  ],
  multiSelect: false,
});

const multiSelect = (): PendingElicitation => ({
  id: "q2",
  question: "Which videos should I distil?",
  options: [
    { id: "v1", label: "Intro to Zettelkasten", description: "12:04", imageDataUri: PIXEL },
    { id: "v2", label: "Atomic notes", description: null, imageDataUri: null },
    { id: "v3", label: "Vault tour", description: null, imageDataUri: null },
  ],
  multiSelect: true,
});

function renderCard(
  overrides: Partial<Parameters<typeof ElicitCard>[0]> = {},
  elicitation: PendingElicitation = singleSelect(),
) {
  const onAnswered = vi.fn();
  const onSendFollowUp = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <ElicitCard
      elicitation={elicitation}
      turnId={TURN_ID}
      dormant={false}
      busy={false}
      answer={undefined}
      onAnswered={onAnswered}
      onSendFollowUp={onSendFollowUp}
      {...overrides}
    />,
  );
  return { onAnswered, onSendFollowUp, user, view };
}

beforeEach(() => {
  mockAnswer.mockReset();
  mockAnswer.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ElicitCard — single-select", () => {
  it("renders the question and every option with its description", () => {
    renderCard();
    expect(screen.getByText("Write the fixture note?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Yes, write it/ })).toBeInTheDocument();
    expect(screen.getByText("Creates one note")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /No, stop here/ })).toBeInTheDocument();
  });

  it("takes focus on arrival — the composer is disabled and this is the one actionable thing", () => {
    renderCard();
    expect(screen.getByText("Write the fixture note?").closest("section")).toHaveFocus();
  });

  it("does not steal focus when rendered dormant (re-rendered history)", () => {
    renderCard({ dormant: true });
    expect(screen.getByText("Write the fixture note?").closest("section")).not.toHaveFocus();
  });

  it("answers once with the clicked option id and reports the choice up", async () => {
    const { user, onAnswered } = renderCard();
    await user.click(screen.getByRole("button", { name: /Yes, write it/ }));
    expect(mockAnswer).toHaveBeenCalledExactlyOnceWith(TURN_ID, "q1", ["yes"]);
    await waitFor(() => expect(onAnswered).toHaveBeenCalledExactlyOnceWith("q1", ["yes"]));
  });

  it("ignores further clicks while the answer is in flight", async () => {
    let resolve!: () => void;
    mockAnswer.mockImplementation(
      () => new Promise<void>((res) => { resolve = res; }),
    );
    const { user } = renderCard();
    await user.click(screen.getByRole("button", { name: /Yes, write it/ }));
    await user.click(screen.getByRole("button", { name: /No, stop here/ }));
    expect(mockAnswer).toHaveBeenCalledTimes(1);
    resolve();
  });

  it("renders the answered state: controls disabled, choice pinned, status announced", () => {
    renderCard({ answer: ["yes"] });
    const chosen = screen.getByRole("button", { name: /Yes, write it/ });
    const other = screen.getByRole("button", { name: /No, stop here/ });
    expect(chosen).toBeDisabled();
    expect(other).toBeDisabled();
    expect(screen.getByText("Answered.")).toBeInTheDocument();
    // answer_elicitation was already called by the interaction that produced
    // `answer` — a re-render must not fire it again.
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it("surfaces a validation failure for retry — the question stays live server-side", async () => {
    mockAnswer.mockRejectedValueOnce({
      kind: "invalidName",
      message: "choice 'yes' was not offered by elicitation 'q1'",
    });
    const { user, onAnswered } = renderCard();
    await user.click(screen.getByRole("button", { name: /Yes, write it/ }));

    expect(
      await screen.findByText(/choice 'yes' was not offered/),
    ).toBeInTheDocument();
    expect(onAnswered).not.toHaveBeenCalled();

    // Retry goes back through answer_elicitation — the prompt is still parked.
    await user.click(screen.getByRole("button", { name: /No, stop here/ }));
    expect(mockAnswer).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith("q1", ["no"]));
  });

  it("drops to the expired register on a dead id — still clickable, later clicks continue the chat", async () => {
    mockAnswer.mockRejectedValueOnce({
      kind: "notFound",
      message: "elicitation 'q1' is not live (it may have timed out or ended)",
    });
    const { user, onSendFollowUp, onAnswered } = renderCard();
    await user.click(screen.getByRole("button", { name: /Yes, write it/ }));

    expect(
      await screen.findByText(/This question expired — picking an answer continues the chat./),
    ).toBeInTheDocument();
    expect(onAnswered).not.toHaveBeenCalled();
    // NEVER disabled — the click affordance is what makes the timeout cheap.
    expect(screen.getByRole("button", { name: /Yes, write it/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /Yes, write it/ }));
    expect(onSendFollowUp).toHaveBeenCalledExactlyOnceWith("Yes, write it");
    expect(mockAnswer).toHaveBeenCalledTimes(1); // the dead id is not retried
  });

  it("routes dormant clicks straight into an ordinary chat turn", async () => {
    const { user, onSendFollowUp } = renderCard({ dormant: true });
    const yes = screen.getByRole("button", { name: /Yes, write it/ });
    expect(yes).toBeEnabled();
    await user.click(yes);
    expect(mockAnswer).not.toHaveBeenCalled();
    expect(onSendFollowUp).toHaveBeenCalledExactlyOnceWith("Yes, write it");
  });

  it("holds a dormant answer while a newer run streams (transient disable)", async () => {
    const { user, onSendFollowUp } = renderCard({ dormant: true, busy: true });
    const yes = screen.getByRole("button", { name: /Yes, write it/ });
    expect(yes).toBeDisabled();
    await user.click(yes);
    expect(onSendFollowUp).not.toHaveBeenCalled();
  });
});

describe("ElicitCard — multi-select", () => {
  it("renders a tick-list (with thumbnails where provided) and disables Confirm at zero ticks", () => {
    renderCard({}, multiSelect());
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    // The thumbnail is decorative (alt="") — the label names the option.
    const img = document.querySelector("img");
    expect(img).toHaveAttribute("src", PIXEL);
    expect(img).toHaveAttribute("alt", "");
    expect(screen.getByRole("button", { name: "Confirm selection" })).toBeDisabled();
  });

  it("confirms the ticked options in one answer_elicitation call", async () => {
    const { user, onAnswered } = renderCard({}, multiSelect());
    await user.click(screen.getByRole("checkbox", { name: /Intro to Zettelkasten/ }));
    await user.click(screen.getByRole("checkbox", { name: /Vault tour/ }));
    await user.click(screen.getByRole("button", { name: "Confirm selection" }));

    expect(mockAnswer).toHaveBeenCalledExactlyOnceWith(TURN_ID, "q2", ["v1", "v3"]);
    await waitFor(() =>
      expect(onAnswered).toHaveBeenCalledExactlyOnceWith("q2", ["v1", "v3"]),
    );
  });

  it("shows playlist page selection tools and keeps the selected count explicit", async () => {
    const { user } = renderCard(
      {},
      {
        ...multiSelect(),
        question: "Choose videos from 'Agent talks' (page 2 of 4).",
      },
    );

    expect(screen.getByText("0 selected on this page")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select page" }));
    expect(screen.getByText("3 selected on this page")).toBeInTheDocument();
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Clear page" }));
    expect(screen.getByText("0 selected on this page")).toBeInTheDocument();
    for (const box of screen.getAllByRole("checkbox")) expect(box).not.toBeChecked();
  });

  it("renders the answered tick-list read-only with the choices pinned", () => {
    renderCard({ answer: ["v1", "v3"] }, multiSelect());
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Intro to Zettelkasten/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Atomic notes/ })).not.toBeChecked();
    // Nothing left to confirm.
    expect(screen.queryByRole("button", { name: "Confirm selection" })).not.toBeInTheDocument();
  });

  it("drops to the expired register on a dead id — a later confirmation continues the chat", async () => {
    mockAnswer.mockRejectedValueOnce({
      kind: "notFound",
      message: "elicitation 'q2' is not live (it may have timed out or ended)",
    });
    const { user, onSendFollowUp, onAnswered } = renderCard({}, multiSelect());
    await user.click(screen.getByRole("checkbox", { name: /Intro to Zettelkasten/ }));
    await user.click(screen.getByRole("button", { name: "Confirm selection" }));

    expect(
      await screen.findByText(/This question expired — picking an answer continues the chat./),
    ).toBeInTheDocument();
    expect(onAnswered).not.toHaveBeenCalled();
    // Ticks and Confirm stay live — never permanently disabled.
    expect(screen.getByRole("checkbox", { name: /Intro to Zettelkasten/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Confirm selection" })).toBeEnabled();

    // A reworked selection confirms as an ordinary turn; the dead id is
    // never retried.
    await user.click(screen.getByRole("checkbox", { name: /Atomic notes/ }));
    await user.click(screen.getByRole("button", { name: "Confirm selection" }));
    expect(onSendFollowUp).toHaveBeenCalledExactlyOnceWith(
      "Intro to Zettelkasten, Atomic notes",
    );
    expect(mockAnswer).toHaveBeenCalledTimes(1);
  });

  it("sends a dormant confirmation as an ordinary turn naming the choices", async () => {
    const { user, onSendFollowUp } = renderCard({ dormant: true }, multiSelect());
    await user.click(screen.getByRole("checkbox", { name: /Intro to Zettelkasten/ }));
    await user.click(screen.getByRole("checkbox", { name: /Atomic notes/ }));
    await user.click(screen.getByRole("button", { name: "Confirm selection" }));
    expect(mockAnswer).not.toHaveBeenCalled();
    expect(onSendFollowUp).toHaveBeenCalledExactlyOnceWith(
      "Intro to Zettelkasten, Atomic notes",
    );
  });
});
