import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import type { AiStatus, OpenRouterModelMenu } from "../lib/types";
import { ChatModelMenu } from "./ChatModelMenu";
import { ALWAYS_ASK_APPROVAL_STATUS } from "../lib/approvalStatusFixture";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    openRouterModelMenu: vi.fn(),
    selectOpenRouterModel: vi.fn(),
  };
});

const openRouterStatus = (model = "openai/gpt-5"): AiStatus => ({
  activeProvider: "openRouter",
  reasoningSupported: "supported",
  openrouter: { hasKey: true, model, reasoning: false },
  local: { activeModelTag: null },
  approval: ALWAYS_ASK_APPROVAL_STATUS,
});

const localStatus: AiStatus = {
  activeProvider: "local",
  reasoningSupported: "unknown",
  openrouter: { hasKey: false, model: "openai/gpt-5", reasoning: false },
  local: { activeModelTag: "qwen3:8b" },
  approval: ALWAYS_ASK_APPROVAL_STATUS,
};

const menu: OpenRouterModelMenu = {
  asOf: "2026-07-13",
  selectedModel: "openai/gpt-5",
  pinnedSelectedModel: "openai/gpt-5",
  models: [
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", contextLength: 200_000, rank: 1 },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", contextLength: 1_000_000, rank: 3 },
  ],
};

const mockMenu = vi.mocked(api.openRouterModelMenu);
const mockSelect = vi.mocked(api.selectOpenRouterModel);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Two catalogues with disjoint model names, so which one is on screen is
 *  unambiguous no matter which request produced it. */
const staleMenu: OpenRouterModelMenu = {
  asOf: "2026-07-13",
  selectedModel: "openai/gpt-5",
  pinnedSelectedModel: null,
  models: [{ id: "stale/model-one", name: "Stale Model One", contextLength: 128_000, rank: 1 }],
};

const freshMenu: OpenRouterModelMenu = {
  asOf: "2026-07-14",
  selectedModel: "openai/gpt-5",
  pinnedSelectedModel: null,
  models: [{ id: "fresh/model-two", name: "Fresh Model Two", contextLength: 128_000, rank: 1 }],
};

function setup(status: AiStatus = openRouterStatus(), busy = false) {
  const onStatusChange = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <ChatModelMenu
      status={status}
      busy={busy}
      onStatusChange={onStatusChange}
      onOpenSettings={onOpenSettings}
    />,
  );
  return { onStatusChange, onOpenSettings };
}

async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: /choose ai model/i }));
}

async function closeMenu() {
  await userEvent.keyboard("{Escape}");
}

describe("ChatModelMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMenu.mockResolvedValue(menu);
    mockSelect.mockResolvedValue(openRouterStatus("anthropic/claude-sonnet-4"));
  });

  it("loads lazily and renders only model display names with selected state", async () => {
    setup();
    expect(mockMenu).not.toHaveBeenCalled();

    await openMenu();

    const modelMenu = screen.getByRole("menu");
    expect(await within(modelMenu).findByRole("menuitemradio", { name: "gpt-5" })).toBeChecked();
    expect(within(modelMenu).getByRole("menuitemradio", { name: "Claude Sonnet 4" })).toBeInTheDocument();
    expect(within(modelMenu).getByRole("menuitemradio", { name: "Gemini 2.5 Pro" })).toBeInTheDocument();
    expect(within(modelMenu).queryByText("Current")).not.toBeInTheDocument();
    expect(within(modelMenu).queryByText(/#1/)).not.toBeInTheDocument();
    expect(within(modelMenu).queryByText("anthropic/claude-sonnet-4")).not.toBeInTheDocument();
    expect(within(modelMenu).queryByText(/200k context/i)).not.toBeInTheDocument();
    expect(within(modelMenu).queryByText(/source: openrouter/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose ai model/i, hidden: true })).toHaveClass("nn-mono");
    expect(mockMenu).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("announces catalogue loading and readiness from one persistent polite region", async () => {
    const pending = deferred<OpenRouterModelMenu>();
    mockMenu.mockReturnValueOnce(pending.promise);
    setup();

    await openMenu();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading model choices…");

    pending.resolve(menu);
    await waitFor(() => expect(status).toHaveTextContent("Model choices loaded."));
    expect(screen.getByRole("status")).toBe(status);
  });

  it("persists a ranked choice and renders the freshly returned status", async () => {
    const { onStatusChange } = setup();
    await openMenu();

    await userEvent.click(await screen.findByRole("menuitemradio", { name: /claude sonnet 4/i }));

    await waitFor(() => {
      expect(mockSelect).toHaveBeenCalledExactlyOnceWith("anthropic/claude-sonnet-4");
      expect(onStatusChange).toHaveBeenCalledExactlyOnceWith(
        openRouterStatus("anthropic/claude-sonnet-4"),
      );
    });
  });

  it("refreshes on every open and never reuses the previous pinned-current label", async () => {
    const refreshedMenu: OpenRouterModelMenu = {
      ...menu,
      selectedModel: "anthropic/claude-sonnet-4",
      pinnedSelectedModel: null,
    };
    mockMenu.mockResolvedValueOnce(menu).mockResolvedValueOnce(refreshedMenu);
    const { onStatusChange } = setup();
    await openMenu();

    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Claude Sonnet 4" }));
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledOnce());

    await openMenu();
    expect(await screen.findByRole("menuitemradio", { name: "Claude Sonnet 4" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "gpt-5" })).not.toBeInTheDocument();
    expect(mockMenu).toHaveBeenCalledTimes(2);
    expect(mockMenu).toHaveBeenNthCalledWith(2, false);
  });

  // Both cases below hinge on RESOLUTION ORDER, not on the requests themselves:
  // settling the first open before the second passes against unguarded code, so
  // the older request is deliberately settled LAST.
  it("discards an older catalogue response that resolves after a newer one", async () => {
    const firstOpen = deferred<OpenRouterModelMenu>();
    const secondOpen = deferred<OpenRouterModelMenu>();
    mockMenu.mockReturnValueOnce(firstOpen.promise).mockReturnValueOnce(secondOpen.promise);
    setup();

    await openMenu();
    await closeMenu();
    await openMenu();
    expect(mockMenu).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondOpen.resolve(freshMenu);
      await secondOpen.promise;
    });
    expect(await screen.findByRole("menuitemradio", { name: "Fresh Model Two" })).toBeInTheDocument();

    await act(async () => {
      firstOpen.resolve(staleMenu);
      await firstOpen.promise;
    });

    expect(screen.getByRole("menuitemradio", { name: "Fresh Model Two" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "Stale Model One" })).not.toBeInTheDocument();
  });

  it("discards an older catalogue rejection that arrives after a newer response", async () => {
    const firstOpen = deferred<OpenRouterModelMenu>();
    const secondOpen = deferred<OpenRouterModelMenu>();
    mockMenu.mockReturnValueOnce(firstOpen.promise).mockReturnValueOnce(secondOpen.promise);
    setup();

    await openMenu();
    await closeMenu();
    await openMenu();
    expect(mockMenu).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondOpen.resolve(freshMenu);
      await secondOpen.promise;
    });
    expect(await screen.findByRole("menuitemradio", { name: "Fresh Model Two" })).toBeInTheDocument();

    await act(async () => {
      firstOpen.reject(new Error("stale catalogue failure"));
      await firstOpen.promise.catch(() => undefined);
    });

    expect(screen.getByRole("menuitemradio", { name: "Fresh Model Two" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the current model and offers an explicit force-refresh retry", async () => {
    mockMenu.mockRejectedValueOnce(new Error("catalogue unavailable"));
    setup();
    await openMenu();

    expect(await screen.findByRole("alert")).toHaveTextContent("catalogue unavailable");
    await userEvent.click(screen.getByRole("menuitem", { name: "Retry" }));

    await waitFor(() => expect(mockMenu).toHaveBeenLastCalledWith(true));
    expect(await screen.findByRole("menuitemradio", { name: /claude sonnet 4/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /choose ai model.*gpt-5/i,
        hidden: true,
      }),
    ).toBeInTheDocument();
  });

  it("supports keyboard opening, arrow navigation, Escape, and focus return", async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole("button", { name: /choose ai model/i });
    trigger.focus();

    await user.keyboard("{Enter}");
    const current = await screen.findByRole("menuitemradio", { name: "gpt-5" });
    const ranked = screen.getByRole("menuitemradio", { name: "Claude Sonnet 4" });
    await user.keyboard("{ArrowDown}");
    expect([current, ranked]).toContain(document.activeElement);

    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("routes local users to settings without fetching OpenRouter", async () => {
    const { onOpenSettings } = setup(localStatus);
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Manage local models" }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(mockMenu).not.toHaveBeenCalled();
  });

  it("disables model changes while a response is active", () => {
    setup(openRouterStatus(), true);

    expect(screen.getByRole("button", { name: /choose ai model/i })).toBeDisabled();
  });
});
