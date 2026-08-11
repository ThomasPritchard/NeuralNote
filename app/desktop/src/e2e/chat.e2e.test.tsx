// Journey 7: cited AI chat, end-to-end through the REAL Tauri IPC seam.
//
// Unlike the ChatPane component tests (which stub `../lib/api`), this exercises
// the untested path: `api.ts` → `invoke` → `mockIPC` → a live `@tauri-apps/api`
// `Channel`. `api.chat` passes a `Channel` as the `onEvent` invoke arg; the mock
// backend replays a scripted `ChatEvent[]` back through it exactly as the Rust
// core would (one `{ index, message }` frame per event, in order), so the pane
// folds a genuine stream. See `mockVault.ts`'s `emitToChannel` for the mechanism.
//
//   1. No provider       → first-run picker → guided setup (never a raw error).
//   2. Ask → stream      → the harness trace, streamed answer, a source chip,
//                          and the coverage footer all render.
//   3. Citation click    → opens the cited note in the reader.
//   4. Run error         → surfaced inline, never a silent blank; composer frees.

import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type CreateMockVaultOptions } from "./mockVault";
import type { ChatEvent } from "../lib/types";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

// The note the scripted citation points at — seeded so clicking the chip can
// actually open it in the reader (its stem is the reader's H1 title).
const NOTE_REL = "Sources/Photosynthesis.md";
const NOTE_BODY = "Light energy is converted into chemical energy in the chloroplast.";

// The dispatched calls of a successful run, in the frame order the orchestrator
// emits: announced before dispatch, then the searching/reading cue they raise,
// then exactly one settlement each. Titles and summaries are the Rust-composed
// ones — the UI never builds a tool label.
const searchCall: ChatEvent[] = [
  {
    type: "toolCall",
    id: "call-search",
    name: "search_notes",
    title: "Search notes",
    arguments: '{"query":"photosynthesis"}',
    stepId: null,
  },
  { type: "searching", query: "photosynthesis" },
  { type: "retrieved", query: "photosynthesis", hitCount: 3 },
  { type: "toolResult", id: "call-search", status: "ok", summary: "3 spans", detail: null },
];
const readCall: ChatEvent[] = [
  {
    type: "toolCall",
    id: "call-read",
    name: "read_note_span",
    title: "Read note",
    arguments: `{"rel_path":"${NOTE_REL}","start_line":12,"end_line":18}`,
    stepId: null,
  },
  { type: "reading", relPath: NOTE_REL, startLine: 12, endLine: 18 },
  {
    type: "toolResult",
    id: "call-read",
    status: "ok",
    summary: `${NOTE_REL}:12–18`,
    detail: null,
  },
];

// A full, successful run: two tool calls → verifying → answer (streamed in two
// deltas) → citation → coverage → done.
const successScript: ChatEvent[] = [
  ...searchCall,
  ...readCall,
  { type: "verifying" },
  { type: "answer", delta: "Plants turn sunlight " },
  { type: "answer", delta: "into sugar." },
  {
    type: "citation",
    id: "e1",
    relPath: NOTE_REL,
    startLine: 12,
    endLine: 14,
    text: "converted into chemical energy",
  },
  {
    type: "coverage",
    searchedTerms: ["photosynthesis"],
    notesRead: [NOTE_REL],
    truncated: false,
    skippedFiles: 0,
  },
  { type: "done" },
];

// The same run, with reasoning tokens. OpenRouter streams these as `thinking`
// deltas interleaved before the answer. They must fold into their own disclosure
// and never into the answer body: the answer is the text citations are verified
// against, so contaminating it would corrupt provenance.
const reasoningScript: ChatEvent[] = [
  ...searchCall,
  ...readCall,
  { type: "thinking", delta: "The note names chloroplasts, " },
  { type: "thinking", delta: "so the answer should too." },
  { type: "verifying" },
  { type: "answer", delta: "Plants turn sunlight " },
  { type: "answer", delta: "into sugar." },
  {
    type: "citation",
    id: "e1",
    relPath: NOTE_REL,
    startLine: 12,
    endLine: 14,
    text: "converted into chemical energy",
  },
  {
    type: "coverage",
    searchedTerms: ["photosynthesis"],
    notesRead: [NOTE_REL],
    truncated: false,
    skippedFiles: 0,
  },
  { type: "done" },
];

/** Render the app and open the recent vault, resolving once the ChatPane has
 *  mounted (it only exists inside an open vault). */
async function openWorkspace(opts: CreateMockVaultOptions = {}) {
  const result = renderApp({ recents, ...opts });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByText("Neural Assistant AI"); // the chat pane header, in every view
  return result;
}

/** Type a prompt and hit Send. */
async function ask(user: ReturnType<typeof renderApp>["user"], prompt: string) {
  await user.type(await screen.findByLabelText("Ask across your vault"), prompt);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

describe("Journey 7: cited chat — no API key", () => {
  it("shows the provider picker, then guided key setup — not a raw error", async () => {
    const { user } = await openWorkspace({ apiKey: { hasKey: false } });

    // Nothing configured → the first-run provider picker, not an error.
    await user.click(
      await screen.findByRole("button", { name: /connect an openrouter key/i }),
    );

    expect(await screen.findByText("Connect an AI key")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenRouter API key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeInTheDocument();
    // We're in setup, so the chat composer isn't rendered.
    expect(screen.queryByLabelText("Ask across your vault")).not.toBeInTheDocument();
  });

  it("can skip onboarding without accidentally enabling chat", async () => {
    const { user } = await openWorkspace({ apiKey: { hasKey: false } });

    await user.click(await screen.findByRole("button", { name: "Skip for now" }));

    expect(screen.getByText("Cited chat is off")).toBeInTheDocument();
    expect(screen.queryByLabelText("Ask across your vault")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect a model" }));
    expect(screen.getByRole("button", { name: /connect an openrouter key/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set up local ai/i })).toBeInTheDocument();
  });

  it("saves the entered provider key and model before enabling chat", async () => {
    const { user, backend } = await openWorkspace({
      apiKey: { hasKey: false },
      expectedApiKey: "sk-or-test-secret",
    });
    await user.click(await screen.findByRole("button", { name: /connect an openrouter key/i }));
    await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-test-secret");
    const model = screen.getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "openai/gpt-5.2");
    await user.click(screen.getByRole("button", { name: /save & start chatting/i }));

    expect(await screen.findByLabelText("Ask across your vault")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /choose ai model, current gpt-5\.2/i }),
    ).toBeInTheDocument();
    expect(backend.calls.filter((call) => call === "save_api_key")).toHaveLength(1);
    expect(backend.apiKeySaveAttempts).toEqual([
      { keyMatchesExpected: true, model: "openai/gpt-5.2" },
    ]);
  });
});

describe("Journey 7: chat model selection", () => {
  it("loads the native-ranked menu and persists an offered OpenRouter model", async () => {
    const { user, backend } = await openWorkspace();

    await user.click(
      await screen.findByRole("button", { name: /choose ai model, current claude-sonnet-4\.5/i }),
    );
    await user.click(await screen.findByRole("menuitemradio", { name: /gpt-5\.2/i }));

    expect(
      await screen.findByRole("button", { name: /choose ai model, current gpt-5\.2/i }),
    ).toBeInTheDocument();
    expect(backend.calls).toContain("openrouter_model_menu");
    expect(backend.calls).toContain("select_openrouter_model");
  });
});

describe("Journey 7: cited chat — streamed run", () => {
  it("renders each progressive phase before the answer and terminal frame", async () => {
    const { user, advanceNextFrame } = await openWorkspace({
      chatScript: [
        { type: "searching", query: "photosynthesis" },
        { type: "answer", delta: "Plants need light." },
        { type: "done" },
      ],
    });

    await ask(user, "How do plants grow?");
    expect(screen.queryByText("Plants need light.")).not.toBeInTheDocument();

    expect(await advanceNextFrame()).toBe(true);
    expect(screen.getByText("Searching your vault")).toBeInTheDocument();
    expect(screen.queryByText("Plants need light.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop response" })).toBeInTheDocument();

    expect(await advanceNextFrame()).toBe(true);
    expect(screen.getByText("Plants need light.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop response" })).toBeInTheDocument();

    expect(await advanceNextFrame()).toBe(true);
    expect(await advanceNextFrame()).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument(),
    );
  });

  it("renders a greeting-only answer without research chrome", async () => {
    const { user, advanceAllFrames } = await openWorkspace({
      chatScript: [
        { type: "answer", delta: "Hello — what would you like to explore?" },
        { type: "done" },
      ],
    });

    await ask(user, "hello");
    await advanceAllFrames();

    expect(await screen.findByText("Hello — what would you like to explore?")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "What the assistant did" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing in your vault covers this")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Cited sources" })).not.toBeInTheDocument();
  });
  it("renders the timeline rail, the streamed answer, a source chip and coverage", async () => {
    const { user, advanceAllFrames } = await openWorkspace({
      seed: [{ kind: "file", relPath: NOTE_REL, content: NOTE_BODY }],
      chatScript: successScript,
    });

    await ask(user, "How does photosynthesis work?");
    await advanceAllFrames();

    // The finished run collapses to one summary line (collapsed by default), not
    // the row wall — so the answer sits right under the prompt.
    const summaryLine = await screen.findByText(/2 tools · 1 search · 1 note · verified/);
    const disclosure = summaryLine.closest("details");
    expect(disclosure).not.toHaveAttribute("open");

    // Expanding it audits the whole rail: the search call with the query it ran
    // and the spans it got back, the read with its span, and the verify step —
    // provenance stays inspectable, and every label crossed the IPC seam.
    await user.click(disclosure!.querySelector("summary")!);
    const rail = screen.getByRole("region", { name: "What the assistant did" });
    expect(within(rail).getByText("Search notes")).toBeInTheDocument();
    expect(within(rail).getByText("· photosynthesis")).toBeInTheDocument();
    expect(within(rail).getByText("· 3 spans")).toBeInTheDocument();
    expect(
      within(rail).getByText(/Photosynthesis\.md:12–18/),
    ).toBeInTheDocument();
    expect(within(rail).getByText("verifying citations")).toBeInTheDocument();

    // The answer, folded delta-by-delta.
    expect(
      await screen.findByText(/Plants turn sunlight into sugar\./),
    ).toBeInTheDocument();

    // A cited source chip.
    const sources = screen.getByRole("list", { name: "Cited sources" });
    expect(
      within(sources).getByRole("button", { name: /Photosynthesis\.md:12/ }),
    ).toBeInTheDocument();
    // The provenance count lives in the summary line now (asserted above), not a
    // second, independently-computed coverage line that could disagree with it.
  });

  it("folds reasoning into its own disclosure and never into the cited answer", async () => {
    const { user, advanceAllFrames } = await openWorkspace({
      seed: [{ kind: "file", relPath: NOTE_REL, content: NOTE_BODY }],
      chatScript: reasoningScript,
    });

    await ask(user, "How does photosynthesis work?");
    await advanceAllFrames();

    // The answer is exactly what the `answer` deltas carried. If reasoning ever
    // leaked into it, the cited text would no longer match the verified span.
    const answer = await screen.findByText(/Plants turn sunlight into sugar\./);
    expect(answer.textContent).not.toMatch(/chloroplasts/i);

    // Reasoning is inspectable but collapsed — it is provenance, not the answer.
    // (Scoped to the disclosure's <summary>: the composer's reasoning chip also
    // carries the visible word "Reasoning".)
    const reasoning = screen.getByText("Reasoning", { selector: "summary" }).closest("details")!;
    expect(reasoning).not.toHaveAttribute("open");

    await user.click(within(reasoning).getByText("Reasoning"));
    expect(
      within(reasoning).getByText(
        /The note names chloroplasts, so the answer should too\./,
      ),
    ).toBeInTheDocument();

    // The run still completed normally: the citation survived alongside it.
    const sources = screen.getByRole("list", { name: "Cited sources" });
    expect(
      within(sources).getByRole("button", { name: /Photosynthesis\.md:12/ }),
    ).toBeInTheDocument();
  });

  it("opens the cited note in the reader when its source chip is clicked", async () => {
    const { user, advanceAllFrames } = await openWorkspace({
      seed: [{ kind: "file", relPath: NOTE_REL, content: NOTE_BODY }],
      chatScript: successScript,
    });

    await ask(user, "explain it");
    await advanceAllFrames();

    const sources = await screen.findByRole("list", { name: "Cited sources" });
    await user.click(within(sources).getByRole("button", { name: /Photosynthesis\.md:12/ }));

    // The reader now shows the cited note — its stem-derived H1 (same signal the
    // note-crud / search journeys assert an open on).
    expect(
      await screen.findByRole("heading", { name: "Photosynthesis", level: 1 }),
    ).toBeInTheDocument();
  });
});

describe("Journey 7: cited chat — the timeline rail", () => {
  it("puts a successful, a rejected and a failed call on the rail, each told apart", async () => {
    // Every one of these frames crosses the real IPC seam: `api.chat` hands a
    // Tauri Channel to the mock backend, which replays them exactly as the Rust
    // core would. The component tests stub the whole api module, so this is the
    // only tier that proves `toolCall` / `toolResult` actually arrive.
    const script: ChatEvent[] = [
      {
        type: "toolCall",
        id: "ok-1",
        name: "search_notes",
        title: "Search notes",
        arguments: '{"query":"photosynthesis"}',
        stepId: null,
      },
      { type: "searching", query: "photosynthesis" },
      { type: "retrieved", query: "photosynthesis", hitCount: 3 },
      { type: "toolResult", id: "ok-1", status: "ok", summary: "3 spans", detail: null },
      {
        type: "toolCall",
        id: "rejected-1",
        name: "read_note_span",
        title: "Read note",
        arguments: '{"rel_path":"Missing.md","start_line":1,"end_line":9}',
        stepId: null,
      },
      {
        type: "toolResult",
        id: "rejected-1",
        status: "rejected",
        summary: null,
        detail: "note not found: Missing.md",
      },
      {
        type: "toolCall",
        id: "error-1",
        name: "fetch_captions",
        title: "Fetch captions",
        arguments: '{"url":"https://youtu.be/jNQXAC9IVRw"}',
        stepId: null,
      },
      {
        type: "toolResult",
        id: "error-1",
        status: "error",
        summary: null,
        detail: "the caption service timed out",
      },
      { type: "answer", delta: "Here is what I could find." },
      { type: "done" },
    ];
    const { user, advanceAllFrames } = await openWorkspace({ chatScript: script });

    await ask(user, "How does photosynthesis work?");
    await advanceAllFrames();

    // A failed call is something to act on, so the rail stays open on its own.
    const rail = await screen.findByRole("region", { name: "What the assistant did" });
    const [ok, rejected, errored] = within(rail).getAllByRole("listitem");

    // 1. Succeeded: calm, with the query it ran and what came back.
    expect(within(ok).getByText("Search notes")).toBeInTheDocument();
    expect(within(ok).getByText("· 3 spans")).toBeInTheDocument();
    expect(ok).not.toHaveTextContent(/failed|refused|denied/);

    // 2. The orchestrator refused it — and that is not the user refusing.
    expect(rejected).toHaveTextContent("refused by NeuralNote");
    expect(rejected).not.toHaveTextContent("denied by you");
    expect(within(rejected).getByText("note not found: Missing.md")).toBeInTheDocument();

    // 3. It ran and failed — a third, distinct story.
    expect(errored).toHaveTextContent("failed");
    expect(within(errored).getByText("the caption service timed out")).toBeInTheDocument();

    // The head counts them without burying the two that went wrong.
    expect(within(rail).getByText(/2 calls failed/)).toBeInTheDocument();
  });

  it("reports a note the run left alone, and offers no Undo for it", async () => {
    const { user, advanceAllFrames } = await openWorkspace({
      chatScript: [
        { type: "noteWritten", relPath: "Atomic/Fresh insight.md", kind: "atomic" },
        { type: "noteExists", relPath: "Literature/Already here.md", kind: "literature" },
        { type: "answer", delta: "One was already there." },
        { type: "done" },
      ],
    });

    await ask(user, "capture both of these");
    await advanceAllFrames();

    // Nothing was written for the second one, so it is counted and listed apart —
    // silently dropping the no-op is what #108 was about.
    expect(await screen.findByText("1 note written")).toBeInTheDocument();
    const existing = screen.getByRole("list", { name: "Notes that already existed" });
    expect(within(existing).getByText("Already here.md")).toBeInTheDocument();
    // Undo removes what this run wrote; it must never reach the user's own note.
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText(/Undo finished — 1 note removed\./)).toBeInTheDocument();
    expect(within(existing).getByText(/Left as it was/)).toBeInTheDocument();
  });
});

describe("Journey 7: cited chat — a note write, previewed as it composes", () => {
  const WRITE_REL = "Atomic/Spaced recall.md";
  const WRITE_BODY = "# Spaced recall\n\nRetrieval beats rereading, reliably.\n";
  const previewFrame = (body: string, complete: boolean, named = true): ChatEvent => ({
    type: "noteEditPreview",
    id: "call-write",
    relPath: named ? WRITE_REL : null,
    kind: named ? "atomic" : null,
    body,
    complete,
  });

  it("streams the composing note across the IPC seam, then settles it in place", async () => {
    // The card and its tool call share an id, and the frames arrive in the order
    // the orchestrator actually emits them: the preview streams DURING the turn
    // and the call is announced when the turn settles. Only this tier proves
    // those frames cross the Channel — the component tests stub the whole api
    // module, so a `noteEditPreview` that never serialised would still pass there.
    const script: ChatEvent[] = [
      previewFrame("", false, false),
      previewFrame("# Spaced recall\n", false),
      previewFrame("# Spaced recall\n\nRetrieval beats", false),
      previewFrame(WRITE_BODY, true),
      {
        type: "toolCall",
        id: "call-write",
        name: "write_note",
        title: "Write note",
        arguments: JSON.stringify({
          rel_path: WRITE_REL,
          kind: "atomic",
          content: WRITE_BODY,
        }),
        stepId: null,
      },
      { type: "toolResult", id: "call-write", status: "ok", summary: null, detail: null },
      { type: "noteWritten", relPath: WRITE_REL, kind: "atomic" },
      { type: "answer", delta: "Captured it." },
      { type: "done" },
    ];
    const { user, advanceAllFrames, advanceNextFrame } = await openWorkspace({
      chatScript: script,
    });

    await ask(user, "capture that idea about recall");

    // Frame at a time, so the card is caught MID-RUN: it exists before any
    // settlement frame has been delivered, which is the ordering that makes the
    // preview a preview rather than a receipt.
    for (
      let guard = 0;
      guard < 4 && screen.queryByRole("region", { name: /^Note write/ }) === null;
      guard += 1
    ) {
      expect(await advanceNextFrame()).toBe(true);
    }
    const card = screen.getByRole("region", { name: /^Note write/ });
    expect(card).toHaveTextContent("writing");
    expect(card).not.toHaveTextContent("written");

    await advanceAllFrames();

    // Upgraded in place: still exactly one card, now reporting the write.
    const settledCards = screen.getAllByRole("region", { name: /^Note write/ });
    expect(settledCards).toHaveLength(1);
    expect(settledCards[0]).toHaveTextContent("written");
    expect(within(settledCards[0]).getByText("+3")).toBeInTheDocument();
    // Its rail node stood down — one act, one surface. The write was this run's
    // only tool call, so the rail is left with nothing to show at all.
    expect(screen.queryByText("Write note")).toBeNull();
    expect(screen.queryByRole("region", { name: "What the assistant did" })).toBeNull();
    // Undo is offered on settle, exactly once: the run's report card owns it,
    // because only it carries the path the write actually RESOLVED to.
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    expect(await screen.findByText("1 note written")).toBeInTheDocument();
  });

  it("clears an abandoned preview instead of leaving a fragment looking committed", async () => {
    // The captured turn's real failure: the provider died with the last call
    // truncated mid-sentence. No write happened, and no `noteWritten` follows.
    const { user, advanceAllFrames } = await openWorkspace({
      chatScript: [
        previewFrame("# Spaced recall\n\nRetrieval beats rer", false),
        {
          type: "noteEditAbandoned",
          id: "call-write",
          reason: "the provider stream ended mid-call",
        },
        { type: "error", message: "The model provider is unreachable." },
      ],
    });

    await ask(user, "capture that idea about recall");
    await advanceAllFrames();

    const card = await screen.findByRole("region", { name: /^Note write/ });
    expect(card).toHaveTextContent("not written");
    expect(
      within(card).getByText(
        "This note was never written — the provider stream ended mid-call",
      ),
    ).toBeInTheDocument();
    // The fragment is gone, and nothing offers to undo a write that never was.
    expect(screen.queryByText(/Retrieval beats rer/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("Journey 7: cited chat — surfaced error", () => {
  it("shows a run error inline instead of a silent blank, and frees the composer", async () => {
    const errorScript: ChatEvent[] = [
      { type: "searching", query: "quantum gravity" },
      { type: "error", message: "The model provider is unreachable." },
    ];
    const { user, advanceAllFrames } = await openWorkspace({ chatScript: errorScript });

    await ask(user, "anything");
    await advanceAllFrames();

    expect(
      await screen.findByText("The model provider is unreachable."),
    ).toBeInTheDocument();
    // The run ended (error implies done), so the composer re-enabled — never stuck busy.
    await waitFor(() =>
      expect(screen.getByLabelText("Ask across your vault")).toBeEnabled(),
    );
  });

  it("keeps the stopped state authoritative when late provider frames arrive", async () => {
    const { user, advanceAllFrames } = await openWorkspace({
      chatScript: [{ type: "processing" }],
      cancelChatAfterEvents: 1,
      cancelChatTail: [
        { type: "answer", delta: "late provider answer" },
        { type: "done" },
      ],
    });
    await ask(user, "stop this");
    await advanceAllFrames();
    await user.click(await screen.findByRole("button", { name: "Stop response" }));
    expect(await screen.findByText("Stopped")).toBeInTheDocument();

    await advanceAllFrames();

    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText("late provider answer")).not.toBeInTheDocument();
  });
});
