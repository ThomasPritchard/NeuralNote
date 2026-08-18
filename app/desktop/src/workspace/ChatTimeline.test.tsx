// ChatTimeline — the process rail: one connected column carrying what the
// assistant did, a fold head that reads live while it streams and settles to a
// one-line summary afterwards, and a node per dispatched tool call whose state
// reads from the glyph column before any text.
//
// The properties under test are honesty properties, not layout ones:
//   • every ToolStatus tells its own story — `rejected` (the orchestrator
//     refused) never reads as `denied` (the user refused), and neither
//     `timedOut` nor `cancelled` reads as either;
//   • a failure opens itself rather than hiding one click away;
//   • reasoning renders as markdown, so a structured thought stays legible;
//   • the install affordance is reached through the structured `missingBinary`,
//     never by matching a sentence composed in Rust.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepStatus, ToolStatus } from "../lib/types";
import { STALL_AFTER_MS } from "./turnLiveness";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    downloadRequirement: vi.fn(),
    cancelRequirementDownload: vi.fn(),
  };
});

import * as api from "../lib/api";
import { ChatTimeline } from "./ChatTimeline";
import { formatArguments } from "./ChatTimelineNodes";
import {
  emptyAssistant,
  type AssistantMessage,
  type PlanStepView,
  type ToolCallView,
} from "./chatMessage";

const mockDownloadRequirement = vi.mocked(api.downloadRequirement);

/** A settled call, with the Rust-composed title/summary a real run carries. */
const call = (
  id: string,
  status: ToolStatus | null,
  overrides: Partial<ToolCallView> = {},
): ToolCallView => ({
  id,
  name: "search_notes",
  title: "Search notes",
  arguments: '{"query":"active recall"}',
  status,
  summary: null,
  detail: null,
  stepId: null,
  ...overrides,
});

function renderTimeline(
  overrides: Partial<AssistantMessage>,
  opts: { answering?: boolean; suppressLive?: boolean } = {},
) {
  const turn: AssistantMessage = { ...emptyAssistant(), ...overrides };
  const user = userEvent.setup();
  render(
    <ChatTimeline
      turn={turn}
      answering={opts.answering ?? turn.answer.trim() !== ""}
      suppressLive={opts.suppressLive ?? false}
    />,
  );
  return { user };
}

const rail = () => screen.getByRole("region", { name: "What the assistant did" });
const fold = () => rail().querySelector("details")!;

beforeEach(() => {
  mockDownloadRequirement.mockReset();
  mockDownloadRequirement.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ChatTimeline — tool node statuses", () => {
  it("renders a successful call calmly, with the query it ran and what came back", () => {
    renderTimeline({
      toolCalls: [call("c1", "ok", { summary: "12 spans" })],
      done: true,
      answer: "Active recall means testing yourself.",
    });

    const node = within(rail()).getByRole("listitem");
    expect(within(node).getByText("Search notes")).toBeInTheDocument();
    expect(within(node).getByText("· active recall")).toBeInTheDocument();
    expect(within(node).getByText("· 12 spans")).toBeInTheDocument();
    // A call that did what it said is not news: no failure wording is attached.
    expect(node).not.toHaveTextContent(/failed|refused|denied/);
  });

  it("tells the orchestrator's refusal and the user's refusal apart", () => {
    renderTimeline({
      toolCalls: [
        call("c1", "rejected", { detail: "note not found: Missing.md" }),
        call("c2", "denied"),
      ],
      done: true,
      answer: "I couldn't do that.",
    });

    const [rejected, denied] = within(rail()).getAllByRole("listitem");
    // Who refused is the whole story, so the two never share wording.
    expect(rejected).toHaveTextContent("refused by NeuralNote");
    expect(rejected).not.toHaveTextContent("denied by you");
    expect(denied).toHaveTextContent("denied by you");
    expect(denied).not.toHaveTextContent("refused by NeuralNote");
  });

  it("never tells a user they denied something they were never shown", () => {
    // A prompt that expired, and a run that ended under an open sheet, are not
    // the user saying no. The gate has always distinguished them on the wire;
    // the orchestrator used to fold all three into `denied`, so the timeline
    // said "denied by you" to someone who was making a cup of tea.
    //
    // What goes red: map `timedOut` or `cancelled` back onto the `denied`
    // wording in TOOL_SETTLEMENT and the two `not.toHaveTextContent` assertions
    // below fail.
    renderTimeline({
      toolCalls: [call("c1", "timedOut"), call("c2", "cancelled"), call("c3", "denied")],
      done: true,
      answer: "I couldn't do that.",
    });

    const [timedOut, cancelled, denied] = within(rail()).getAllByRole("listitem");
    expect(timedOut).not.toHaveTextContent("denied by you");
    expect(cancelled).not.toHaveTextContent("denied by you");
    expect(denied).toHaveTextContent("denied by you");
    // And the two non-denials still say something, rather than settling
    // silently — a node that stops spinning with no account is the failure the
    // whole settlement vocabulary exists to prevent.
    expect(timedOut).toHaveTextContent(/expired/i);
    expect(cancelled).toHaveTextContent(/ended/i);
  });

  it("surfaces a failed call in the destructive register", () => {
    renderTimeline({
      toolCalls: [call("c1", "error", { detail: "the provider timed out" })],
      done: true,
      answer: "Something went wrong.",
    });

    const node = within(rail()).getByRole("listitem");
    expect(within(node).getByText("· failed")).toHaveClass("text-destructive");
  });

  it("opens a failure's detail on sight and leaves a success's folded", () => {
    renderTimeline({
      toolCalls: [
        call("c1", "ok", { summary: "12 spans", detail: "12 spans across 3 notes" }),
        call("c2", "rejected", { detail: "invalid search_notes arguments" }),
      ],
      done: true,
      answer: "Here you go.",
    });

    const [okNode, rejectedNode] = within(rail()).getAllByRole("listitem");
    // A reason the user has to click for is a reason they will not read.
    expect(within(rejectedNode).getByText("Details").closest("details")).toHaveAttribute("open");
    expect(within(rejectedNode).getByText("invalid search_notes arguments")).toBeInTheDocument();
    expect(within(okNode).getByText("Details").closest("details")).not.toHaveAttribute("open");
  });

  it("shows a call still in flight with no settled wording at all", () => {
    renderTimeline({ toolCalls: [call("c1", null)] });

    const node = within(rail()).getByRole("listitem");
    // Nothing has settled, so the arguments are all there is to say what it does.
    expect(within(node).getByText("· active recall")).toBeInTheDocument();
    expect(node).not.toHaveTextContent(/failed|refused|denied/);
  });

  it.each([
    ["unparseable", "{not json"],
    ["not an object", "[1,2,3]"],
    ["an object with no field worth showing", '{"max_results":8}'],
    ["an object whose only field is blank", '{"query":"   "}'],
  ])("shows no label at all when the arguments are %s", (_case, args) => {
    // The arguments are raw model output. Anything that is not a usable label is
    // dropped rather than printed: a JSON blob on the rail is worse than silence.
    renderTimeline({
      toolCalls: [call("c1", "ok", { arguments: args, title: "List folders" })],
      done: true,
      answer: "Done.",
    });

    const node = within(rail()).getByRole("listitem");
    expect(within(node).getByText("List folders")).toBeInTheDocument();
    expect(node).toHaveTextContent(/^List folders$/);
  });

  it("bounds an overlong argument label instead of letting it run away", () => {
    // A model writes its own search queries and will write two hundred
    // characters of them. Unbounded, one of those wraps over seven lines and
    // becomes the tallest thing on the rail — and now that no node is ever
    // dropped, this bound is the rail's only restraint.
    renderTimeline({
      toolCalls: [call("c1", null, { arguments: JSON.stringify({ query: "q".repeat(200) }) })],
    });

    const hint = within(rail()).getByText(/^· q+…$/);
    expect(hint.textContent).toBe(` · ${"q".repeat(64)}…`);
  });
});

describe("ChatTimeline — the fold head", () => {
  it("reads live while the run streams, and the fold is open", () => {
    renderTimeline({ phase: "searching", toolCalls: [call("c1", null)] });

    // Only the phase word is a live region; the tally would otherwise announce
    // on every node. Scoped to the fold rather than taken off the page: the
    // stall notice is a second, deliberate `role=status` sitting outside the
    // fold, so an unscoped query would collide with it and read as ambiguity in
    // the head.
    const phase = within(fold()).getByRole("status");
    expect(phase).toHaveTextContent("Searching your vault");
    expect(screen.getByText(/1 step/)).toHaveAttribute("aria-hidden", "true");
    expect(fold()).toHaveAttribute("open");
  });

  it("settles to one summary line and folds itself the moment the answer starts", () => {
    renderTimeline({
      phase: "verifying",
      toolCalls: [call("c1", "ok", { summary: "12 spans" })],
      activity: [
        { kind: "search", query: "active recall", hitCount: 3 },
        { kind: "reading", relPath: "Recall.md", startLine: 1, endLine: 9 },
        { kind: "verifying" },
      ],
      answer: "Active recall means testing yourself.",
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("1 tool · 1 search · 1 note · verified")).toBeInTheDocument();
    expect(fold()).not.toHaveAttribute("open");
  });

  it("stays open when there is something to act on, even after the answer starts", () => {
    renderTimeline({
      activity: [{ kind: "verifying" }, { kind: "dropped", reason: "quote not found" }],
      answer: "A partial answer.",
      done: true,
    });

    // Citation fidelity is the moat: a dropped citation is never one click away.
    expect(screen.getByText(/1 citation dropped/)).toHaveClass("text-destructive");
    expect(fold()).toHaveAttribute("open");
  });

  it("frames an errored run as Failed rather than as a completed summary", () => {
    renderTimeline({
      toolCalls: [call("c1", "ok", { summary: "0 spans" })],
      activity: [{ kind: "search", query: "quantum gravity" }],
      error: "the provider is unreachable",
      done: true,
    });

    expect(screen.getByText(/^Failed — /)).toBeInTheDocument();
    expect(fold()).toHaveAttribute("open");
  });

  it("renders nothing at all when the turn neither did nor is doing anything", () => {
    renderTimeline({ answer: "Hello — what would you like to explore?", done: true });

    expect(
      screen.queryByRole("region", { name: "What the assistant did" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the nodes but drops the spinner when a skill narrative owns the live view", () => {
    renderTimeline({ toolCalls: [call("c1", null)] }, { suppressLive: true });

    // No spinner may claim "Searching your vault" over a run that may be parked
    // on the user — but the calls it did dispatch still show.
    expect(screen.queryByText("Searching your vault")).not.toBeInTheDocument();
    expect(within(rail()).getByText("Search notes")).toBeInTheDocument();
  });
});

describe("ChatTimeline — the rail is the whole record", () => {
  it("keeps every dispatched node on the rail while the run is still streaming", () => {
    // The rail used to window down to the three freshest nodes while live, so a
    // dispatched call visibly VANISHED as the next one landed and only came back
    // after the run settled. A timeline that drops steps while they are
    // happening is not a timeline: it breaks the audit at the one moment the
    // user is watching it happen.
    renderTimeline({
      phase: "reading",
      toolCalls: Array.from({ length: 8 }, (_, i) =>
        call(`c${i}`, "ok", {
          title: "Read note",
          arguments: JSON.stringify({ rel_path: `Note-${i}.md` }),
          summary: `Note-${i}.md:1–4`,
        }),
      ),
    });

    expect(within(rail()).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByText(/8 steps/)).toBeInTheDocument();
    for (let i = 0; i < 8; i += 1) {
      expect(screen.getByText(`· Note-${i}.md:1–4`)).toBeInTheDocument();
    }
  });

  it("shows every node once settled, so the run stays auditable", async () => {
    const { user } = renderTimeline({
      toolCalls: Array.from({ length: 8 }, (_, i) =>
        call(`c${i}`, "ok", { summary: `${i} spans` }),
      ),
      answer: "An answer.",
      done: true,
    });

    await user.click(fold().querySelector("summary")!);
    expect(within(rail()).getAllByRole("listitem")).toHaveLength(8);
  });
});

describe("ChatTimeline — reasoning", () => {
  it("renders streamed reasoning as markdown, not as one flat string", async () => {
    const { user } = renderTimeline({
      thinking: "## Weighing it up\n\n- the note names chloroplasts\n- so the answer should too",
      answer: "Plants turn sunlight into sugar.",
      done: true,
    });

    await user.click(fold().querySelector("summary")!);
    const reasoning = screen.getByText("Reasoning", { selector: "summary" }).closest("details")!;
    expect(reasoning).not.toHaveAttribute("open");

    await user.click(within(reasoning).getByText("Reasoning"));
    // Structure survives: a heading is a heading and a list is a list.
    expect(
      within(reasoning).getByRole("heading", { name: "Weighing it up" }),
    ).toBeInTheDocument();
    expect(within(reasoning).getAllByRole("listitem")).toHaveLength(2);
  });

  it("adds no reasoning node when the model returned none", () => {
    renderTimeline({
      thinking: "   ",
      toolCalls: [call("c1", "ok", { summary: "1 span" })],
      answer: "An answer.",
      done: true,
    });

    expect(screen.queryByText("Reasoning", { selector: "summary" })).not.toBeInTheDocument();
  });
});

const failure = (missingBinary: string | null) => ({
  id: "youtube-distil",
  name: "YouTube distil",
  message: "Skill 'youtube-distil' could not be activated: yt-dlp is missing",
  missingBinary,
});

describe("ChatTimeline — skill activation failures", () => {
  it("offers the install remedy when the backend named a binary it can fetch", async () => {
    const { user } = renderTimeline({
      skillActivationFailures: [failure("yt-dlp")],
      done: true,
    });

    const card = within(rail()).getByRole("region", { name: "Set up YouTube imports" });
    await user.click(within(card).getByRole("button", { name: "Download yt-dlp" }));
    expect(mockDownloadRequirement).toHaveBeenCalledWith("yt-dlp", expect.any(Function));
    // The card states the problem and the fix, so the raw sentence would repeat
    // the problem directly above its own explanation.
    expect(screen.queryByText(/could not be activated/)).not.toBeInTheDocument();
  });

  it("states a failure with no structured remedy honestly, and offers no action", () => {
    renderTimeline({ skillActivationFailures: [failure(null)], done: true });

    expect(
      within(rail()).getByText(/Skill 'youtube-distil' could not be activated/),
    ).toHaveClass("text-destructive");
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });
});

const planStep = (id: string, label: string, status: StepStatus): PlanStepView => ({
  id,
  label,
  status,
});

describe("ChatTimeline — the declared plan", () => {
  it("nests each call beneath the step it was dispatched under", () => {
    // Fixture ids are known, and the assertion is which LABEL the node turned up
    // beneath. Reading a node's `stepId` back off the object that placed it
    // would compare a value against its own source and pass forever.
    renderTimeline({
      planSteps: [
        planStep("s1", "Find notes on spaced repetition", "done"),
        planStep("s2", "Read the two most relevant", "running"),
      ],
      toolCalls: [
        call("c1", "ok", { stepId: "s1", title: "Search notes" }),
        call("c2", "ok", { stepId: "s2", title: "Read note" }),
      ],
      done: true,
      answer: "Here you go.",
    });

    const finding = screen.getByText("Find notes on spaced repetition").closest("li")!;
    const reading = screen.getByText("Read the two most relevant").closest("li")!;
    expect(within(finding).getByText("Search notes")).toBeInTheDocument();
    expect(within(finding).queryByText("Read note")).not.toBeInTheDocument();
    expect(within(reading).getByText("Read note")).toBeInTheDocument();
  });

  it("leaves the call that declared the plan outside it", () => {
    // `stepId: null` is the ordinary case, not an edge one: the `update_plan`
    // call went out before the plan existed, so it belongs to no step and must
    // render exactly as every node did before plans existed.
    renderTimeline({
      planSteps: [planStep("s1", "Find notes on spaced repetition", "running")],
      toolCalls: [
        call("c0", "ok", { stepId: null, title: "Update plan" }),
        call("c1", null, { stepId: "s1", title: "Search notes" }),
      ],
    });

    const step = screen.getByText("Find notes on spaced repetition").closest("li")!;
    expect(within(step).queryByText("Update plan")).not.toBeInTheDocument();
    expect(within(rail()).getByText("Update plan")).toBeInTheDocument();
  });

  it("tells a step it chose to skip from one that went wrong", () => {
    // Two accounts of the same missing work, and only one of them is a problem.
    // Every step here carries the SAME label, so the label cannot be what makes
    // the rows distinct — the status wording has to. Re-collapse `skipped` and
    // `failed` onto one phrase and the set below drops to four.
    const statuses: StepStatus[] = ["pending", "running", "done", "skipped", "failed"];
    renderTimeline({
      planSteps: statuses.map((status, i) => planStep(`s${i}`, "Do the thing", status)),
      done: true,
      answer: "Done.",
    });

    const texts = within(rail())
      .getAllByRole("listitem")
      .map((node) => node.textContent);
    expect(new Set(texts).size).toBe(5);

    // Pinned as literals, and in different registers: a step the model ruled
    // out is not a step that broke.
    const skipped = screen.getByText("· skipped as unnecessary");
    const failed = screen.getByText("· did not work");
    expect(skipped).toHaveClass("text-muted-foreground/60");
    expect(failed).toHaveClass("text-warning");
  });

  it("says where a step has got to even when nothing visible carries it", () => {
    // The glyph column is the whole signal for the three quiet statuses, and a
    // screen reader cannot see it.
    renderTimeline({
      planSteps: [
        planStep("s1", "Find the notes", "done"),
        planStep("s2", "Read them", "running"),
        planStep("s3", "Draft the summary", "pending"),
      ],
      done: true,
      answer: "Done.",
    });

    expect(screen.getByText("Find the notes").closest("li")).toHaveTextContent(
      "Done: Find the notes",
    );
    expect(screen.getByText("Read them").closest("li")).toHaveTextContent(
      "In progress: Read them",
    );
    expect(screen.getByText("Draft the summary").closest("li")).toHaveTextContent(
      "Not started: Draft the summary",
    );
  });

  it("holds the fold open when a declared step could not be completed", () => {
    // A failed step says the run did less than the answer above it implies, and
    // nothing else on screen says so.
    renderTimeline({
      planSteps: [planStep("s1", "Read the source", "failed")],
      done: true,
      answer: "Here is what I could find.",
    });

    expect(fold()).toHaveAttribute("open");
  });

  it("renders a turn with no plan exactly as it did before plans existed", () => {
    renderTimeline({
      toolCalls: [call("c1", "ok", { summary: "12 spans" })],
      done: true,
      answer: "An answer.",
    });

    // One node, no step rows, nothing announced about a plan.
    expect(within(rail()).getAllByRole("listitem")).toHaveLength(1);
    expect(rail()).not.toHaveTextContent(/Not started|In progress|Done:/);
  });
});

describe("formatArguments — the widened disclosure's left column", () => {
  it("indents a payload that parses", () => {
    expect(formatArguments('{"query":"recall","max_results":8}')).toBe(
      '{\n  "query": "recall",\n  "max_results": 8\n}',
    );
  });

  it.each([
    ["truncated by a cut-off stream", '{"query":"rec'],
    ["not JSON at all", "search notes for recall"],
    ["empty", ""],
  ])("shows a payload %s exactly as it arrived", (_case, raw) => {
    // Raw model output. Anything unparseable is displayed verbatim rather than
    // repaired into something the model never sent.
    expect(formatArguments(raw)).toBe(raw);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The honest live head: how far through, how long, and what it is working on.
//
// Every case here is a state transition at an explicit clock reading. Nothing
// waits on wall time and nothing asserts a duration — the properties under test
// are which sentence is on screen, and who is allowed to hear it.
// ─────────────────────────────────────────────────────────────────────────────

const RUN_START = 1_000_000;

/** A live turn whose first event landed at `RUN_START`, rendered straight (no
 *  `userEvent`, which needs its own fake-timer arrangement and is not the
 *  subject of anything below). */
function renderLiveHead(overrides: Partial<AssistantMessage> = {}) {
  const turn: AssistantMessage = {
    ...emptyAssistant(),
    startedAt: RUN_START,
    lastEventAt: RUN_START,
    lastAliveAt: RUN_START,
    ...overrides,
  };
  const view = render(
    <ChatTimeline turn={turn} answering={false} suppressLive={false} />,
  );
  const rerenderWith = (next: Partial<AssistantMessage>) =>
    view.rerender(
      <ChatTimeline
        turn={{ ...turn, ...next }}
        answering={false}
        suppressLive={false}
      />,
    );
  return { rerenderWith };
}

/** The always-mounted stall slot: the section's trailing element. */
const stallSlot = () => rail().lastElementChild as HTMLElement;

describe("ChatTimeline — how far through the run is", () => {
  it("pairs the round with the ceiling it is actually measured against", () => {
    renderLiveHead({ phase: "planning", round: { current: 3, max: 8 } });

    // The round churns as often as the node tally does, and for the same reason
    // it must not announce: the head would otherwise read itself out eight times
    // over a run nobody asked to have narrated.
    expect(screen.getByText("· round 3 of 8")).toHaveAttribute("aria-hidden", "true");
  });

  it("measures a playlist in videos, and drops the round's ceiling while it runs", () => {
    // The whole point of the playlist denominator. `max` is the iteration
    // ceiling, which a playlist deliberately runs past — three videos reach ~24
    // rounds under a cap of 16 — so a head that used to be able to say
    // `round 17 of 16` now shows the one denominator that cannot move.
    renderLiveHead({
      phase: "planning",
      round: { current: 17, max: 16 },
      playlist: { position: 2, total: 3 },
    });

    expect(within(fold()).getByRole("status")).toHaveTextContent(
      "Planning · Video 2 of 3",
    );
    expect(screen.getByText("· round 17")).toBeInTheDocument();
    expect(screen.queryByText(/of 16/)).not.toBeInTheDocument();
  });

  it("announces the video but never the round", () => {
    // The item changes once per video against a fixed total, so it is worth
    // hearing. Everything in the counter cluster is churn and stays silent.
    renderLiveHead({
      phase: "planning",
      round: { current: 4, max: 16 },
      playlist: { position: 2, total: 3 },
    });

    const head = within(fold()).getByRole("status");
    expect(within(head).getByText("· Video 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("· round 4")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps one work counter, not two: the round replaces the node tally", () => {
    // Both answer "how much has this run got through". The round wins wherever
    // it exists because it arrives with a denominator, and showing both would
    // put two churning numbers in a head that has to stay one line.
    renderLiveHead({
      phase: "planning",
      round: { current: 2, max: 8 },
      toolCalls: [call("c1", null), call("c2", null)],
    });

    expect(screen.getByText("· round 2 of 8")).toBeInTheDocument();
    expect(screen.queryByText(/steps/)).not.toBeInTheDocument();
  });

  it("falls back to the node tally before the first planning beacon", () => {
    renderLiveHead({ phase: "sending", toolCalls: [call("c1", null)] });

    expect(screen.getByText(/· 1 step/)).toBeInTheDocument();
  });
});

describe("ChatTimeline — the run clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks once a second and stays out of the live region beside it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_START);
    renderLiveHead({ phase: "planning", round: { current: 1, max: 8 } });

    expect(screen.getByText("· 0s")).toHaveAttribute("aria-hidden", "true");

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    // A per-second readout inside a focusable summary would rewrite that
    // control's accessible name every tick. The clock is for the eye; the stall
    // notice is the thing that speaks.
    expect(screen.getByText("· 3s")).toHaveAttribute("aria-hidden", "true");
    const head = within(fold()).getByRole("status");
    expect(head).toHaveTextContent("Planning");
    expect(head).not.toHaveTextContent("3s");
  });

  it("takes the settled shape once there is a minute to report", () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_START);
    renderLiveHead({ phase: "planning" });

    act(() => {
      vi.advanceTimersByTime(125_000);
    });

    // The same `2m 05s` shape `formatElapsed` gives the settled figure, so the
    // live readout and the record it hands over read as one thing.
    expect(screen.getByText("· 2m 05s")).toBeInTheDocument();
  });

  it("shows no clock at all before the run's first event", () => {
    // Zero would report a measurement of a run that has taken no time. Nothing
    // has been measured yet, which is a different statement.
    render(
      <ChatTimeline turn={emptyAssistant()} answering={false} suppressLive={false} />,
    );

    expect(screen.queryByText(/^· \d+s$/)).not.toBeInTheDocument();
  });
});

describe("ChatTimeline — the stall notice", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reserves its line from the start of the run and says nothing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_START);
    renderLiveHead({ phase: "planning" });

    const slot = stallSlot();
    expect(slot.tagName).toBe("OUTPUT");
    expect(slot).toBeEmptyDOMElement();
    // Mounted empty rather than inserted with its text: a live region that
    // arrives together with its content is often skipped, and the reserved line
    // means the notice appearing moves nothing under it.
    expect(screen.getAllByRole("status")).toContain(slot);
    expect(slot).toHaveClass("min-h-[1.375em]");
  });

  it("says the provider has gone quiet once nothing at all has arrived", () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_START);
    renderLiveHead({ phase: "planning" });

    act(() => {
      vi.advanceTimersByTime(STALL_AFTER_MS);
    });

    // Not a countdown and not a failure. The approval sheet renders its expiry
    // once and never ticks it, because a counting-down prompt manufactures
    // urgency; this is the same ruling applied to a slow run.
    expect(stallSlot()).toHaveTextContent(
      "The model has been quiet for a while.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("tells a slow model apart from a silent provider", () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_START);
    // Keepalives are still arriving: the connection is fine and the model is
    // taking its time. A keepalive is not progress, so it cannot clear the
    // notice — but it does change which sentence the notice makes.
    renderLiveHead({ phase: "planning", lastAliveAt: RUN_START + STALL_AFTER_MS });

    act(() => {
      vi.advanceTimersByTime(STALL_AFTER_MS);
    });

    expect(stallSlot()).toHaveTextContent(
      "Still working. Nothing new for a while.",
    );
    expect(stallSlot()).not.toHaveTextContent("The run is still open.");
  });

  it("clears itself on the next real event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_START);
    const { rerenderWith } = renderLiveHead({ phase: "planning" });

    act(() => {
      vi.advanceTimersByTime(STALL_AFTER_MS);
    });
    expect(stallSlot()).not.toBeEmptyDOMElement();

    rerenderWith({
      phase: "searching",
      lastEventAt: Date.now(),
      lastAliveAt: Date.now(),
    });

    expect(stallSlot()).toBeEmptyDOMElement();
  });

  it("keeps no slot at all once the run has settled", () => {
    render(
      <ChatTimeline
        turn={{
          ...emptyAssistant(),
          done: true,
          startedAt: RUN_START,
          lastEventAt: RUN_START,
          toolCalls: [call("c1", "ok")],
        }}
        answering
        suppressLive={false}
      />,
    );

    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });
});

describe("ChatTimeline — the video preview card", () => {
  const preview = {
    videoId: "dQw4w9WgXcQ",
    title: "Deep work and the shape of an afternoon",
    durationSecs: 742,
    channel: "Sarah Chen",
    thumbnailDataUri: null,
  };

  it("reads as a finished card with no image, because that is the path that ships", () => {
    // The thumbnail fetch lands in a later phase and is capped and timed out
    // even then, so `null` is both the only state reachable today and the
    // permanent degraded one. Nothing here is phrased as a missing picture.
    renderLiveHead({
      phase: "planning",
      playlist: { position: 2, total: 3 },
      videoPreview: preview,
    });

    expect(
      screen.getByText("Deep work and the shape of an afternoon"),
    ).toBeInTheDocument();
    expect(screen.getByText("Video 2 of 3 · Sarah Chen · 12:22")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(/thumbnail|unavailable|failed/i)).not.toBeInTheDocument();
  });

  it("holds its place between playlist items rather than blinking out", () => {
    // The reducer retires a preview the moment a beacon names a different item,
    // so there is a real gap before the next one arrives. A card bound to the
    // preview would unmount and remount across it; this one changes its contents
    // and keeps its footprint.
    renderLiveHead({
      phase: "planning",
      playlist: { position: 3, total: 3 },
      videoPreview: null,
    });

    expect(screen.getByText("Waiting for the video details")).toBeInTheDocument();
    expect(screen.getByText("Video 3 of 3")).toBeInTheDocument();
  });

  it("shows the thumbnail as decoration, never as the card's meaning", () => {
    renderLiveHead({
      phase: "planning",
      playlist: { position: 1, total: 2 },
      videoPreview: { ...preview, thumbnailDataUri: "data:image/webp;base64,AAAA" },
    });

    // `alt=""` on purpose: the title beside it is the accessible content, and a
    // described thumbnail would add nothing a reader can use.
    expect(screen.getByAltText("")).toHaveAttribute(
      "src",
      "data:image/webp;base64,AAAA",
    );
    expect(
      screen.getByText("Deep work and the shape of an afternoon"),
    ).toBeInTheDocument();
  });

  it("drops a fact the extractor did not report rather than inventing a zero", () => {
    renderLiveHead({
      phase: "planning",
      playlist: { position: 1, total: 2 },
      videoPreview: { ...preview, durationSecs: null, channel: null },
    });

    expect(screen.getByText("Video 1 of 2")).toBeInTheDocument();
    expect(screen.queryByText(/0:00/)).not.toBeInTheDocument();
  });

  it("reports a zero-length extraction as absent, not as a measured 0:00", () => {
    renderLiveHead({
      phase: "planning",
      playlist: { position: 1, total: 2 },
      videoPreview: { ...preview, durationSecs: 0 },
    });

    expect(screen.getByText("Video 1 of 2 · Sarah Chen")).toBeInTheDocument();
  });

  it("writes an hour-long video the way a player does", () => {
    renderLiveHead({
      phase: "planning",
      playlist: { position: 1, total: 2 },
      videoPreview: { ...preview, durationSecs: 3_735 },
    });

    expect(screen.getByText("Video 1 of 2 · Sarah Chen · 1:02:15")).toBeInTheDocument();
  });

  it("stays out of the way when no video is in flight", () => {
    renderLiveHead({ phase: "searching", toolCalls: [call("c1", null)] });

    expect(screen.queryByText("Waiting for the video details")).not.toBeInTheDocument();
  });

  it("makes way for the answer once it starts streaming", () => {
    render(
      <ChatTimeline
        turn={{
          ...emptyAssistant(),
          startedAt: RUN_START,
          lastEventAt: RUN_START,
          playlist: { position: 2, total: 3 },
          videoPreview: preview,
          answer: "Here is what the videos said.",
        }}
        answering
        suppressLive={false}
      />,
    );

    expect(
      screen.queryByText("Deep work and the shape of an afternoon"),
    ).not.toBeInTheDocument();
  });
});
