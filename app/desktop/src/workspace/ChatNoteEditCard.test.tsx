// The live note-write card, driven through the REAL reducer.
//
// Every turn below is built by folding actual `ChatEvent`s with
// `reduceAssistant`, in the frame order the orchestrator emits them, so these
// tests fail if the reducer's shape and the card's reading of it ever part
// company. The three orderings that are easy to render backwards each get their
// own test:
//
//   • the preview arrives BEFORE its tool call, so a card must be complete with
//     no call at all;
//   • a preview that completes and is then REJECTED gets no abandonment event —
//     the refusal is only readable off the tool call's status;
//   • an abandoned preview must clear the body, not fold it away.
//
// Plus the two the providers differ on: a body that arrives in hundreds of
// fragments (OpenRouter) and one that arrives in a single shot (local Ollama).

import { act } from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyAssistant,
  reduceAssistant,
  type AssistantMessage,
  type ChatMessage,
} from "./chatMessage";
import type { ChatEvent, NoteKind } from "../lib/types";

// `SkillReportCard` (rendered by the same turn once a write lands) calls the
// command layer, so the module is stubbed exactly as the sibling ChatMessages
// suites do. Nothing in this file exercises it.
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, undoSkillRun: vi.fn(), answerElicitation: vi.fn() };
});

import { ChatMessages } from "./ChatMessages";
// The card's own tolerance, mirrored rather than re-guessed.
import { THROTTLE_MS } from "./ChatNoteEditCard";

const CALL_ID = "call-write-1";
const REL_PATH = "Atomic/Spaced recall.md";

const preview = (
  body: string,
  complete: boolean,
  opts: { relPath?: string | null; kind?: NoteKind | null; id?: string } = {},
): ChatEvent => ({
  type: "noteEditPreview",
  id: opts.id ?? CALL_ID,
  relPath: opts.relPath === undefined ? REL_PATH : opts.relPath,
  kind: opts.kind === undefined ? "atomic" : opts.kind,
  body,
  complete,
});

const writeCall = (id = CALL_ID): ChatEvent => ({
  type: "toolCall",
  id,
  name: "write_note",
  title: "Write note",
  arguments: JSON.stringify({ rel_path: REL_PATH, kind: "atomic", content: "…" }),
  stepId: null,
});

const settle = (
  status: "ok" | "rejected" | "error" | "denied",
  detail: string | null = null,
  id = CALL_ID,
): ChatEvent => ({ type: "toolResult", id, status, summary: null, detail, durationMs: 0 });

const abandon = (reason: string, id = CALL_ID): ChatEvent => ({
  type: "noteEditAbandoned",
  id,
  reason,
});

/** `n` numbered lines with a trailing newline — a note body, at any length. */
const rows = (n: number) =>
  `${Array.from({ length: n }, (_, i) => `row ${i + 1}`).join("\n")}\n`;

/** Fold a script onto a fresh assistant turn. */
function turnFrom(...events: ChatEvent[]): AssistantMessage {
  return events.reduce(reduceAssistant, emptyAssistant(false, "turn-1"));
}

function messages(turn: AssistantMessage): ChatMessage[] {
  return [{ role: "user", content: "capture that" }, turn];
}

function renderTurn(turn: AssistantMessage) {
  const view = render(
    <ChatMessages
      messages={messages(turn)}
      onOpenCitation={() => {}}
      onOpenNote={() => {}}
      onSendFollowUp={() => {}}
      busy={false}
      runIds={{}}
    />,
  );
  return {
    ...view,
    update: (next: AssistantMessage) =>
      view.rerender(
        <ChatMessages
          messages={messages(next)}
          onOpenCitation={() => {}}
          onOpenNote={() => {}}
          onSendFollowUp={() => {}}
          busy={false}
          runIds={{}}
        />,
      ),
  };
}

/** Every write card on screen — the count is itself an assertion: a card that
 *  "upgrades" by rendering a second one has not upgraded in place. */
const cards = () => screen.queryAllByRole("region", { name: /^Note write/ });
const card = () => screen.getByRole("region", { name: `Note write: ${REL_PATH}` });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("note-write card — composing, then settling in place", () => {
  it("upgrades the same card from writing to written without ever making a second one", async () => {
    // Fragment by fragment, as OpenRouter delivers it.
    const composing = turnFrom(
      preview("# Spaced recall\n", false),
      preview("# Spaced recall\n\nRetrieval beats", false),
    );
    const view = renderTurn(composing);

    expect(cards()).toHaveLength(1);
    expect(card()).toHaveTextContent("writing");
    const before = card();

    view.update(
      turnFrom(
        preview("# Spaced recall\n", false),
        preview("# Spaced recall\n\nRetrieval beats rereading, reliably.\n", false),
      ),
    );
    expect(await screen.findByText("Retrieval beats rereading, reliably.")).toBeVisible();

    // The arguments close, the call is announced, and it settles.
    const settled = turnFrom(
      preview("# Spaced recall\n\nRetrieval beats rereading, reliably.\n", true),
      writeCall(),
      settle("ok"),
      { type: "noteWritten", relPath: REL_PATH, kind: "atomic" },
      { type: "done" },
    );
    view.update(settled);

    // Same DOM node, still exactly one: this is what "in place" means.
    expect(cards()).toHaveLength(1);
    expect(card()).toBe(before);
    expect(card()).toHaveTextContent("written");
    expect(card()).not.toHaveTextContent("writing");
    // A settled write folds itself away — the answer is the live focus now.
    expect(card().querySelector("details")?.open).toBe(false);
  });

  it("coalesces a burst of fragments into one render, and never drops the last", () => {
    // Content arrives ~12 characters at a time and a note is comfortably
    // hundreds of updates. Each one re-splits the body and re-renders a dozen
    // rows inside a scroll container that re-pins on every commit, so the burst
    // is throttled — but the trailing value must always land, or the card is
    // left showing a body that is permanently one fragment stale.
    vi.useFakeTimers();
    const view = renderTurn(turnFrom(preview("alpha\n", false)));
    expect(within(card()).getByText("alpha")).toBeInTheDocument();

    for (let i = 1; i <= 20; i += 1) {
      view.update(turnFrom(preview(`alpha\nfragment ${i}\n`, false)));
    }
    // Still the leading edge's value: twenty updates, one render.
    expect(within(card()).queryByText("fragment 20")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(THROTTLE_MS + 20);
    });
    expect(within(card()).getByText("fragment 20")).toBeInTheDocument();
  });

  it("renders a whole write from a single atomic update, the way the local provider sends it", () => {
    // Measured: local Ollama delivers the tool call in one payload, so the card
    // must be correct after ONE update — never assuming a second one arrives.
    renderTurn(
      turnFrom(
        preview("# One shot\n\nThe whole body, at once.\n", true),
        writeCall(),
        settle("ok"),
        { type: "noteWritten", relPath: REL_PATH, kind: "atomic" },
        { type: "done" },
      ),
    );

    expect(cards()).toHaveLength(1);
    expect(card()).toHaveTextContent("written");
    expect(within(card()).getByText("The whole body, at once.")).toBeInTheDocument();
    expect(within(card()).getByText("+3")).toBeInTheDocument();
  });
});

describe("note-write card — the running count", () => {
  it("counts the lines composed so far, because the settled count does not exist yet", () => {
    // The turn has written nothing: `writtenNotes` is empty and no completion
    // event has landed. A count read off one of those reads +0 for the whole
    // composition — the entire span the user is watching.
    const turn = turnFrom(preview("# Title\n\nOne.\nTwo.\n", false));
    expect(turn.writtenNotes).toHaveLength(0);

    renderTurn(turn);

    expect(within(card()).getByText("+4")).toBeInTheDocument();
    expect(within(card()).queryByText("+0")).not.toBeInTheDocument();
  });

  it("shows the newest lines and says how many are above them", () => {
    // 20 lines with a 12-line window: the newest are in view, the oldest are not.
    const body = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const view = renderTurn(turnFrom(preview(body, false)));

    expect(within(card()).getByText("+20")).toBeInTheDocument();
    expect(within(card()).getByText("line 20")).toBeInTheDocument();
    expect(within(card()).queryByText("line 1")).not.toBeInTheDocument();

    // Settled and expanded, the window widens and the elision is stated rather
    // than faded — a number that churned every fragment would be noise.
    view.update(turnFrom(preview(rows(405), true), writeCall(), settle("ok")));
    expect(within(card()).getByText("5 earlier lines")).toBeInTheDocument();
    expect(within(card()).getByText("row 405")).toBeInTheDocument();

    view.update(turnFrom(preview(rows(401), true), writeCall(), settle("ok")));
    expect(within(card()).getByText("1 earlier line")).toBeInTheDocument();
  });

  it("names nothing it does not know yet", () => {
    // Half a path is not a path, and the kind may not have arrived either.
    renderTurn(turnFrom(preview("# ", false, { relPath: null, kind: null })));

    const only = screen.getByRole("region", { name: "Note write" });
    expect(within(only).getByText("naming the note…")).toBeInTheDocument();
    expect(within(only).queryByText("atomic")).not.toBeInTheDocument();
  });
});

describe("note-write card — the preview arrives before its tool call", () => {
  it("is complete with no tool call at all, and stands the rail's node down once one arrives", () => {
    // Phase 1: the preview is streaming. There is no tool call yet — this is the
    // normal live state, not missing data.
    const streaming = turnFrom(preview("# Spaced recall\n", false));
    expect(streaming.toolCalls).toHaveLength(0);
    const view = renderTurn(streaming);
    expect(card()).toHaveTextContent("writing");

    // Phase 2: the turn settles and the calls are announced. The write's node
    // stands down (the card is the fuller account); an unrelated call keeps its.
    view.update(
      turnFrom(
        preview("# Spaced recall\n", true),
        {
          type: "toolCall",
          id: "call-search",
          name: "search_notes",
          title: "Search notes",
          arguments: '{"query":"recall"}',
          stepId: null,
        },
        settle("ok", null, "call-search"),
        writeCall(),
        settle("ok"),
        { type: "done" },
      ),
    );

    const rail = screen.getByRole("region", { name: "What the assistant did" });
    const nodes = within(rail).getAllByRole("listitem");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toHaveTextContent("Search notes");
    expect(rail).not.toHaveTextContent("Write note");
    // …and the head counts what it shows, not what it hid.
    expect(within(rail).getByText(/1 tool/)).toBeInTheDocument();
  });

  it("waits to write once the arguments close but before anything is dispatched", () => {
    // `complete` means the arguments parsed. Nothing has been written.
    renderTurn(turnFrom(preview("# Ready\n", true)));

    expect(card()).toHaveTextContent("waiting to write");
    expect(card()).not.toHaveTextContent("written");
  });
});

describe("note-write card — a rejection is not an abandonment", () => {
  it("reads the refusal off the tool call, because no abandonment event follows", () => {
    const turn = turnFrom(
      preview("# Spaced recall\n\nBody.\n", true),
      writeCall(),
      settle("rejected", "write_note failed: note path escapes the vault"),
      { type: "done" },
    );
    // The contract this test exists for: nothing retired the preview.
    expect(turn.noteEdits[0].abandoned).toBeNull();

    renderTurn(turn);

    expect(card()).toHaveTextContent("refused by NeuralNote");
    expect(card()).not.toHaveTextContent("written");
    // The rail's node stood down, so this card owes the user the reason.
    expect(
      within(card()).getByText("write_note failed: note path escapes the vault"),
    ).toBeInTheDocument();
    // Nothing landed, so a `+N` here would be a false claim about the vault.
    expect(within(card()).queryByText(/^\+\d/)).not.toBeInTheDocument();
  });

  it("tells a run failure apart from an orchestrator refusal", () => {
    renderTurn(
      turnFrom(
        preview("# Spaced recall\n", true),
        writeCall(),
        settle("error", "the disk was full"),
        { type: "done" },
      ),
    );

    expect(card()).toHaveTextContent("failed");
    expect(card()).not.toHaveTextContent("refused by NeuralNote");
    expect(card()).not.toHaveTextContent("denied by you");
  });
});

describe("note-write card — an abandoned preview", () => {
  it("clears the half-written body and says why it will never land", () => {
    const turn = turnFrom(
      preview("# Spaced recall\n\nRetrieval beats rer", false),
      abandon("the provider stream ended mid-call"),
      { type: "error", message: "The model provider is unreachable." },
    );

    renderTurn(turn);

    // The fragment is GONE — not folded away, where it would still be one click
    // from reading as committed.
    expect(screen.queryByText(/Retrieval beats rer/)).not.toBeInTheDocument();
    expect(card().querySelector("details")).toBeNull();
    expect(
      within(card()).getByText(
        "This note was never written — the provider stream ended mid-call",
      ),
    ).toBeInTheDocument();
    expect(card()).toHaveTextContent("not written");
    expect(within(card()).queryByText(/^\+\d/)).not.toBeInTheDocument();
  });

  it("stays retired even if a later preview fragment arrives for the same id", () => {
    // The reducer carries `abandoned` across a re-preview on purpose; the card
    // must not resurrect the body when it does.
    const turn = turnFrom(
      preview("# Spaced recall\n", false),
      abandon("the run was cancelled"),
      preview("# Spaced recall\n\nlate fragment\n", false),
    );

    renderTurn(turn);

    expect(screen.queryByText("late fragment")).not.toBeInTheDocument();
    expect(card()).toHaveTextContent("not written");
  });
});
