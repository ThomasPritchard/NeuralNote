// ChatPane: the provider-aware connection states (first-run picker / guided
// setup / local-needs-a-model hand-off / skipped-disabled / live chat), the
// save→status→chat handoff, and the streamed ChatEvent loop — activity log,
// streamed answer, cited sources, coverage footer, inline error, and the
// citation click that opens the note at its computed absolute path. The `chat`
// command is mocked to drive the passed `onEvent` callback with a scripted
// event sequence, exactly as the real Rust backend will.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus, ChatEvent, ReasoningSupport } from "../lib/types";

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
    aiStatus: vi.fn(),
    saveApiKey: vi.fn(),
    chat: vi.fn(),
    setReasoning: vi.fn(),
    refreshReasoningSupport: vi.fn(),
  };
});

import * as api from "../lib/api";
import { ChatPane } from "./ChatPane";

const mockAiStatus = vi.mocked(api.aiStatus);
const mockSave = vi.mocked(api.saveApiKey);
const mockChat = vi.mocked(api.chat);
const mockSetReasoning = vi.mocked(api.setReasoning);
const mockRefreshSupport = vi.mocked(api.refreshReasoningSupport);

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

// ── AiStatus builders (the three effective-provider shapes the pane branches on) ──
// `reasoningSupported` defaults to "unknown": no model has been probed, and
// "unknown" is the fail-open verdict that leaves the reasoning toggle enabled.
const unconfigured = (): AiStatus => ({
  activeProvider: null,
  reasoningSupported: "unknown",
  openrouter: { hasKey: false, model: DEFAULT_MODEL, reasoning: false },
  local: { activeModelTag: null },
});
const openRouterActive = (
  model = DEFAULT_MODEL,
  opts: { reasoning?: boolean; reasoningSupported?: ReasoningSupport } = {},
): AiStatus => ({
  activeProvider: "openRouter",
  reasoningSupported: opts.reasoningSupported ?? "unknown",
  openrouter: { hasKey: true, model, reasoning: opts.reasoning ?? false },
  local: { activeModelTag: null },
});
const localActive = (tag: string | null): AiStatus => ({
  activeProvider: "local",
  reasoningSupported: "unknown",
  openrouter: { hasKey: false, model: DEFAULT_MODEL, reasoning: false },
  local: { activeModelTag: tag },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Render the pane with captured callbacks and a fresh user-event session. */
function setup(refreshSignal = 0) {
  const openNoteAt = vi.fn();
  const onOpenSettings = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <ChatPane
      openNoteAt={openNoteAt}
      onOpenSettings={onOpenSettings}
      refreshSignal={refreshSignal}
    />,
  );
  return { openNoteAt, onOpenSettings, user, view };
}

const composer = () => screen.getByLabelText("Ask across your vault");
const sendButton = () => screen.getByRole("button", { name: "Send" });

/** Walk the first-run picker into the guided OpenRouter key setup. */
async function openKeySetup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: /connect an openrouter key/i }),
  );
}

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

/** Land in the chat view with an active OpenRouter setup, then ask `prompt`. */
async function askInChat(
  prompt: string,
  events: ChatEvent[],
  status: AiStatus = openRouterActive(),
) {
  mockAiStatus.mockResolvedValue(status);
  const ctx = setup();
  await screen.findByLabelText("Ask across your vault");
  scriptChat(events);
  await ctx.user.type(composer(), prompt);
  await ctx.user.click(sendButton());
  return ctx;
}

beforeEach(() => {
  mockAiStatus.mockReset();
  mockSave.mockReset();
  mockChat.mockReset();
  mockSetReasoning.mockReset();
  mockRefreshSupport.mockReset();
  reportError.mockReset();
  // The capability probe is network I/O with its own tests below; by default it
  // stays in-flight so every other test renders pure mount-status state.
  mockRefreshSupport.mockImplementation(() => new Promise<AiStatus>(() => {}));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ChatPane — first-run provider branching", () => {
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
    // The header status pill carries the local tag instead of a cloud model id.
    expect(screen.getByText("qwen2.5:7b")).toBeInTheDocument();
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

describe("ChatPane — chat view", () => {
  it("shows an empty prompt-me state and a disabled Send with no input", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    setup();

    await screen.findByLabelText("Ask across your vault");
    expect(screen.getByText(/ask anything across your vault/i)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it("labels the header status pill with the echoed OpenRouter model (PA-013)", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive("acme/echoed-default"));
    setup();

    await screen.findByLabelText("Ask across your vault");
    // The pill shows the id's tail segment, straight from the status echo.
    expect(screen.getByText("echoed-default")).toBeInTheDocument();
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
    mockAiStatus.mockResolvedValue(openRouterActive());
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
    mockAiStatus.mockResolvedValue(openRouterActive());
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
    mockAiStatus.mockResolvedValue(openRouterActive());
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    mockChat.mockRejectedValue({ kind: "llm", message: "network down" });
    await user.type(composer(), "q");
    await user.click(sendButton());

    expect(await screen.findByText("network down")).toBeInTheDocument();
    expect(composer()).toBeEnabled();
  });

  it("sends on Enter, but Shift+Enter inserts a newline instead", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
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

    expect(screen.getByText("Reasoning", { selector: "summary" })).toBeInTheDocument();
    expect(screen.getByText("weighing the evidence")).toBeInTheDocument();
  });
});

describe("ChatPane — composer reasoning toggle", () => {
  const chip = () => screen.getByRole("button", { name: "Show model reasoning" });
  const findChip = () => screen.findByRole("button", { name: "Show model reasoning" });

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
      <ChatPane openNoteAt={openNoteAt} onOpenSettings={onOpenSettings} refreshSignal={0} />,
    );
    await waitFor(() => expect(mockRefreshSupport).toHaveBeenCalledTimes(1));

    rerender(
      <ChatPane openNoteAt={openNoteAt} onOpenSettings={onOpenSettings} refreshSignal={1} />,
    );
    await waitFor(() => expect(mockAiStatus).toHaveBeenCalledTimes(2));
    expect(mockRefreshSupport).toHaveBeenCalledTimes(1);

    rerender(
      <ChatPane openNoteAt={openNoteAt} onOpenSettings={onOpenSettings} refreshSignal={2} />,
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

  it("shows one quiet notice when reasoning was on but no thinking arrived", async () => {
    await askInChat(
      "q",
      [{ type: "answer", delta: "an answer" }, { type: "done" }],
      openRouterActive(DEFAULT_MODEL, { reasoning: true }),
    );

    expect(screen.getByText(BACKSTOP)).toBeInTheDocument();
    // It fills the slot the Reasoning disclosure would have taken — never both.
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

  it("judges the turn against the opt-in it started under, not a mid-stream flip", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive(DEFAULT_MODEL, { reasoning: true }));
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    const gate = deferred<void>();
    let emit!: (ev: ChatEvent) => void;
    mockChat.mockImplementation((_p, _h, onEvent) => {
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

    // …but the in-flight turn finishes with zero thinking and is judged against
    // the opt-in pinned at its start: the notice still explains the absence.
    await act(async () => {
      emit({ type: "answer", delta: "an answer" });
      emit({ type: "done" });
      gate.resolve();
      await gate.promise;
    });
    expect(screen.getByText(BACKSTOP)).toBeInTheDocument();
  });
});

describe("ChatPane — the nothing-found card", () => {
  const CARD_TITLE = "Nothing in your vault covers this";

  it("lists the searched terms when the turn searched and nothing survived", async () => {
    await askInChat("anything on quokkas?", [
      { type: "searching", query: "quokka" },
      { type: "retrieved", query: "quokka", hitCount: 0 },
      { type: "answer", delta: "Your notes don't mention quokkas." },
      {
        type: "coverage",
        searchedTerms: ["quokka", "marsupial"],
        notesRead: [],
        truncated: false,
        skippedFiles: 0,
      },
      { type: "done" },
    ]);

    const title = screen.getByText(CARD_TITLE);
    const terms = screen.getByRole("list", { name: "Searched terms" });
    expect(within(terms).getByText("quokka")).toBeInTheDocument();
    expect(within(terms).getByText("marsupial")).toBeInTheDocument();
    // Honest guidance only — and NO capture CTA of any kind: nothing that
    // could promise distillation/ingestion before Slice 5 makes it true.
    expect(screen.getByText(/research this and add a note/i)).toBeInTheDocument();
    expect(within(title.closest("div")!).queryAllByRole("button")).toHaveLength(0);
  });

  it("shows no card when a citation survived", async () => {
    await askInChat("q", CITED_RUN);

    expect(screen.queryByText(CARD_TITLE)).not.toBeInTheDocument();
  });

  it("shows no card when the run errored — the error box speaks alone", async () => {
    await askInChat("q", [
      { type: "searching", query: "x" },
      {
        type: "coverage",
        searchedTerms: ["x"],
        notesRead: [],
        truncated: false,
        skippedFiles: 0,
      },
      { type: "error", message: "rate limited" },
    ]);

    expect(screen.getByText("rate limited")).toBeInTheDocument();
    expect(screen.queryByText(CARD_TITLE)).not.toBeInTheDocument();
  });
});
