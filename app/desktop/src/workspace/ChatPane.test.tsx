// ChatPane's shell: the provider-aware connection states (first-run picker /
// guided setup / local-needs-a-model hand-off / skipped-disabled / live chat),
// the refreshSignal re-read, and the guided key setup's save -> status -> chat
// handoff. The turn loop lives in `ChatPaneTurn.test.tsx`, the reasoning
// affordances in `ChatPaneReasoning.test.tsx`, and the transcript's scroll
// behaviour in `ChatPaneScroll.browser.test.tsx` (jsdom cannot measure it).
// Shared fixtures and helpers are in `chatPaneTestHarness.tsx`.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus } from "../lib/types";

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
  deferred,
  localActive,
  mockAiStatus,
  mockSave,
  mockSetReasoning,
  openKeySetup,
  openRouterActive,
  resetChatPaneMocks,
  setup,
  unconfigured,
} from "./chatPaneTestHarness";
import { ALWAYS_ASK_APPROVAL_STATUS } from "../lib/approvalStatusFixture";

beforeEach(() => {
  resetChatPaneMocks(reportError);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChatPane — first-run provider branching", () => {
  it("uses the release name for the assistant pane", async () => {
    mockAiStatus.mockResolvedValue(unconfigured());
    setup();

    expect(
      await screen.findByText("Neural Assistant AI"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Cited recall")).not.toBeInTheDocument();
  });

  it("renders the provider picker when nothing is configured", async () => {
    mockAiStatus.mockResolvedValue(unconfigured());
    setup();

    expect(
      await screen.findByRole("button", { name: /connect an openrouter key/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /set up local ai/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skip for now/i })).toBeInTheDocument();
    // No composer, no key form — the fork comes first.
    expect(screen.queryByLabelText("Ask across your vault")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("OpenRouter API key")).not.toBeInTheDocument();
  });

  it("routes 'Set up Local AI' to the settings opener", async () => {
    mockAiStatus.mockResolvedValue(unconfigured());
    const { onOpenSettings, user } = setup();

    await user.click(await screen.findByRole("button", { name: /set up local ai/i }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("skips from the picker straight into the disconnected state", async () => {
    mockAiStatus.mockResolvedValue(unconfigured());
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: /skip for now/i }));
    expect(screen.getByText(/cited chat is off/i)).toBeInTheDocument();
  });

  it("lands in chat with the model tag when the local provider is set up", async () => {
    mockAiStatus.mockResolvedValue(localActive("qwen2.5:7b"));
    setup();

    expect(await screen.findByLabelText("Ask across your vault")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /choose ai model.*qwen2.5:7b/i }),
    ).toBeInTheDocument();
  });

  it("uses the full focus token for the composer instead of a low-contrast tint", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    setup();

    const surface = (await screen.findByLabelText("Ask across your vault")).parentElement;
    expect(surface).toHaveClass("focus-within:ring-2", "focus-within:ring-ring");
    expect(surface).not.toHaveClass("focus-within:ring-primary/40");
  });

  it("hands off to settings when local is selected but no model is set up", async () => {
    mockAiStatus.mockResolvedValue(localActive(null));
    const { onOpenSettings, user } = setup();

    // An honest dead-end, not a chat that would only error.
    expect(await screen.findByText("Local AI needs a model")).toBeInTheDocument();
    expect(screen.queryByLabelText("Ask across your vault")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open ai settings/i }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("falls back to guided setup when openRouter is active without a key", async () => {
    mockAiStatus.mockResolvedValue({
      activeProvider: "openRouter",
      reasoningSupported: "unknown",
      openrouter: { hasKey: false, model: DEFAULT_MODEL, reasoning: false },
      local: { activeModelTag: null },
      approval: ALWAYS_ASK_APPROVAL_STATUS,
    });
    setup();

    expect(await screen.findByLabelText("OpenRouter API key")).toBeInTheDocument();
  });

  it("re-reads the status when refreshSignal bumps (settings closed)", async () => {
    mockAiStatus.mockResolvedValueOnce(unconfigured());
    const openNoteAt = vi.fn();
    const onOpenSettings = vi.fn();
    const { rerender } = render(
      <ChatPane openNoteAt={openNoteAt} onOpenSettings={onOpenSettings} refreshSignal={0} />,
    );
    await screen.findByRole("button", { name: /set up local ai/i });

    // The user configured a local model in Settings; closing it bumps the signal.
    mockAiStatus.mockResolvedValueOnce(localActive("qwen2.5:7b"));
    rerender(
      <ChatPane openNoteAt={openNoteAt} onOpenSettings={onOpenSettings} refreshSignal={1} />,
    );

    expect(await screen.findByLabelText("Ask across your vault")).toBeInTheDocument();
    expect(screen.getByText("qwen2.5:7b")).toBeInTheDocument();
  });

  it("keeps a manually-chosen view when a refresh still reports unconfigured", async () => {
    mockAiStatus.mockResolvedValue(unconfigured());
    const openNoteAt = vi.fn();
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ChatPane openNoteAt={openNoteAt} onOpenSettings={onOpenSettings} refreshSignal={0} />,
    );

    // The user explicitly skipped; peeking at Settings without configuring
    // anything must not bounce them back to the picker.
    await user.click(await screen.findByRole("button", { name: /skip for now/i }));
    rerender(
      <ChatPane openNoteAt={openNoteAt} onOpenSettings={onOpenSettings} refreshSignal={1} />,
    );

    await waitFor(() => expect(mockAiStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/cited chat is off/i)).toBeInTheDocument();
  });

  it("does not let an older status refresh undo a newer reasoning mutation echo", async () => {
    const staleRefresh = deferred<AiStatus>();
    mockAiStatus
      .mockResolvedValueOnce(openRouterActive())
      .mockReturnValueOnce(staleRefresh.promise);
    mockSetReasoning.mockResolvedValue(
      openRouterActive(DEFAULT_MODEL, { reasoning: true }),
    );
    const { openNoteAt, onOpenSettings, user, view } = setup(0);
    const reasoning = await screen.findByRole("button", {
      name: "Show model reasoning",
    });

    view.rerender(
      <ChatPane
        openNoteAt={openNoteAt}
        onOpenSettings={onOpenSettings}
        refreshSignal={1}
      />,
    );
    await waitFor(() => expect(mockAiStatus).toHaveBeenCalledTimes(2));

    await user.click(reasoning);
    await waitFor(() => expect(reasoning).toHaveAttribute("aria-pressed", "true"));

    await act(async () => {
      staleRefresh.resolve(openRouterActive());
      await staleRefresh.promise;
    });

    expect(reasoning).toHaveAttribute("aria-pressed", "true");
  });

  it("does not let an older status refresh undo a newer model-selection echo", async () => {
    const staleRefresh = deferred<AiStatus>();
    const selectedModel = "acme/new-model";
    mockAiStatus
      .mockResolvedValueOnce(openRouterActive())
      .mockReturnValueOnce(staleRefresh.promise);
    vi.mocked(api.openRouterModelMenu).mockResolvedValue({
      models: [
        {
          id: selectedModel,
          name: "New model",
          contextLength: 128_000,
          rank: 1,
        },
      ],
      asOf: "2026-07-13",
      selectedModel: DEFAULT_MODEL,
      pinnedSelectedModel: DEFAULT_MODEL,
    });
    vi.mocked(api.selectOpenRouterModel).mockResolvedValue(
      openRouterActive(selectedModel),
    );
    const { openNoteAt, onOpenSettings, user, view } = setup(0);
    await screen.findByLabelText("Ask across your vault");

    view.rerender(
      <ChatPane
        openNoteAt={openNoteAt}
        onOpenSettings={onOpenSettings}
        refreshSignal={1}
      />,
    );
    await waitFor(() => expect(mockAiStatus).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: /choose ai model/i }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: /new model/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /choose ai model.*new-model/i }),
      ).toBeInTheDocument(),
    );

    await act(async () => {
      staleRefresh.resolve(openRouterActive());
      await staleRefresh.promise;
    });

    expect(
      screen.getByRole("button", { name: /choose ai model.*new-model/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the picker and surfaces the failure if the status check throws", async () => {
    mockAiStatus.mockRejectedValue({ kind: "io", message: "config unreadable" });
    setup();

    expect(
      await screen.findByRole("button", { name: /connect an openrouter key/i }),
    ).toBeInTheDocument();
    expect(reportError).toHaveBeenCalledExactlyOnceWith("config unreadable");
  });
});

describe("ChatPane — key setup", () => {
  it("shows guided setup (not a chat) after picking OpenRouter", async () => {
    mockAiStatus.mockResolvedValue(unconfigured());
    const { user } = setup();
    await openKeySetup(user);

    expect(screen.getByLabelText("OpenRouter API key")).toBeInTheDocument();
    // The model field is prefilled with the status model.
    expect(screen.getByLabelText("Model")).toHaveValue(DEFAULT_MODEL);
    // No composer while setup is showing.
    expect(screen.queryByLabelText("Ask across your vault")).not.toBeInTheDocument();
  });

  it("prefills the setup model solely from the status echo — no frontend default (PA-013)", async () => {
    // A distinctive echoed default proves the id flows from `aiStatus` (the
    // Rust core owns the locked default), never from a frontend constant that
    // could silently disagree after a core bump.
    mockAiStatus.mockResolvedValue({
      activeProvider: null,
      reasoningSupported: "unknown",
      openrouter: { hasKey: false, model: "acme/echoed-default", reasoning: false },
      local: { activeModelTag: null },
      approval: ALWAYS_ASK_APPROVAL_STATUS,
    });
    const { user } = setup();
    await openKeySetup(user);

    expect(screen.getByLabelText("Model")).toHaveValue("acme/echoed-default");
  });

  it("keeps Save disabled until a key is entered", async () => {
    mockAiStatus.mockResolvedValue(unconfigured());
    const { user } = setup();
    await openKeySetup(user);

    const save = screen.getByRole("button", { name: /save & start chatting/i });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-abc");
    expect(save).toBeEnabled();
  });

  it("saves the key, re-checks status, and switches to the chat view", async () => {
    mockAiStatus
      .mockResolvedValueOnce(unconfigured())
      .mockResolvedValueOnce(openRouterActive());
    mockSave.mockResolvedValue(undefined);
    const { user } = setup();
    await openKeySetup(user);

    await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-secret");
    await user.click(screen.getByRole("button", { name: /save & start chatting/i }));

    expect(mockSave).toHaveBeenCalledExactlyOnceWith("sk-or-secret", DEFAULT_MODEL);
    // Re-fetched status → chat view with a live composer.
    expect(await screen.findByLabelText("Ask across your vault")).toBeInTheDocument();
  });

  it("lets the user override the model before saving", async () => {
    mockAiStatus
      .mockResolvedValueOnce(unconfigured())
      .mockResolvedValueOnce(openRouterActive("openai/gpt-4o"));
    mockSave.mockResolvedValue(undefined);
    const { user } = setup();
    await openKeySetup(user);

    await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-x");
    const modelField = screen.getByLabelText("Model");
    await user.clear(modelField);
    await user.type(modelField, "openai/gpt-4o");
    await user.click(screen.getByRole("button", { name: /save & start chatting/i }));

    expect(mockSave).toHaveBeenCalledExactlyOnceWith("sk-or-x", "openai/gpt-4o");
  });

  it("Skip drops to a disabled state whose 'Connect a model' returns to the provider picker (PA-011)", async () => {
    mockAiStatus.mockResolvedValue(unconfigured());
    const { user } = setup();
    await openKeySetup(user);

    await user.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(screen.getByText(/cited chat is off/i)).toBeInTheDocument();
    // Provider-neutral copy: the skipped state must not read single-provider.
    expect(screen.getByText(/an OpenRouter key or Local AI/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Ask across your vault")).not.toBeInTheDocument();

    // The CTA lands on the PICKER (both providers), never the key form alone.
    await user.click(screen.getByRole("button", { name: /connect a model/i }));
    expect(
      screen.getByRole("button", { name: /connect an openrouter key/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set up local ai/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenRouter API key")).not.toBeInTheDocument();
  });

  it("keeps Local AI reachable from the chat pane after a skip (PA-011)", async () => {
    mockAiStatus.mockResolvedValue(unconfigured());
    const { onOpenSettings, user } = setup();

    // Skip straight from the first-run picker — the previously dead-ended path.
    await user.click(await screen.findByRole("button", { name: /skip for now/i }));
    await user.click(screen.getByRole("button", { name: /connect a model/i }));
    await user.click(screen.getByRole("button", { name: /set up local ai/i }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("keeps setup open and surfaces the error when saving the key fails", async () => {
    mockAiStatus.mockResolvedValue(unconfigured());
    mockSave.mockRejectedValue({ kind: "io", message: "keychain write failed" });
    const { user } = setup();
    await openKeySetup(user);

    await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-x");
    await user.click(screen.getByRole("button", { name: /save & start chatting/i }));

    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith("keychain write failed"),
    );
    // Stayed on setup — no chat composer appeared.
    expect(screen.queryByLabelText("Ask across your vault")).not.toBeInTheDocument();
    expect(screen.getByLabelText("OpenRouter API key")).toBeInTheDocument();
  });
});
