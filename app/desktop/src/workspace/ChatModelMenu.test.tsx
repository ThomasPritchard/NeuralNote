import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import type { AiStatus, OpenRouterModelMenu } from "../lib/types";
import { ChatModelMenu } from "./ChatModelMenu";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    openRouterModelMenu: vi.fn(),
    selectOpenRouterModel: vi.fn(),
    openOpenRouterRankings: vi.fn(),
  };
});

const openRouterStatus = (model = "openai/gpt-5"): AiStatus => ({
  activeProvider: "openRouter",
  reasoningSupported: "supported",
  openrouter: { hasKey: true, model, reasoning: false },
  local: { activeModelTag: null },
});

const localStatus: AiStatus = {
  activeProvider: "local",
  reasoningSupported: "unknown",
  openrouter: { hasKey: false, model: "openai/gpt-5", reasoning: false },
  local: { activeModelTag: "qwen3:8b" },
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
const mockOpenRankings = vi.mocked(api.openOpenRouterRankings);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

describe("ChatModelMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMenu.mockResolvedValue(menu);
    mockSelect.mockResolvedValue(openRouterStatus("anthropic/claude-sonnet-4"));
    mockOpenRankings.mockResolvedValue(undefined);
  });

  it("loads the OpenRouter ranking lazily and pins the unranked current model", async () => {
    setup();
    expect(mockMenu).not.toHaveBeenCalled();

    await openMenu();

    expect(await screen.findByRole("menuitemradio", { name: /current.*openai\/gpt-5/i })).toBeChecked();
    expect(
      screen.getByRole("menuitemradio", {
        name: /#1.*claude sonnet 4.*anthropic\/claude-sonnet-4.*200k context/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("anthropic/claude-sonnet-4 · 200k context")).toHaveClass("nn-mono");
    expect(screen.getByRole("button", { name: /choose ai model/i, hidden: true })).toHaveClass("nn-mono");
    expect(
      screen.getByText("Source: OpenRouter (openrouter.ai/rankings), as of 2026-07-13"),
    ).toHaveClass("nn-mono");
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

    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: /anthropic\/claude-sonnet-4/i }),
    );
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledOnce());

    await openMenu();
    expect(
      await screen.findByRole("menuitemradio", { name: /anthropic\/claude-sonnet-4/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitemradio", { name: /current model openai\/gpt-5/i }),
    ).not.toBeInTheDocument();
    expect(mockMenu).toHaveBeenCalledTimes(2);
    expect(mockMenu).toHaveBeenNthCalledWith(2, false);
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

  it("opens the native-owned attribution target", async () => {
    setup();
    await openMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: /source: openrouter/i }));

    expect(mockOpenRankings).toHaveBeenCalledOnce();
  });

  it("surfaces a native attribution failure without closing the menu", async () => {
    mockOpenRankings.mockRejectedValueOnce(new Error("browser unavailable"));
    setup();
    await openMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: /source: openrouter/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("browser unavailable");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("supports keyboard opening, arrow navigation, Escape, and focus return", async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole("button", { name: /choose ai model/i });
    trigger.focus();

    await user.keyboard("{Enter}");
    const current = await screen.findByRole("menuitemradio", { name: /current.*gpt-5/i });
    const ranked = screen.getByRole("menuitemradio", { name: /claude sonnet 4/i });
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
