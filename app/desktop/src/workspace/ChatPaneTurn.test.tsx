// ChatPane's turn loop: the streamed ChatEvent fold — activity log, streamed
// answer, cited sources and the click that opens a note at its computed
// absolute path, coverage footer, inline error, stop/cancel, and the
// nothing-found card. The `chat` command is mocked to drive the passed `onEvent`
// with a scripted event sequence, exactly as the real Rust backend will.
//
// Split out of `ChatPane.test.tsx`; shared fixtures live in
// `chatPaneTestHarness.tsx`. The transcript's SCROLL behaviour is not testable
// here — jsdom has no layout engine — and lives in
// `ChatPaneScroll.browser.test.tsx`.

import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../lib/types";

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

import {
  CITED_RUN,
  SECOND_TURN_ID,
  TURN_ID,
  askInChat,
  composer,
  deferred,
  mockAiStatus,
  mockCancelChat,
  mockChat,
  openRouterActive,
  resetChatPaneMocks,
  scriptChat,
  sendButton,
  setup,
} from "./chatPaneTestHarness";

beforeEach(() => {
  resetChatPaneMocks(reportError);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChatPane — chat view", () => {
  it("renders the transcript as a labelled, keyboard-reachable region", async () => {
    // The wiring only. Whether the region actually FOLLOWS the answer is
    // geometry, and jsdom has no layout engine — that is proven in
    // ChatPaneScroll.browser.test.tsx, and cannot be proven here.
    mockAiStatus.mockResolvedValue(openRouterActive());
    setup();

    const transcript = await screen.findByRole("region", { name: "Conversation" });
    expect(transcript).toHaveAttribute("tabindex", "0");
    // Released-only affordance: nothing has scrolled, so nothing is offered.
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("shows an empty prompt-me state and a disabled Send with no input", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    setup();

    await screen.findByLabelText("Ask across your vault");
    expect(screen.getByText(/ask anything across your vault/i)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it("moves keyboard focus from the composer to Stop and restores it after completion", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    const run = deferred<string>();
    mockChat.mockReturnValue(run.promise);
    const { user } = setup();
    const input = await screen.findByLabelText("Ask across your vault");

    await user.type(input, "question from the keyboard");
    expect(input).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("button", { name: "Stop response" })).toHaveFocus();

    await act(async () => {
      run.resolve(TURN_ID);
      await run.promise;
    });
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toBeEnabled();
  });

  it("restores composer focus after a keyboard-stopped run unwinds", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    const run = deferred<string>();
    mockChat.mockReturnValue(run.promise);
    const { user } = setup();
    const input = await screen.findByLabelText("Ask across your vault");

    await user.type(input, "stop this response");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Stop response" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    await act(async () => {
      run.resolve(TURN_ID);
      await run.promise;
    });

    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toBeEnabled();
  });

  it("stops the exact UUID, preserves partial output, and stays busy until chat unwinds", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    const run = deferred<string>();
    const stop = deferred<{ turnId: string; status: "cancelled" }>();
    mockChat.mockImplementation((_turnId, _prompt, _history, onEvent) => {
      onEvent({ type: "answer", delta: "Partial answer remains." });
      return run.promise;
    });
    mockCancelChat.mockReturnValue(stop.promise);
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    await user.type(composer(), "distil the playlist");
    await user.click(sendButton());

    const stopButton = await screen.findByRole("button", { name: "Stop response" });
    await user.click(stopButton);
    expect(mockCancelChat).toHaveBeenCalledExactlyOnceWith(TURN_ID);
    expect(screen.getByRole("button", { name: "Stopping" })).toBeDisabled();

    stop.resolve({ turnId: TURN_ID, status: "cancelled" });
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("Response stopped.", { selector: '[aria-live="polite"]' })).toBeInTheDocument();
    expect(screen.getByText("Partial answer remains.")).toBeInTheDocument();
    expect(composer()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stopping" })).toBeDisabled();

    run.resolve(TURN_ID);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeDisabled());
  });

  it("keeps a queued committed-note ledger after stop without reviving terminal chat events", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    const run = deferred<string>();
    let emit!: (event: ChatEvent) => void;
    mockChat.mockImplementation((_turnId, _prompt, _history, onEvent) => {
      emit = onEvent;
      onEvent({ type: "skillActivated", id: "youtube-distil", name: "YouTube distil" });
      return run.promise;
    });
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    await user.type(composer(), "distil the playlist");
    await user.click(sendButton());
    await user.click(await screen.findByRole("button", { name: "Stop response" }));
    expect(await screen.findByText("Stopped")).toBeInTheDocument();

    act(() => {
      emit({ type: "noteWritten", relPath: "Literature/Committed.md", kind: "literature" });
      emit({ type: "answer", delta: "late answer must stay hidden" });
      emit({ type: "error", message: "late cancellation error must stay hidden" });
      emit({ type: "done" });
    });
    await act(async () => {
      run.resolve(TURN_ID);
      await run.promise;
    });

    expect(screen.getByText("1 note written")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Literature/Committed.md" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText("late answer must stay hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("late cancellation error must stay hidden")).not.toBeInTheDocument();
  });

  it("shows the exact stop failure inline and allows a retry", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    const run = deferred<string>();
    mockChat.mockReturnValue(run.promise);
    mockCancelChat.mockRejectedValueOnce({ kind: "io", message: "cancel channel failed" });
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    await user.type(composer(), "distil the playlist");
    await user.click(sendButton());
    await user.click(await screen.findByRole("button", { name: "Stop response" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't stop the response",
    );
    const retry = screen.getByRole("button", { name: "Stop response" });
    expect(retry).toBeEnabled();
    await user.click(retry);
    expect(mockCancelChat).toHaveBeenCalledTimes(2);
    run.resolve(TURN_ID);
  });

  it("does not relabel a turn when native completion already won", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive());
    const run = deferred<string>();
    mockChat.mockReturnValue(run.promise);
    mockCancelChat.mockResolvedValue({ turnId: TURN_ID, status: "alreadyCompleted" });
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    await user.type(composer(), "quick question");
    await user.click(sendButton());
    await user.click(screen.getByRole("button", { name: "Stop response" }));

    await waitFor(() => expect(mockCancelChat).toHaveBeenCalledWith(TURN_ID));
    expect(screen.queryByText("Stopped")).not.toBeInTheDocument();
    run.resolve(TURN_ID);
  });

  it("ignores a delayed stop outcome for an older UUID after a new turn starts", async () => {
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReturnValueOnce(TURN_ID)
      .mockReturnValueOnce(SECOND_TURN_ID);
    mockAiStatus.mockResolvedValue(openRouterActive());
    const firstRun = deferred<string>();
    const secondRun = deferred<string>();
    const oldStop = deferred<{ turnId: string; status: "cancelled" }>();
    let finishFirst!: (event: ChatEvent) => void;
    mockChat
      .mockImplementationOnce((_turnId, _prompt, _history, onEvent) => {
        finishFirst = onEvent;
        return firstRun.promise;
      })
      .mockImplementationOnce(() => secondRun.promise);
    mockCancelChat.mockReturnValue(oldStop.promise);
    const { user } = setup();
    await screen.findByLabelText("Ask across your vault");

    await user.type(composer(), "first");
    await user.click(sendButton());
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    act(() => finishFirst({ type: "done" }));
    firstRun.resolve(TURN_ID);
    await waitFor(() => expect(composer()).toBeEnabled());

    await user.type(composer(), "second");
    await user.click(sendButton());
    expect(mockChat.mock.calls.at(-1)?.[0]).toBe(SECOND_TURN_ID);
    oldStop.resolve({ turnId: TURN_ID, status: "cancelled" });

    await waitFor(() => {
      expect(screen.queryByText("Stopped")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Stop response" })).toBeEnabled();
    });
    secondRun.resolve(SECOND_TURN_ID);
  });

  it("places the echoed OpenRouter model in the composer and removes the header pill", async () => {
    mockAiStatus.mockResolvedValue(openRouterActive("acme/echoed-default"));
    setup();

    await screen.findByLabelText("Ask across your vault");
    expect(
      screen.getByRole("button", { name: /choose ai model.*echoed-default/i }),
    ).toBeInTheDocument();
    const header = screen.getByText("Neural Assistant AI").closest("header");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).queryByText("echoed-default")).not.toBeInTheDocument();
  });

  it("keeps a long composer model name bounded behind an accessible full label", async () => {
    const model = "acme/a-very-long-model-name-that-must-not-widen-the-chat-pane";
    mockAiStatus.mockResolvedValue(openRouterActive(model));
    setup();

    await screen.findByLabelText("Ask across your vault");
    expect(
      screen.getByRole("button", { name: new RegExp(`choose ai model.*${model.split("/").pop()}`, "i") }),
    ).toHaveClass("max-w-[11rem]");
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

    const gate = deferred<string>();
    // Emit far more steps than the live cap, then stay in-flight (no `done`) so
    // the turn keeps streaming — this is the thorough-run bloat case.
    mockChat.mockImplementation((_turnId, _p, _h, onEvent) => {
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
      gate.resolve(TURN_ID);
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

  it("truncates long vault paths in activity and source rows while retaining full titles", async () => {
    const relPath =
      "Areas/Programming/Artificial Intelligence/Vibe coding/2026-07-10 The New GPT 5.6 Sol is Insanely Capable and Keeps Going.md";
    await askInChat("q", [
      { type: "reading", relPath, startLine: 123, endLine: 456 },
      { type: "answer", delta: "A cited answer [e1]." },
      {
        type: "citation",
        id: "e1",
        relPath,
        startLine: 321,
        endLine: 321,
        text: "The source text.",
      },
      { type: "done" },
    ]);

    const activityTail = screen.getByText(/The New GPT 5\.6 Sol.*:123/);
    expect(activityTail).toHaveClass("min-w-0", "truncate");
    expect(activityTail.closest("[title]")).toHaveAttribute(
      "title",
      `${relPath}:123–456`,
    );

    const sourcePath = screen.getByText(`${relPath}:321`);
    expect(sourcePath).toHaveClass("min-w-0", "truncate");
    expect(sourcePath.closest("[title]")).toHaveAttribute("title", `${relPath}:321`);
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
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReturnValueOnce(TURN_ID)
      .mockReturnValueOnce(SECOND_TURN_ID);
    const { user } = await askInChat("first question", CITED_RUN);
    await waitFor(() => expect(composer()).toBeEnabled());

    scriptChat([{ type: "answer", delta: "follow up" }, { type: "done" }]);
    await user.type(composer(), "second question");
    await user.click(sendButton());

    const lastCall = mockChat.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(SECOND_TURN_ID);
    expect(lastCall?.[1]).toBe("second question");
    expect(lastCall?.[2]).toEqual([
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

  it("opens an authoritative generated note through workspace navigation", async () => {
    const { openNoteAt, user } = await askInChat("make a note", [
      {
        type: "noteWritten",
        relPath: "Atomic/Generated insight.md",
        kind: "atomic",
      },
      { type: "answer", delta: "I created the note." },
      { type: "done" },
    ]);

    await user.click(
      screen.getByRole("button", { name: "Open Atomic/Generated insight.md" }),
    );
    expect(openNoteAt).toHaveBeenCalledExactlyOnceWith(
      "/vault/Atomic/Generated insight.md",
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

    const gate = deferred<string>();
    mockChat.mockImplementation((_turnId, _p, _h, onEvent) => {
      onEvent({ type: "searching", query: "x" });
      return gate.promise; // stays in-flight
    });

    await user.type(composer(), "hold");
    await user.click(sendButton());
    expect(composer()).toBeDisabled();

    await act(async () => {
      gate.resolve(TURN_ID);
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
      TURN_ID,
      "ask on enter",
      [],
      expect.any(Function),
      [], // no skills picked → the send activates none
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
