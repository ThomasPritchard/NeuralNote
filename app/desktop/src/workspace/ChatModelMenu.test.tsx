import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  fireEvent.pointerDown(screen.getByRole("button", { name: /choose ai model/i }), {
    button: 0,
    ctrlKey: false,
  });
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
    expect(screen.getByRole("menuitemradio", { name: /#1.*claude sonnet 4/i })).toBeInTheDocument();
    expect(screen.getByText("Ranked 13 July 2026")).toBeInTheDocument();
    expect(mockMenu).toHaveBeenCalledExactlyOnceWith(false);
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

    await userEvent.click(await screen.findByRole("menuitem", { name: /openrouter rankings/i }));

    expect(mockOpenRankings).toHaveBeenCalledOnce();
  });

  it("surfaces a native attribution failure without closing the menu", async () => {
    mockOpenRankings.mockRejectedValueOnce(new Error("browser unavailable"));
    setup();
    await openMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: /openrouter rankings/i }));

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
