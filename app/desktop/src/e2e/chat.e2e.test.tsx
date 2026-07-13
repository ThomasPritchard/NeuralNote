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

// A full, successful run: searching → retrieved → reading → verifying →
// answer (streamed in two deltas) → citation → coverage → done.
const successScript: ChatEvent[] = [
  { type: "searching", query: "photosynthesis" },
  { type: "retrieved", query: "photosynthesis", hitCount: 3 },
  { type: "reading", relPath: NOTE_REL, startLine: 12, endLine: 18 },
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
  { type: "searching", query: "photosynthesis" },
  { type: "retrieved", query: "photosynthesis", hitCount: 3 },
  { type: "reading", relPath: NOTE_REL, startLine: 12, endLine: 18 },
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
  await screen.findByText("Cited recall"); // the chat pane header, in every view
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
});

describe("Journey 7: cited chat — streamed run", () => {
  it("renders the harness trace, the streamed answer, a source chip and coverage", async () => {
    const { user } = await openWorkspace({
      seed: [{ kind: "file", relPath: NOTE_REL, content: NOTE_BODY }],
      chatScript: successScript,
    });

    await ask(user, "How does photosynthesis work?");

    // The finished run collapses to one summary line (collapsed by default), not
    // the row wall — so the answer sits right under the prompt.
    const summaryLine = await screen.findByText(/1 search · 1 note · verified/);
    const disclosure = summaryLine.closest("details");
    expect(disclosure).not.toHaveAttribute("open");

    // Expanding it audits the full deduped trace: searching (folded with its
    // retrieval count), reading the note (basename:range stays legible), and
    // verifying — provenance stays inspectable.
    await user.click(disclosure!.querySelector("summary")!);
    const activity = screen.getByRole("list", { name: "Search activity" });
    expect(within(activity).getByText("searching")).toBeInTheDocument();
    expect(within(activity).getByText(/3 notes/)).toBeInTheDocument();
    expect(
      within(activity).getByText(/Photosynthesis\.md:12/),
    ).toBeInTheDocument();
    expect(within(activity).getByText("verifying citations")).toBeInTheDocument();

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
    const { user } = await openWorkspace({
      seed: [{ kind: "file", relPath: NOTE_REL, content: NOTE_BODY }],
      chatScript: reasoningScript,
    });

    await ask(user, "How does photosynthesis work?");

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
    const { user } = await openWorkspace({
      seed: [{ kind: "file", relPath: NOTE_REL, content: NOTE_BODY }],
      chatScript: successScript,
    });

    await ask(user, "explain it");

    const sources = await screen.findByRole("list", { name: "Cited sources" });
    await user.click(within(sources).getByRole("button", { name: /Photosynthesis\.md:12/ }));

    // The reader now shows the cited note — its stem-derived H1 (same signal the
    // note-crud / search journeys assert an open on).
    expect(
      await screen.findByRole("heading", { name: "Photosynthesis", level: 1 }),
    ).toBeInTheDocument();
  });
});

describe("Journey 7: cited chat — surfaced error", () => {
  it("shows a run error inline instead of a silent blank, and frees the composer", async () => {
    const errorScript: ChatEvent[] = [
      { type: "searching", query: "quantum gravity" },
      { type: "error", message: "The model provider is unreachable." },
    ];
    const { user } = await openWorkspace({ chatScript: errorScript });

    await ask(user, "anything");

    expect(
      await screen.findByText("The model provider is unreachable."),
    ).toBeInTheDocument();
    // The run ended (error implies done), so the composer re-enabled — never stuck busy.
    await waitFor(() =>
      expect(screen.getByLabelText("Ask across your vault")).toBeEnabled(),
    );
  });
});
