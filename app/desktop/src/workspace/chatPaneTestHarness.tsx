// Shared fixtures and helpers for the ChatPane suites, which were one 1595-line
// file until they were split by concern (shell/provider states, the turn loop,
// the reasoning affordances, and the real-browser scroll tier).
//
// `vi.mock` cannot live here — it is hoisted to the top of the file that calls
// it — so each suite still declares its own `../lib/api` and `../lib/store`
// mocks. Everything downstream of those mocks does live here: this module is
// pulled into each suite's module graph, so `api.*` below resolves to that
// suite's mock, not the real command layer.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import * as api from "../lib/api";
import type { AiStatus, ChatEvent, ReasoningSupport } from "../lib/types";
import { ChatPane } from "./ChatPane";
import { ALWAYS_ASK_APPROVAL_STATUS } from "../lib/approvalStatusFixture";

export const mockAiStatus = vi.mocked(api.aiStatus);
export const mockSave = vi.mocked(api.saveApiKey);
export const mockChat = vi.mocked(api.chat);
export const mockCancelChat = vi.mocked(api.cancelChatRun);
export const mockSetReasoning = vi.mocked(api.setReasoning);
export const mockRefreshSupport = vi.mocked(api.refreshReasoningSupport);

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
export const TURN_ID = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e21";
export const SECOND_TURN_ID = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e22";

// ── AiStatus builders (the three effective-provider shapes the pane branches on) ──
// `reasoningSupported` defaults to "unknown": no model has been probed, and
// "unknown" is the fail-open verdict that leaves the reasoning toggle enabled.
export const unconfigured = (): AiStatus => ({
  activeProvider: null,
  reasoningSupported: "unknown",
  openrouter: { hasKey: false, model: DEFAULT_MODEL, reasoning: false },
  local: { activeModelTag: null },
  approval: ALWAYS_ASK_APPROVAL_STATUS,
});
export const openRouterActive = (
  model = DEFAULT_MODEL,
  opts: { reasoning?: boolean; reasoningSupported?: ReasoningSupport } = {},
): AiStatus => ({
  activeProvider: "openRouter",
  reasoningSupported: opts.reasoningSupported ?? "unknown",
  openrouter: { hasKey: true, model, reasoning: opts.reasoning ?? false },
  local: { activeModelTag: null },
  approval: ALWAYS_ASK_APPROVAL_STATUS,
});
export const localActive = (tag: string | null): AiStatus => ({
  activeProvider: "local",
  reasoningSupported: "unknown",
  openrouter: { hasKey: false, model: DEFAULT_MODEL, reasoning: false },
  local: { activeModelTag: tag },
  approval: ALWAYS_ASK_APPROVAL_STATUS,
});

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Render the pane with captured callbacks and a fresh user-event session. */
export function setup(refreshSignal = 0) {
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

export const composer = () => screen.getByLabelText("Ask across your vault");
export const sendButton = () => screen.getByRole("button", { name: "Send" });

/** Walk the first-run picker into the guided OpenRouter key setup. */
export async function openKeySetup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: /connect an openrouter key/i }),
  );
}

/** Script `chat` to replay `events` through the passed onEvent, then resolve. */
export function scriptChat(events: ChatEvent[]) {
  mockChat.mockImplementation(async (_turnId, _prompt, _history, onEvent) => {
    for (const ev of events) onEvent(ev);
    return TURN_ID;
  });
}

// A full cited run, in the frame order the orchestrator actually emits: each
// dispatched call is announced before it runs and settled exactly once, with the
// searching/reading cues it raises on the way. The `title` and `summary` strings
// are the Rust-composed ones from `tool_registry` / `settlement_for` — the UI
// composes neither.
export const CITED_RUN: ChatEvent[] = [
  {
    type: "toolCall",
    id: "call-search",
    name: "search_notes",
    title: "Search notes",
    arguments: '{"query":"active recall"}',
    stepId: null,
  },
  { type: "searching", query: "active recall" },
  { type: "retrieved", query: "active recall", hitCount: 3 },
  {
    type: "toolResult",
    id: "call-search",
    status: "ok",
    summary: "3 spans",
    detail: null,
  },
  {
    type: "toolCall",
    id: "call-read",
    name: "read_note_span",
    title: "Read note",
    arguments: '{"rel_path":"Spaced-Repetition.md","start_line":12,"end_line":28}',
    stepId: null,
  },
  { type: "reading", relPath: "Spaced-Repetition.md", startLine: 12, endLine: 28 },
  {
    type: "toolResult",
    id: "call-read",
    status: "ok",
    summary: "Spaced-Repetition.md:12–28",
    detail: null,
  },
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
export async function askInChat(
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

/** The shared `beforeEach` body: reset every mocked command to its default. */
export function resetChatPaneMocks(reportError: ReturnType<typeof vi.fn>) {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(TURN_ID);
  mockAiStatus.mockReset();
  mockSave.mockReset();
  mockChat.mockReset();
  mockCancelChat.mockReset();
  mockCancelChat.mockResolvedValue({ turnId: TURN_ID, status: "cancelled" });
  mockSetReasoning.mockReset();
  mockRefreshSupport.mockReset();
  reportError.mockReset();
  // The capability probe is network I/O with its own tests; by default it stays
  // in-flight so every other test renders pure mount-status state.
  mockRefreshSupport.mockImplementation(() => new Promise<AiStatus>(() => {}));
  // The @ picker's catalogue load has its own suite (ChatPaneSkills.test.tsx);
  // here it resolves empty so no popup interferes with the chat flows.
  vi.mocked(api.listSkills).mockReset().mockResolvedValue([]);
  vi.mocked(api.openRouterModelMenu).mockReset().mockResolvedValue({
    models: [],
    asOf: "2026-07-13",
    selectedModel: DEFAULT_MODEL,
    pinnedSelectedModel: DEFAULT_MODEL,
  });
  vi.mocked(api.selectOpenRouterModel).mockReset();
  vi.mocked(api.openOpenRouterRankings).mockReset();
}
