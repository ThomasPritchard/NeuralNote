// ChatPane's reasoning affordances: the composer's reasoning toggle (the
// persisted opt-in echoed by `aiStatus`, the capability probe and its
// re-probe-on-model-change rule, the disabled-with-reason states, and the
// failed-write surfacing) plus the backstop notice a finished turn shows when
// reasoning was requested and none arrived.
//
// Split out of `ChatPane.test.tsx`; shared fixtures live in
// `chatPaneTestHarness.tsx`.

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus, ChatEvent } from "../lib/types";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

// ChatPane needs vault.path (to build citation absolute paths) + reportError.
vi.mock("../lib/store", () => ({
  useVault: () => ({ vault: { name: "V", path: "/vault" }, reportError }),
}));

// Mock the AI commands; keep errorMessage real so surfaced text is honest.
// Every ChatPane suite stubs the same set, because `resetChatPaneMocks` resets
// all of them — a suite that stubbed fewer would reset a real function.
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    aiStatus: vi.fn(),
    saveApiKey: vi.fn(),
    chat: vi.fn(),
    cancelChatRun: vi.fn(),
    setReasoning: vi.fn(),
    refreshReasoningSupport: vi.fn(),
    openRouterModelMenu: vi.fn(),
    selectOpenRouterModel: vi.fn(),
    openOpenRouterRankings: vi.fn(),
    listSkills: vi.fn(),
  };
});

import * as api from "../lib/api";
import { ChatPane } from "./ChatPane";
import {
  DEFAULT_MODEL,
  TURN_ID,
  askInChat,
  composer,
  deferred,
  mockAiStatus,
  mockChat,
  mockRefreshSupport,
  mockSetReasoning,
  openRouterActive,
  resetChatPaneMocks,
  sendButton,
  setup,
} from "./chatPaneTestHarness";

beforeEach(() => {
  resetChatPaneMocks(reportError);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const chip = () => screen.getByRole("button", { name: "Show model reasoning" });
const findChip = () => screen.findByRole("button", { name: "Show model reasoning" });

describe("ChatPane — composer reasoning toggle", () => {
  it("renders the persisted opt-in from the status echo and probes support once", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive(DEFAULT_MODEL, { reasoning: true }));
    // The probe echoes "unknown" — the fail-open verdict keeps the chip enabled.
    mockRefreshSupport.mockResolvedValue(
      openRouterActive(DEFAULT_MODEL, { reasoning: true }),
    );
    setup();

    const toggle = await findChip();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toBeEnabled();
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(1));
  });

  it("merges an in-flight same-model support verdict without undoing a newer reasoning mutation", async () => {
    const probe = deferred<AiStatus>();
    mockAiStatus.mockResolvedValue(openRouterActive());
    mockRefreshSupport.mockReturnValue(probe.promise);
    mockSetReasoning.mockResolvedValue(
      openRouterActive(DEFAULT_MODEL, { reasoning: true }),
    );
    const { user } = setup();

    const toggle = await findChip();
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(1));
    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));

    await act(async () => {
      probe.resolve(
        openRouterActive(DEFAULT_MODEL, {
          reasoning: false,
          reasoningSupported: "unsupported",
        }),
      );
      await probe.promise;
    });

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: /choose ai model.*claude-sonnet-4\.5/i }),
    ).toBeInTheDocument();
  });

  it("surfaces an in-flight same-model support-probe failure after a reasoning mutation", async () => {
    const probe = deferred<AiStatus>();
    mockAiStatus.mockResolvedValue(openRouterActive());
    mockRefreshSupport.mockReturnValue(probe.promise);
    mockSetReasoning.mockResolvedValue(
      openRouterActive(DEFAULT_MODEL, { reasoning: true }),
    );
    const { user } = setup();

    const toggle = await findChip();
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(1));
    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));

    await act(async () => {
      probe.reject({ kind: "llm", message: "same-model probe failed" });
      await probe.promise.catch(() => undefined);
    });

    expect(reportError).toHaveBeenCalledWith("same-model probe failed");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).not.toHaveAttribute("aria-disabled");
  });

  it("does not let a later same-model mutation downgrade a completed support verdict", async () => {
    const probe = deferred<AiStatus>();
    const mutation = deferred<AiStatus>();
    mockAiStatus.mockResolvedValue(openRouterActive());
    mockRefreshSupport.mockReturnValue(probe.promise);
    mockSetReasoning.mockReturnValue(mutation.promise);
    const { user } = setup();

    const toggle = await findChip();
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(1));
    await user.click(toggle);
    await waitFor(() => expect(mockSetReasoning).toHaveBeenCalledExactlyOnceWith(true));

    await act(async () => {
      probe.resolve(
        openRouterActive(DEFAULT_MODEL, { reasoningSupported: "unsupported" }),
      );
      await probe.promise;
    });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-disabled", "true"));

    await act(async () => {
      mutation.resolve(openRouterActive(DEFAULT_MODEL, { reasoning: true }));
      await mutation.promise;
    });

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("aria-disabled", "true");
  });

  it("rejects a completed stale probe after the selected model changes", async () => {
    const staleProbe = deferred<AiStatus>();
    const selectedModel = "acme/new-model";
    mockAiStatus.mockResolvedValue(openRouterActive(DEFAULT_MODEL));
    mockRefreshSupport
      .mockReturnValueOnce(staleProbe.promise)
      .mockResolvedValueOnce(openRouterActive(selectedModel));
    vi.mocked(api.openRouterModelMenu).mockResolvedValue({
      models: [{
        id: selectedModel,
        name: "New model",
        contextLength: 128_000,
        rank: 1,
      }],
      asOf: "2026-07-13",
      selectedModel: DEFAULT_MODEL,
      pinnedSelectedModel: DEFAULT_MODEL,
    });
    vi.mocked(api.selectOpenRouterModel).mockResolvedValue(
      openRouterActive(selectedModel),
    );
    const { user } = setup();

    await findChip();
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /choose ai model/i }));
    await user.click(await screen.findByRole("menuitemradio", { name: /new model/i }));
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(2));

    await act(async () => {
      staleProbe.resolve(
        openRouterActive(DEFAULT_MODEL, { reasoningSupported: "unsupported" }),
      );
      await staleProbe.promise;
    });

    expect(
      screen.getByRole("button", { name: /choose ai model.*new-model/i }),
    ).toBeInTheDocument();
    expect(chip()).not.toHaveAttribute("aria-disabled");
  });

  it("ignores a stale support-probe failure after the selected model changes", async () => {
    const staleProbe = deferred<AiStatus>();
    const selectedModel = "acme/new-model";
    mockAiStatus.mockResolvedValue(openRouterActive(DEFAULT_MODEL));
    mockRefreshSupport
      .mockReturnValueOnce(staleProbe.promise)
      .mockResolvedValueOnce(openRouterActive(selectedModel));
    vi.mocked(api.openRouterModelMenu).mockResolvedValue({
      models: [{
        id: selectedModel,
        name: "New model",
        contextLength: 128_000,
        rank: 1,
      }],
      asOf: "2026-07-13",
      selectedModel: DEFAULT_MODEL,
      pinnedSelectedModel: DEFAULT_MODEL,
    });
    vi.mocked(api.selectOpenRouterModel).mockResolvedValue(
      openRouterActive(selectedModel),
    );
    const { user } = setup();

    await findChip();
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /choose ai model/i }));
    await user.click(await screen.findByRole("menuitemradio", { name: /new model/i }));
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(2));

    await act(async () => {
      staleProbe.reject({ kind: "llm", message: "old model probe failed" });
      await staleProbe.promise.catch(() => undefined);
    });

    expect(reportError).not.toHaveBeenCalledWith("old model probe failed");
    expect(
      screen.getByRole("button", { name: /choose ai model.*new-model/i }),
    ).toBeInTheDocument();
  });

  it("keeps an in-flight support probe owned across a successful same-model refresh", async () => {
    const probe = deferred<AiStatus>();
    const refresh = deferred<AiStatus>();
    mockAiStatus
      .mockResolvedValueOnce(openRouterActive())
      .mockReturnValueOnce(refresh.promise);
    mockRefreshSupport.mockReturnValue(probe.promise);
    const { openNoteAt, onOpenSettings, view } = setup(0);

    const toggle = await findChip();
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(1));
    view.rerender(
      <ChatPane
        openNoteAt={openNoteAt}
        onOpenSettings={onOpenSettings}
        refreshSignal={1}
        expanded={false}
        onToggleExpanded={vi.fn()}
      />,
    );
    await waitFor(() => expect(mockAiStatus).toHaveBeenCalledTimes(2));
    await act(async () => {
      refresh.resolve(openRouterActive());
      await refresh.promise;
    });

    await act(async () => {
      probe.resolve(
        openRouterActive(DEFAULT_MODEL, { reasoningSupported: "unsupported" }),
      );
      await probe.promise;
    });

    await waitFor(() => expect(toggle).toHaveAttribute("aria-disabled", "true"));
  });

  it("keeps an in-flight support probe owned across a failed same-model refresh", async () => {
    const probe = deferred<AiStatus>();
    const refresh = deferred<AiStatus>();
    mockAiStatus
      .mockResolvedValueOnce(openRouterActive())
      .mockReturnValueOnce(refresh.promise);
    mockRefreshSupport.mockReturnValue(probe.promise);
    const { openNoteAt, onOpenSettings, view } = setup(0);

    const toggle = await findChip();
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(1));
    view.rerender(
      <ChatPane
        openNoteAt={openNoteAt}
        onOpenSettings={onOpenSettings}
        refreshSignal={1}
        expanded={false}
        onToggleExpanded={vi.fn()}
      />,
    );
    await waitFor(() => expect(mockAiStatus).toHaveBeenCalledTimes(2));
    await act(async () => {
      refresh.reject({ kind: "io", message: "status refresh failed" });
      await refresh.promise.catch(() => undefined);
    });
    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith("status refresh failed"),
    );

    await act(async () => {
      probe.resolve(
        openRouterActive(DEFAULT_MODEL, { reasoningSupported: "unsupported" }),
      );
      await probe.promise;
    });

    await waitFor(() => expect(toggle).toHaveAttribute("aria-disabled", "true"));
  });

  it("marks the toggle inert and shows the why — visibly — when the probe verified no support", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive("acme/no-thoughts"));
    mockRefreshSupport.mockResolvedValue(
      openRouterActive("acme/no-thoughts", { reasoningSupported: "unsupported" }),
    );
    setup();

    const toggle = await findChip();
    // aria-disabled, NOT native disabled: the explanatory state must stay
    // reachable (see the focusability test below).
    await waitFor(() => expect(toggle).toHaveAttribute("aria-disabled", "true"));
    expect(toggle).not.toBeDisabled();
    // The why names the model and is not hover-only: a plain visible line in
    // the composer strip, doubling as the chip's accessible description.
    expect(
      screen.getByText("acme/no-thoughts can't return reasoning."),
    ).toBeVisible();
    expect(toggle).toHaveAccessibleDescription(
      "acme/no-thoughts can't return reasoning.",
    );
  });

  it("keeps the unsupported toggle focusable, and its click is a guarded no-op", async () => {
    // The regression this pins: native `disabled` made the chip unfocusable,
    // so no keyboard or screen-reader user could ever reach the explanation.
    mockAiStatus.mockResolvedValue(openRouterActive("acme/no-thoughts"));
    mockRefreshSupport.mockResolvedValue(
      openRouterActive("acme/no-thoughts", { reasoningSupported: "unsupported" }),
    );
    const { user } = setup();

    const toggle = await findChip();
    await waitFor(() => expect(toggle).toHaveAttribute("aria-disabled", "true"));

    // Reachable by keyboard — focusing it exposes the described why.
    act(() => toggle.focus());
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAccessibleDescription(
      "acme/no-thoughts can't return reasoning.",
    );

    // Focusable means the DOM won't block activation: the handler must.
    await user.click(toggle);
    await user.keyboard("{Enter}");
    expect(mockSetReasoning).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("fails open when the probe rejects: chip enabled, chat usable, failure surfaced", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    mockRefreshSupport.mockRejectedValue({
      kind: "llm",
      message: "models endpoint unreachable",
    });
    setup();

    const toggle = await findChip();
    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith("models endpoint unreachable"),
    );
    // Never punish the user for our uncertainty: "unknown" keeps the toggle
    // enabled and the chat view is not blocked.
    expect(toggle).toBeEnabled();
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(composer()).toBeEnabled();
  });

  it("re-probes when the selected model changes, not on a same-model refresh", async () => {
    mockAiStatus
      .mockResolvedValueOnce(openRouterActive("acme/one"))
      .mockResolvedValueOnce(openRouterActive("acme/one")) // same model: no new probe
      .mockResolvedValueOnce(openRouterActive("acme/two")); // model changed: re-probe
    const openNoteAt = vi.fn();
    const onOpenSettings = vi.fn();
    const { rerender } = render(
      <ChatPane openNoteAt={openNoteAt} onOpenSettings={onOpenSettings} refreshSignal={0} expanded={false} onToggleExpanded={vi.fn()} />,
    );
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(1));

    rerender(
      <ChatPane openNoteAt={openNoteAt} onOpenSettings={onOpenSettings} refreshSignal={1} expanded={false} onToggleExpanded={vi.fn()} />,
    );
    await waitFor(() => expect(mockAiStatus).toHaveBeenCalledTimes(2));
    expect(mockRefreshSupport).toHaveBeenCalledTimes(1);

    rerender(
      <ChatPane openNoteAt={openNoteAt} onOpenSettings={onOpenSettings} refreshSignal={2} expanded={false} onToggleExpanded={vi.fn()} />,
    );
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(2));
  });

  it("opts in with one set_reasoning call and renders the status the write returned", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    mockSetReasoning.mockResolvedValue(
      openRouterActive(DEFAULT_MODEL, { reasoning: true }),
    );
    const { user } = setup();

    await user.click(await findChip());

    expect(mockSetReasoning).toHaveBeenCalledExactlyOnceWith(true);
    await waitFor(() => expect(chip()).toHaveAttribute("aria-pressed", "true"));
    // Rendered from the write's own echo — never a follow-up aiStatus read
    // whose failure could show "off" while the config bills "on".
    expect(mockAiStatus).toHaveBeenCalledTimes(1);
  });

  it("reads as on for a mandatory model whatever the persisted opt-in says", async () => {
    // Two surfaces, one fact. Settings renders `locked` as "Always on" from the
    // control; the chip used to render the persisted opt-in, so a user who had
    // once opted out saw the composer say reasoning was off on a model that
    // always reasons — the same fact, answered two ways.
    const locked = openRouterActive(DEFAULT_MODEL, {
      reasoning: false,
      reasoningSupported: "supported",
      reasoningControl: { kind: "locked" },
    });
    mockAiStatus.mockResolvedValue(locked);
    mockRefreshSupport.mockResolvedValue(locked);
    const { user } = setup();

    const toggle = await findChip();
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));

    // And it is not a toggle: there is no off position to write, exactly as
    // Settings renders no checkbox for this control.
    await user.click(toggle);
    expect(mockSetReasoning).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("still follows the opt-in on a model that reasons by default but can be told not to", async () => {
    // `default_on` is the MODEL's default, never the user's setting.
    const optional = openRouterActive(DEFAULT_MODEL, {
      reasoning: false,
      reasoningSupported: "supported",
      reasoningControl: { kind: "toggle", defaultOn: true },
    });
    mockAiStatus.mockResolvedValue(optional);
    mockRefreshSupport.mockResolvedValue(optional);
    mockSetReasoning.mockResolvedValue(
      openRouterActive(DEFAULT_MODEL, { reasoning: true }),
    );
    const { user } = setup();

    const toggle = await findChip();
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    expect(mockSetReasoning).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("surfaces a rejected reasoning write inline and stays off", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    mockSetReasoning.mockRejectedValue({
      kind: "io",
      message: "could not write your AI settings",
    });
    const { user } = setup();

    await user.click(await findChip());

    // Never silent: a toggle that quietly failed to persist would misbill.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not write your AI settings",
    );
    expect(chip()).toHaveAttribute("aria-pressed", "false");
  });
});

describe("ChatPane — reasoning backstop notice", () => {
  const BACKSTOP = /Reasoning was on, but the model didn't return any/;

  it("shows the requested-reasoning backstop exactly once when no thinking arrived", async () => {
    await askInChat(
      "q",
      [{ type: "answer", delta: "an answer" }, { type: "done" }],
      openRouterActive(DEFAULT_MODEL, { reasoning: true }),
    );

    expect(screen.getAllByText(BACKSTOP)).toHaveLength(1);
    expect(document.querySelector("details")).toBeNull();
  });

  it("shows no notice when reasoning was off", async () => {
    await askInChat("q", [{ type: "answer", delta: "an answer" }, { type: "done" }]);

    expect(screen.queryByText(BACKSTOP)).not.toBeInTheDocument();
  });

  it("shows no notice when thinking actually arrived", async () => {
    await askInChat(
      "q",
      [
        { type: "thinking", delta: "weighing" },
        { type: "answer", delta: "an answer" },
        { type: "done" },
      ],
      openRouterActive(DEFAULT_MODEL, { reasoning: true }),
    );

    expect(screen.queryByText(BACKSTOP)).not.toBeInTheDocument();
    expect(screen.getByText("Reasoning", { selector: "summary" })).toBeInTheDocument();
  });

  it("shows no notice on an unsupported model, which the app never asked", async () => {
    // Reasoning is persisted on, but the model is verified unsupported, so the
    // backend sends no reasoning by design. Blaming the model for returning none
    // would be a false notice — and the toggle is disabled, so the user couldn't
    // clear the opt-in to silence it. The turn pins the *effective* flag (false).
    await askInChat(
      "q",
      [{ type: "answer", delta: "an answer" }, { type: "done" }],
      openRouterActive("acme/no-thoughts", {
        reasoning: true,
        reasoningSupported: "unsupported",
      }),
    );

    expect(screen.queryByText(BACKSTOP)).not.toBeInTheDocument();
  });

  it("keeps the turn's requested-reasoning backstop when the opt-in changes mid-stream", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive(DEFAULT_MODEL, { reasoning: true }));
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    const gate = deferred<string>();
    let emit!: (ev: ChatEvent) => void;
    mockChat.mockImplementation((_turnId, _p, _h, onEvent) => {
      emit = onEvent;
      return gate.promise; // stays in-flight while the user flips the toggle
    });
    await user.type(composer(), "q");
    await user.click(sendButton());

    // Mid-stream the user opts back OUT — persisted and rendered immediately…
    mockSetReasoning.mockResolvedValue(openRouterActive());
    await user.click(screen.getByRole("button", { name: "Show model reasoning" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show model reasoning" }),
      ).toHaveAttribute("aria-pressed", "false"),
    );

    // The in-flight turn pinned effective reasoning at send time, so its
    // missing-thinking notice remains accurate after the global opt-in changes.
    await act(async () => {
      emit({ type: "answer", delta: "an answer" });
      emit({ type: "done" });
      gate.resolve(TURN_ID);
      await gate.promise;
    });
    expect(screen.getAllByText(BACKSTOP)).toHaveLength(1);
  });
});
