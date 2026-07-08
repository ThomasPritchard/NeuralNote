// ChatPane: the three connection states (guided setup / skipped-disabled /
// live chat), the save→status→chat handoff, and the streamed ChatEvent loop —
// activity log, streamed answer, cited sources, coverage footer, inline error,
// and the citation click that opens the note at its computed absolute path.
// The `chat` command is mocked to drive the passed `onEvent` callback with a
// scripted event sequence, exactly as the real Rust backend will.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../lib/types";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

// ChatPane needs vault.path (to build citation absolute paths) + reportError.
vi.mock("../lib/store", () => ({
  useVault: () => ({ vault: { name: "V", path: "/vault" }, reportError }),
}));

// Mock the AI commands; keep errorMessage real so surfaced text is honest.
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    apiKeyStatus: vi.fn(),
    saveApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    chat: vi.fn(),
  };
});

import * as api from "../lib/api";
import { ChatPane } from "./ChatPane";

const mockStatus = vi.mocked(api.apiKeyStatus);
const mockSave = vi.mocked(api.saveApiKey);
const mockChat = vi.mocked(api.chat);

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Render the pane with a captured openNoteAt and a fresh user-event session. */
function setup() {
  const openNoteAt = vi.fn();
  const user = userEvent.setup();
  render(<ChatPane openNoteAt={openNoteAt} />);
  return { openNoteAt, user };
}

const composer = () => screen.getByLabelText("Ask across your vault");
const sendButton = () => screen.getByRole("button", { name: "Send" });

/** Script `chat` to replay `events` through the passed onEvent, then resolve. */
function scriptChat(events: ChatEvent[]) {
  mockChat.mockImplementation(async (_prompt, _history, onEvent) => {
    for (const ev of events) onEvent(ev);
  });
}

const CITED_RUN: ChatEvent[] = [
  { type: "searching", query: "active recall" },
  { type: "retrieved", query: "active recall", hitCount: 3 },
  { type: "reading", relPath: "Spaced-Repetition.md", startLine: 12, endLine: 28 },
  { type: "verifying" },
  { type: "answer", delta: "Active recall " },
  { type: "answer", delta: "means testing yourself." },
  {
    type: "citation",
    id: "e1",
    relPath: "Spaced-Repetition.md",
    startLine: 12,
    endLine: 28,
    text: "retrieval practice",
  },
  {
    type: "coverage",
    searchedTerms: ["active recall", "spacing"],
    notesRead: ["Spaced-Repetition.md", "Recall.md"],
    truncated: false,
    skippedFiles: 0,
  },
  { type: "done" },
];

/** Land in the chat view with a stored key, then ask `prompt`. */
async function askInChat(prompt: string, events: ChatEvent[]) {
  mockStatus.mockResolvedValue({ hasKey: true, model: DEFAULT_MODEL });
  const ctx = setup();
  await screen.findByLabelText("Ask across your vault");
  scriptChat(events);
  await ctx.user.type(composer(), prompt);
  await ctx.user.click(sendButton());
  return ctx;
}

beforeEach(() => {
  mockStatus.mockReset();
  mockSave.mockReset();
  mockChat.mockReset();
  reportError.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ChatPane — key setup", () => {
  it("shows guided setup (not a chat) when no key is stored", async () => {
    mockStatus.mockResolvedValue({ hasKey: false, model: DEFAULT_MODEL });
    setup();

    expect(await screen.findByLabelText("OpenRouter API key")).toBeInTheDocument();
    // The model field is prefilled with the status model.
    expect(screen.getByLabelText("Model")).toHaveValue(DEFAULT_MODEL);
    // No composer while setup is showing.
    expect(screen.queryByLabelText("Ask across your vault")).not.toBeInTheDocument();
  });

  it("keeps Save disabled until a key is entered", async () => {
    mockStatus.mockResolvedValue({ hasKey: false, model: DEFAULT_MODEL });
    const { user } = setup();

    const save = await screen.findByRole("button", { name: /save & start chatting/i });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-abc");
    expect(save).toBeEnabled();
  });

  it("saves the key, re-checks status, and switches to the chat view", async () => {
    mockStatus
      .mockResolvedValueOnce({ hasKey: false, model: DEFAULT_MODEL })
      .mockResolvedValueOnce({ hasKey: true, model: DEFAULT_MODEL });
    mockSave.mockResolvedValue(undefined);
    const { user } = setup();

    await user.type(
      await screen.findByLabelText("OpenRouter API key"),
      "sk-or-secret",
    );
    await user.click(screen.getByRole("button", { name: /save & start chatting/i }));

    expect(mockSave).toHaveBeenCalledExactlyOnceWith("sk-or-secret", DEFAULT_MODEL);
    // Re-fetched status → chat view with a live composer.
    expect(await screen.findByLabelText("Ask across your vault")).toBeInTheDocument();
  });

  it("lets the user override the model before saving", async () => {
    mockStatus
      .mockResolvedValueOnce({ hasKey: false, model: DEFAULT_MODEL })
      .mockResolvedValueOnce({ hasKey: true, model: "openai/gpt-4o" });
    mockSave.mockResolvedValue(undefined);
    const { user } = setup();

    await user.type(await screen.findByLabelText("OpenRouter API key"), "sk-or-x");
    const modelField = screen.getByLabelText("Model");
    await user.clear(modelField);
    await user.type(modelField, "openai/gpt-4o");
    await user.click(screen.getByRole("button", { name: /save & start chatting/i }));

    expect(mockSave).toHaveBeenCalledExactlyOnceWith("sk-or-x", "openai/gpt-4o");
  });

  it("Skip drops to a disabled state whose 'Connect a key' reopens setup", async () => {
    mockStatus.mockResolvedValue({ hasKey: false, model: DEFAULT_MODEL });
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: /skip for now/i }));
    expect(screen.getByText(/cited chat is off/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Ask across your vault")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /connect a key/i }));
    expect(screen.getByLabelText("OpenRouter API key")).toBeInTheDocument();
  });

  it("falls back to guided setup and surfaces the failure if the status check throws", async () => {
    mockStatus.mockRejectedValue({ kind: "io", message: "keychain unavailable" });
    setup();

    expect(await screen.findByLabelText("OpenRouter API key")).toBeInTheDocument();
    expect(reportError).toHaveBeenCalledExactlyOnceWith("keychain unavailable");
  });

  it("keeps setup open and surfaces the error when saving the key fails", async () => {
    mockStatus.mockResolvedValue({ hasKey: false, model: DEFAULT_MODEL });
    mockSave.mockRejectedValue({ kind: "io", message: "keychain write failed" });
    const { user } = setup();

    await user.type(await screen.findByLabelText("OpenRouter API key"), "sk-or-x");
    await user.click(screen.getByRole("button", { name: /save & start chatting/i }));

    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith("keychain write failed"),
    );
    // Stayed on setup — no chat composer appeared.
    expect(screen.queryByLabelText("Ask across your vault")).not.toBeInTheDocument();
    expect(screen.getByLabelText("OpenRouter API key")).toBeInTheDocument();
  });
});

describe("ChatPane — chat view", () => {
  it("shows an empty prompt-me state and a disabled Send with no input", async () => {
    mockStatus.mockResolvedValue({ hasKey: true, model: DEFAULT_MODEL });
    setup();

    await screen.findByLabelText("Ask across your vault");
    expect(screen.getByText(/ask anything across your vault/i)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it("collapses a finished cited run to a summary line that expands to the full trace", async () => {
    const { user } = await askInChat("what is active recall?", CITED_RUN);

    // The prompt echoes into the transcript.
    expect(screen.getByText("what is active recall?")).toBeInTheDocument();

    // The finished trace is one collapsed summary line, not a row wall — and it's
    // collapsed by default so the answer sits right under the prompt.
    const summaryLine = screen.getByText(/1 search · 1 note · verified/);
    const disclosure = summaryLine.closest("details");
    expect(disclosure).not.toHaveAttribute("open");

    // The answer and the source chip are unaffected by the collapse.
    expect(
      screen.getByText("Active recall means testing yourself."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Spaced-Repetition\.md:12/ }),
    ).toBeInTheDocument();
    // composer re-enabled once the run is done.
    expect(composer()).toBeEnabled();

    // Expanding audits the full deduped trace: the search (with its hit count),
    // the read (the basename:range stays legible), and the verify step.
    await user.click(disclosure!.querySelector("summary")!);
    expect(disclosure).toHaveAttribute("open");
    const trace = screen.getByRole("list", { name: "Search activity" });
    expect(within(trace).getByText("“active recall”")).toBeInTheDocument();
    expect(within(trace).getByText(/3 notes/)).toBeInTheDocument();
    expect(
      within(trace).getByText(/Spaced-Repetition\.md:12/),
    ).toBeInTheDocument();
    expect(within(trace).getByText("verifying citations")).toBeInTheDocument();
  });

  it("bounds the live window to the freshest steps while streaming, with a running tally", async () => {
    mockStatus.mockResolvedValue({ hasKey: true, model: DEFAULT_MODEL });
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    const gate = deferred<void>();
    // Emit far more steps than the live cap, then stay in-flight (no `done`) so
    // the turn keeps streaming — this is the thorough-run bloat case.
    mockChat.mockImplementation((_p, _h, onEvent) => {
      onEvent({ type: "searching", query: "recall" });
      for (let n = 1; n <= 10; n++) {
        onEvent({
          type: "reading",
          relPath: `Note-${String(n).padStart(2, "0")}.md`,
          startLine: n,
          endLine: n + 3,
        });
      }
      return gate.promise; // never resolves → done stays false
    });

    await user.type(composer(), "deep question");
    await user.click(sendButton());

    // The header verb tracks the current phase (last step is a read), and the
    // running tally counts every step (1 search + 10 reads) — hidden ones too.
    expect(screen.getByText(/Reading notes/)).toBeInTheDocument();
    expect(screen.getByText(/11 steps/)).toBeInTheDocument();

    // Only the freshest few grouped steps are on screen: the newest is shown…
    expect(screen.getByText(/Note-10\.md/)).toBeInTheDocument();
    // …while an early one has rolled off the top (bounded, not a 20-row wall).
    expect(screen.queryByText(/Note-01\.md/)).not.toBeInTheDocument();
    // No aggregate summary while streaming — the collapse only happens once
    // settled, so the "10 notes" summary count is nowhere on screen yet.
    expect(screen.queryByText(/10 notes/)).not.toBeInTheDocument();

    // Settle the run so the deferred doesn't leak into the next test.
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
  });

  it("renders a short finished run (≤2 steps) inline, with no disclosure chevron", async () => {
    await askInChat("what is spacing?", [
      { type: "searching", query: "spacing" },
      { type: "retrieved", query: "spacing", hitCount: 1 },
      { type: "reading", relPath: "Spacing.md", startLine: 1, endLine: 3 },
      { type: "answer", delta: "Spacing is spreading review over time." },
      { type: "done" },
    ]);

    // The two steps show as rows directly — a chevron guarding one or two rows is
    // needless chrome — so there's no summary line and no <details> disclosure.
    expect(screen.getByText("“spacing”")).toBeInTheDocument();
    expect(screen.getByText(/Spacing\.md:1/)).toBeInTheDocument();
    expect(screen.queryByText(/1 search · 1 note/)).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
  });

  it("summarises a run that found nothing as 'N searches · nothing found', trace open", async () => {
    await askInChat("do we have notes on quokkas?", [
      { type: "searching", query: "quokka" },
      { type: "retrieved", query: "quokka", hitCount: 0 },
      { type: "searching", query: "marsupial" },
      { type: "retrieved", query: "marsupial", hitCount: 0 },
      { type: "searching", query: "wallaby" },
      { type: "retrieved", query: "wallaby", hitCount: 0 },
      { type: "answer", delta: "I couldn't find anything on quokkas." },
      { type: "done" },
    ]);

    // No absurd "· verified" when retrieval came up empty — a distinct, honest copy.
    const summaryLine = screen.getByText(/3 searches · nothing found/);
    expect(screen.queryByText(/verified/)).not.toBeInTheDocument();

    // Defaults OPEN so the zero-hit queries — what the user might rephrase — show.
    const disclosure = summaryLine.closest("details");
    expect(disclosure).toHaveAttribute("open");
    const trace = screen.getByRole("list", { name: "Search activity" });
    expect(within(trace).getByText("“quokka”")).toBeInTheDocument();
    // Zero-hit searches stay honest in the trace — "→ 0 notes", never hidden.
    expect(within(trace).getAllByText(/0 notes/)).toHaveLength(3);
  });

  it("passes the prior turn as history on the next question", async () => {
    const { user } = await askInChat("first question", CITED_RUN);
    await waitFor(() => expect(composer()).toBeEnabled());

    scriptChat([{ type: "answer", delta: "follow up" }, { type: "done" }]);
    await user.type(composer(), "second question");
    await user.click(sendButton());

    const lastCall = mockChat.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("second question");
    expect(lastCall?.[1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Active recall means testing yourself." },
    ]);
  });

  it("opens the cited note at its absolute path when a source chip is clicked", async () => {
    const { openNoteAt, user } = await askInChat("q", CITED_RUN);

    await user.click(
      screen.getByRole("button", { name: /Spaced-Repetition\.md:12/ }),
    );
    // absPath = `${vault.path}/${relPath}`.
    expect(openNoteAt).toHaveBeenCalledExactlyOnceWith(
      "/vault/Spaced-Repetition.md",
    );
  });

  it("surfaces an inline, non-fatal error event and re-enables the composer", async () => {
    await askInChat("q", [
      { type: "searching", query: "x" },
      { type: "error", message: "rate limited by OpenRouter" },
    ]);

    expect(screen.getByText("rate limited by OpenRouter")).toBeInTheDocument();
    expect(composer()).toBeEnabled();
  });

  it("surfaces a partial-coverage warning when results were truncated", async () => {
    await askInChat("q", [
      {
        type: "coverage",
        searchedTerms: ["recall"],
        notesRead: ["A.md"],
        truncated: true,
        skippedFiles: 2,
      },
      { type: "done" },
    ]);

    expect(screen.getByText(/partial coverage/i)).toBeInTheDocument();
    expect(screen.getByText(/2 files couldn't be read/i)).toBeInTheDocument();
  });

  it("disables the composer while a run streams, then re-enables it", async () => {
    mockStatus.mockResolvedValue({ hasKey: true, model: DEFAULT_MODEL });
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    const gate = deferred<void>();
    mockChat.mockImplementation((_p, _h, onEvent) => {
      onEvent({ type: "searching", query: "x" });
      return gate.promise; // stays in-flight
    });

    await user.type(composer(), "hold");
    await user.click(sendButton());
    expect(composer()).toBeDisabled();

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(composer()).toBeEnabled();
  });

  it("surfaces a transport rejection as a visible error, never silently", async () => {
    mockStatus.mockResolvedValue({ hasKey: true, model: DEFAULT_MODEL });
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    mockChat.mockRejectedValue({ kind: "llm", message: "network down" });
    await user.type(composer(), "q");
    await user.click(sendButton());

    expect(await screen.findByText("network down")).toBeInTheDocument();
    expect(composer()).toBeEnabled();
  });

  it("sends on Enter, but Shift+Enter inserts a newline instead", async () => {
    mockStatus.mockResolvedValue({ hasKey: true, model: DEFAULT_MODEL });
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");
    scriptChat([{ type: "answer", delta: "hi" }, { type: "done" }]);

    await user.type(composer(), "ask on enter");
    await user.keyboard("{Shift>}{Enter}{/Shift}"); // newline, not a send
    expect(mockChat).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(mockChat).toHaveBeenCalledExactlyOnceWith(
      "ask on enter",
      [],
      expect.any(Function),
    );
  });

  it("surfaces a dropped citation in the summary (glyph + destructive) and defaults the trace open (citation fidelity)", async () => {
    await askInChat("q", [
      { type: "searching", query: "recall" },
      { type: "retrieved", query: "recall", hitCount: 2 },
      { type: "reading", relPath: "Recall.md", startLine: 1, endLine: 5 },
      { type: "verifying" },
      { type: "citationDropped", reason: "quote not found" },
      { type: "answer", delta: "partial answer" },
      { type: "done" },
    ]);

    // The summary surfaces the drop in the destructive tint — never hidden.
    const droppedFrag = screen.getByText(/1 citation dropped/);
    expect(droppedFrag).toHaveClass("text-destructive");

    // A dropped citation defaults the disclosure OPEN — pushing the user into the
    // trace — so the full destructive dropped-citation row is visible for auditing.
    const disclosure = droppedFrag.closest("details");
    expect(disclosure).toHaveAttribute("open");
    expect(
      screen.getByText(/dropped a citation \(quote not found\)/),
    ).toBeInTheDocument();
  });

  it("renders optional reasoning (thinking) deltas", async () => {
    await askInChat("q", [
      { type: "thinking", delta: "weighing the evidence" },
      { type: "answer", delta: "done" },
      { type: "done" },
    ]);

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("weighing the evidence")).toBeInTheDocument();
  });
});
