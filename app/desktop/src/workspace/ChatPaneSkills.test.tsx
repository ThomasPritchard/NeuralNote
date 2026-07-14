// ChatPane — the composer's skill affordances: the `@` picker (wikilink-
// autocomplete pattern: popup, keyboard nav, combobox aria) fed by the async
// `listSkills` catalogue (loading/error surfaced quietly in the popup, only
// enabled skills offered), the removable chip row, and the send path that
// feeds both into `chat`'s `activeSkills` (with the resolved run id landing
// on the turn's report card).

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus, ChatEvent, SkillListing } from "../lib/types";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock("../lib/store", () => ({
  useVault: () => ({ vault: { name: "V", path: "/vault" }, reportError }),
}));

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    aiStatus: vi.fn(),
    chat: vi.fn(),
    refreshReasoningSupport: vi.fn(),
    undoSkillRun: vi.fn(),
    listSkills: vi.fn(),
  };
});

import * as api from "../lib/api";
import { ChatPane } from "./ChatPane";

const mockAiStatus = vi.mocked(api.aiStatus);
const mockChat = vi.mocked(api.chat);
const mockRefreshSupport = vi.mocked(api.refreshReasoningSupport);
const mockListSkills = vi.mocked(api.listSkills);

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

const openRouterActive = (): AiStatus => ({
  activeProvider: "openRouter",
  reasoningSupported: "unknown",
  openrouter: { hasKey: true, model: DEFAULT_MODEL, reasoning: false },
  local: { activeModelTag: null },
});

/** The backend catalogue a test seeds — the fixture skill as `list_skills`
 *  reports it, plus whatever the test adds. */
const skillListing = (over: Partial<SkillListing> = {}): SkillListing => ({
  id: "fixture-note-workflow",
  name: "Fixture note workflow",
  description: "Demonstrate progress, elicitation, and a guarded note write.",
  icon: "flask",
  enabled: true,
  requirements: [],
  ...over,
});

function setup() {
  const user = userEvent.setup();
  render(
    <ChatPane openNoteAt={vi.fn()} onOpenSettings={vi.fn()} refreshSignal={0} />,
  );
  return { user };
}

const composer = () => screen.getByLabelText("Ask across your vault");
const picker = () => screen.queryByRole("listbox", { name: "Skill suggestions" });

beforeEach(() => {
  mockAiStatus.mockReset();
  mockChat.mockReset();
  mockRefreshSupport.mockReset();
  mockListSkills.mockReset();
  reportError.mockReset();
  mockAiStatus.mockResolvedValue(openRouterActive());
  // Keep the capability probe in-flight so every test renders mount state.
  mockRefreshSupport.mockImplementation(() => new Promise<AiStatus>(() => {}));
  mockChat.mockResolvedValue("run-1");
  mockListSkills.mockResolvedValue([skillListing()]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ChatPane — @ skill picker", () => {
  it("opens on @, listing the built-in skill with its description", async () => {
    const { user } = setup();
    await user.type(await screen.findByLabelText("Ask across your vault"), "@");

    const listbox = picker();
    expect(listbox).toBeInTheDocument();
    expect(within(listbox!).getByText("Fixture note workflow")).toBeInTheDocument();
    expect(
      within(listbox!).getByText("Demonstrate progress, elicitation, and a guarded note write."),
    ).toBeInTheDocument();
    // Combobox aria: the textarea drives the popup via activedescendant.
    expect(composer()).toHaveAttribute("aria-controls", "nn-skill-listbox");
    expect(composer()).toHaveAttribute("aria-activedescendant", "nn-skill-option-0");
  });

  it("stays closed for a mid-word @ (email addresses are prose, not triggers)", async () => {
    const { user } = setup();
    await user.type(await screen.findByLabelText("Ask across your vault"), "mail tom@ex");
    expect(picker()).not.toBeInTheDocument();
  });

  it("stays closed when the query matches nothing", async () => {
    const { user } = setup();
    await user.type(await screen.findByLabelText("Ask across your vault"), "@zzz");
    expect(picker()).not.toBeInTheDocument();
  });

  it("Enter picks: chip added, trigger text removed, popup closed — and no send fires", async () => {
    const { user } = setup();
    const box = await screen.findByLabelText("Ask across your vault");
    await user.type(box, "distil this @fix");
    await user.keyboard("{Enter}");

    const chips = screen.getByRole("list", { name: "Active skills" });
    expect(within(chips).getByText("Fixture note workflow")).toBeInTheDocument();
    expect(box).toHaveValue("distil this ");
    expect(picker()).not.toBeInTheDocument();
    expect(mockChat).not.toHaveBeenCalled(); // Enter picked, it did not send
  });

  it("clicking a suggestion row picks it too", async () => {
    const { user } = setup();
    await user.type(await screen.findByLabelText("Ask across your vault"), "@");
    await user.click(screen.getByRole("option", { name: /Fixture note workflow/ }));
    expect(
      within(screen.getByRole("list", { name: "Active skills" })).getByText(
        "Fixture note workflow",
      ),
    ).toBeInTheDocument();
  });

  it("Escape dismisses the popup for this trigger; further typing reopens it", async () => {
    const { user } = setup();
    const box = await screen.findByLabelText("Ask across your vault");
    await user.type(box, "@");
    expect(picker()).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(picker()).not.toBeInTheDocument();

    await user.type(box, "f");
    expect(picker()).toBeInTheDocument();
  });

  it("excludes an already-picked skill, and removing its chip restores it", async () => {
    const { user } = setup();
    const box = await screen.findByLabelText("Ask across your vault");
    await user.type(box, "@");
    await user.keyboard("{Enter}"); // pick the only skill

    await user.type(box, "@");
    expect(picker()).not.toBeInTheDocument(); // nothing left to suggest

    await user.click(screen.getByRole("button", { name: "Remove skill: Fixture note workflow" }));
    expect(screen.queryByRole("list", { name: "Active skills" })).not.toBeInTheDocument();

    // The dismissal keyed the old trigger; a fresh keystroke re-derives it.
    await user.type(box, "{Backspace}@");
    expect(picker()).toBeInTheDocument();
  });
});

describe("ChatPane — async skill catalogue", () => {
  it("shows a quiet loading line (no listbox) while the catalogue loads", async () => {
    mockListSkills.mockImplementation(() => new Promise<SkillListing[]>(() => {}));
    const { user } = setup();
    await user.type(await screen.findByLabelText("Ask across your vault"), "@");

    expect(screen.getByText("Loading skills…")).toBeInTheDocument();
    expect(picker()).not.toBeInTheDocument(); // a status line is not a listbox
    // The combobox wiring stays off until real options exist.
    expect(composer()).not.toHaveAttribute("aria-controls");
    expect(composer()).not.toHaveAttribute("aria-activedescendant");
  });

  it("surfaces a failed catalogue load quietly in the popup — never silent", async () => {
    mockListSkills.mockRejectedValue({ kind: "io", message: "registry exploded" });
    const { user } = setup();
    await user.type(await screen.findByLabelText("Ask across your vault"), "@");

    expect(
      screen.getByText("Couldn't load skills: registry exploded"),
    ).toBeInTheDocument();
    expect(picker()).not.toBeInTheDocument();

    // Escape still dismisses the notice popup for this trigger.
    await user.keyboard("{Escape}");
    expect(
      screen.queryByText("Couldn't load skills: registry exploded"),
    ).not.toBeInTheDocument();
  });

  it("keeps the stale catalogue when a REFRESH fails, surfacing the failure on the shared channel", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ChatPane openNoteAt={vi.fn()} onOpenSettings={vi.fn()} refreshSignal={0} />,
    );
    const box = await screen.findByLabelText("Ask across your vault");

    // The first load lands: the picker offers the skill.
    await user.type(box, "@");
    expect(
      await screen.findByRole("option", { name: /Fixture note workflow/ }),
    ).toBeInTheDocument();
    // Close by removing the trigger (no dismissal key left behind).
    await user.type(box, "{Backspace}");

    // Settings closes → the signal bumps → the catalogue re-read fails.
    mockListSkills.mockRejectedValueOnce({ kind: "io", message: "registry exploded" });
    rerender(
      <ChatPane openNoteAt={vi.fn()} onOpenSettings={vi.fn()} refreshSignal={1} />,
    );
    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith("registry exploded"),
    );

    // Stale beats blank: the last good catalogue still drives the picker,
    // with no error line in the popup.
    await user.type(box, "@");
    expect(
      screen.getByRole("option", { name: /Fixture note workflow/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load skills/)).not.toBeInTheDocument();
  });

  it("offers only enabled skills — a disabled one never reaches the popup", async () => {
    mockListSkills.mockResolvedValue([
      skillListing(),
      skillListing({
        id: "youtube-distil",
        name: "YouTube distil",
        description: "Distil a video into notes.",
        enabled: false,
      }),
    ]);
    const { user } = setup();
    await user.type(await screen.findByLabelText("Ask across your vault"), "@");

    const listbox = picker();
    expect(within(listbox!).getByText("Fixture note workflow")).toBeInTheDocument();
    expect(within(listbox!).queryByText("YouTube distil")).not.toBeInTheDocument();
  });
});

describe("ChatPane — skills on send", () => {
  it("feeds the chips into chat's activeSkills and keeps them across sends", async () => {
    const { user } = setup();
    const box = await screen.findByLabelText("Ask across your vault");
    await user.type(box, "@");
    await user.keyboard("{Enter}");

    await user.type(box, "distil my note");
    await user.keyboard("{Enter}");

    expect(mockChat).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      "distil my note",
      [],
      expect.any(Function),
      ["fixture-note-workflow"],
    );
    // Chips persist: an activated skill is a mode, not a one-message attachment.
    expect(
      within(screen.getByRole("list", { name: "Active skills" })).getByText(
        "Fixture note workflow",
      ),
    ).toBeInTheDocument();
  });

  it("lands the resolved run id on the turn's report card (Undo becomes available)", async () => {
    const events: ChatEvent[] = [
      { type: "skillActivated", id: "fixture-note-workflow", name: "Fixture note workflow" },
      { type: "noteWritten", relPath: "Literature/Talk.md", kind: "literature" },
      { type: "done" },
    ];
    mockChat.mockImplementation(async (turnId, _prompt, _history, onEvent) => {
      for (const ev of events) onEvent(ev);
      return turnId;
    });
    const { user } = setup();
    const box = await screen.findByLabelText("Ask across your vault");
    await user.type(box, "run the fixture");
    await user.keyboard("{Enter}");

    expect(await screen.findByText("1 note written")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Undo" })).toBeEnabled();
  });
});
