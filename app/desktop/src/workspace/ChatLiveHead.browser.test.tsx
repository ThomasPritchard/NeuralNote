// Real-browser proof that the live head and the video preview card hold their
// footprint while a run changes underneath them.
//
// jsdom cannot answer any of this. It has no layout engine, so every
// `getBoundingClientRect()` there is a rect of zeros — which makes "the card is
// the same height with and without a thumbnail" trivially true against the fix
// AND against a card that reflows by forty pixels. Here the real Tailwind v4
// pipeline resolves `aspect-video`, `line-clamp-2`, `truncate` and the reserved
// stall line exactly as the shipped webview does.
//
// The measurements are taken at the docked pane's own content width, derived
// from the tokens rather than guessed: `--chat-width`'s floor is 26.25rem, the
// transcript pads it `px-4`, the turn `px-3` inside a 1px border, and the
// timeline fold `px-2.5`. That leaves the head 342px.
//
// That is the width of the FLOOR of the base token, and it is not the narrowest
// the pane is ever laid out: `styles.css` narrows `--chat-width` to 25.5rem at
// ≤1280px — the app's own default window — and further below that. `HEAD_WIDTH`
// is left where it is because the footprint assertions below are equalities
// between two mounts and hold at any width, while `TOOL_LINE_WIDTH` measures a
// WRAP, which appears at one width and not another. A wrap defect that survived
// review is what that distinction costs when it is not made.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../styles.css";
import { ChatTimeline } from "./ChatTimeline";
import {
  emptyAssistant,
  type AssistantMessage,
  type ToolCallView,
} from "./chatMessage";
import { STALL_AFTER_MS } from "./turnLiveness";

/** 26.25rem − 2×16 (transcript) − 2×12 (turn) − 2×1 (border) − 2×10 (fold). */
const HEAD_WIDTH = 342;

/** The same chain at the `--chat-width` the app's own default window resolves
 *  (25.5rem, the ≤1280px tier): 408 − 32 − 24 − 2 = 350, and the fold's `px-2.5`
 *  is left on because this host renders the fold itself. Inside it a tool node's
 *  line gets 268px — 330 − 2 (fold border) − 20 (`px-2.5`) − 18 (the rail's
 *  `pl-[18px]`) − 22 (glyph + `gap-2`) — and 268 is where the title line wraps. */
const DOCKED_HOST_WIDTH = 330;
const TOOL_LINE_WIDTH = 268;

const mounted: Array<{ host: HTMLElement; root: Root }> = [];

beforeEach(() => {
  mounted.length = 0;
});

afterEach(() => {
  for (const { host, root } of mounted) {
    act(() => root.unmount());
    host.remove();
  }
  mounted.length = 0;
});

/** Mount one live turn in its OWN root and hand back the pieces worth
 *  measuring.
 *
 *  A fresh root per turn, not a re-render of one: `useTurnLiveness` seeds its
 *  clock in a `useState` initialiser, which runs once per mount. Re-rendering
 *  a second turn into the same root hands it the FIRST turn's reading of `now`,
 *  and a case that feeds a past `lastEventAt` then measures a threshold against
 *  a clock captured a millisecond too early — green or red depending on which
 *  side of a millisecond boundary the two `Date.now()` calls landed. */
function mount(overrides: Partial<AssistantMessage>, width = HEAD_WIDTH) {
  const host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ host, root });

  const now = Date.now();
  const turn: AssistantMessage = {
    ...emptyAssistant(),
    startedAt: now,
    lastEventAt: now,
    lastAliveAt: now,
    ...overrides,
  };
  act(() => {
    root.render(
      <ChatTimeline turn={turn} answering={false} suppressLive={false} />,
    );
  });
  const section = host.querySelector("section")!;
  return {
    section,
    summary: section.querySelector("summary")!,
    /** The preview card: the fold's first non-summary child. */
    card: section.querySelector("details > div") as HTMLElement | null,
    /** The reserved stall line: the section's trailing element. */
    slot: section.lastElementChild as HTMLElement,
    /** The rail's own nodes, top-level only (a plan step nests its own). */
    nodes: [...section.querySelectorAll<HTMLElement>("ol > li")],
  };
}

const height = (el: Element) => el.getBoundingClientRect().height;

describe("the live head holds one line", () => {
  it("is the same height empty as it is carrying everything it can carry", () => {
    // A head that wrapped onto a second line when the playlist pair or the
    // round appeared would push the whole transcript down mid-run — which is
    // the one thing a live region under a user's eye must never do.
    const bare = height(mount({ phase: "sending" }).summary);

    const loaded = mount({
      phase: "searching",
      round: { current: 24, max: 16 },
      playlist: { position: 12, total: 30 },
      toolCalls: Array.from({ length: 9 }, (_, i) => ({
        id: `c${i}`,
        name: "search_notes",
        title: "Search notes",
        arguments: "{}",
        status: null,
        summary: null,
        detail: null,
        stepId: null,
      })),
    }).summary;

    expect(height(loaded)).toBe(bare);
    // One line of the head's own type, not two.
    expect(height(loaded)).toBeLessThan(24);
  });

  it("never lets the head overflow the pane it is laid out in", () => {
    const { summary } = mount({
      phase: "searching",
      round: { current: 24, max: 16 },
      playlist: { position: 12, total: 30 },
    });

    expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth);
  });
});

describe("the video preview card reserves the thumbnail's footprint", () => {
  const base = {
    videoId: "dQw4w9WgXcQ",
    title: "Deep work and the shape of an afternoon",
    durationSecs: 742,
    channel: "Sarah Chen",
  };
  const playlist = { position: 2, total: 3 };

  /** A real 16:9 image, so the with-image case measures a decoded picture and
   *  not a broken-image placeholder. */
  const THUMBNAIL =
    "data:image/svg+xml;base64," +
    btoa('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"/>');

  it("is the same height with a thumbnail as without one", () => {
    // The fetch that fills this lands in a later phase and is capped and timed
    // out even then, so the text-only card is both today's only state and the
    // permanent degraded one. It has to be the card's real size, not a smaller
    // one that grows when a picture turns up.
    const withoutImage = height(
      mount({
        phase: "planning",
        playlist,
        videoPreview: { ...base, thumbnailDataUri: null },
      }).card!,
    );
    const withImage = height(
      mount({
        phase: "planning",
        playlist,
        videoPreview: { ...base, thumbnailDataUri: THUMBNAIL },
      }).card!,
    );

    expect(withImage).toBe(withoutImage);
  });

  it("is the same height before the details arrive as after", () => {
    // The reducer retires a preview the moment a beacon names a different
    // playlist item, so this transition happens between every video in a run.
    const waiting = height(
      mount({ phase: "planning", playlist, videoPreview: null }).card!,
    );
    const arrived = height(
      mount({
        phase: "planning",
        playlist,
        videoPreview: { ...base, thumbnailDataUri: null },
      }).card!,
    );

    expect(arrived).toBe(waiting);
  });

  it("is the same height under a title long enough to clamp", () => {
    const short = height(
      mount({
        phase: "planning",
        playlist,
        videoPreview: { ...base, title: "Focus", thumbnailDataUri: null },
      }).card!,
    );
    const clamped = height(
      mount({
        phase: "planning",
        playlist,
        videoPreview: {
          ...base,
          title:
            "Deep work, shallow work, and every argument about the shape of an " +
            "afternoon that anyone has ever had on the internet, in one sitting",
          thumbnailDataUri: null,
        },
      }).card!,
    );

    expect(clamped).toBe(short);
  });
});

/** One tool node, with just enough of a call to lay out. `arguments` carries no
 *  hint field on purpose: the title line then reads the same in flight as it
 *  does settled, which is what leaves the SECOND row as the only variable in
 *  the measurements below. */
function toolCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "c1",
    name: "transcribe_audio",
    title: "Transcribe audio",
    arguments: "{}",
    status: null,
    summary: null,
    detail: null,
    stepId: null,
    ...overrides,
  };
}

/** The longest line the shipped tools send (`youtube_tools.rs`) — 84 characters
 *  against a ~300px column, so it is also the one that would wrap if the row
 *  were not clipped to a single line. */
const WHISPER_PROGRESS =
  "Transcribing the audio locally with Whisper (base.en); this can take several minutes";

describe("a running tool's progress line holds the footprint it hands over", () => {
  it("does not move the node when a long tool finally says something", () => {
    // Amendment C1's whole point is that a four-minute transcription stops
    // being a silent spinner. The line arriving mid-run must cost nothing: this
    // is the class of bug Phase 2 hit twice, and jsdom cannot see it — every
    // rect there is zero, so "the node did not move" is trivially true against
    // the fix AND against a node that grew by fifteen pixels.
    const silent = mount({ phase: "planning", toolCalls: [toolCall()] });
    const quietNode = height(silent.nodes[0]);
    const quietSection = height(silent.section);

    const narrating = mount({
      phase: "planning",
      toolCalls: [toolCall({ progress: WHISPER_PROGRESS })],
    });

    expect(narrating.nodes[0].textContent).toContain("Whisper");
    expect(height(narrating.nodes[0])).toBe(quietNode);
    expect(height(narrating.section)).toBe(quietSection);
    // And the reservation is a real line rather than a collapsed nothing: an
    // empty block has no line box, so this would be the whole fix failing.
    expect(quietNode).toBeGreaterThan(24);
  });

  it("clips the longest line to one rather than wrapping the rail", () => {
    const { nodes } = mount({
      phase: "planning",
      toolCalls: [toolCall({ progress: WHISPER_PROGRESS })],
    });
    const line = [...nodes[0].querySelectorAll<HTMLElement>("p")].find((p) =>
      p.textContent?.startsWith("Transcribing"),
    )!;

    // One line of its own type. Two lines would read better and would cost the
    // footprint guarantee above, which is the trade this makes deliberately.
    expect(height(line)).toBeLessThan(20);
    // The tail is clipped, not discarded — the whole sentence is still there.
    expect(line.title).toBe(WHISPER_PROGRESS);
    expect(line.scrollWidth).toBeGreaterThan(line.clientWidth);
  });

  it("is the same height running as it is once the call has settled", () => {
    // The two states share one slot, so a node holds its footprint from
    // dispatch through settlement. Before this the in-flight node was one row
    // and the settled one was two, which grew the rail a line at EVERY
    // settlement under a live run.
    const running = mount({ phase: "planning", toolCalls: [toolCall()] });
    const settled = mount({
      phase: "planning",
      toolCalls: [toolCall({ status: "ok", detail: "12 spans across 3 notes" })],
    });

    expect(settled.nodes[0].textContent).toContain("Details");
    expect(height(settled.nodes[0])).toBe(height(running.nodes[0]));
  });
});

describe("a settled node breaks between its parts, never inside one", () => {
  /** One line of the rail's own type: 0.6875rem at `leading-snug` = 15.125.
   *
   *  It is exactly that, and not the taller box a mixed-font line produces,
   *  precisely BECAUSE each part is its own inline-block: the mono run's ascent
   *  and descent are resolved inside its own box instead of stretching the line
   *  it sits on. */
  const LINE = 15.125;

  /** The title line of the first node, at the width the wrap appears at. */
  function titleLine(call: Partial<ToolCallView>) {
    const { nodes } = mount(
      { phase: "planning", toolCalls: [toolCall({ title: "Search notes", ...call })] },
      DOCKED_HOST_WIDTH,
    );
    return nodes[0].querySelector("p")!;
  }

  it("keeps a summary whole instead of orphaning its last word", () => {
    // The reported line, verbatim: at 268px this read
    // `Search notes · spaced repetition · 12` / `spans`, with the summary's own
    // last word alone on the second line. The break belongs before the `·`.
    const line = titleLine({
      status: "ok",
      summary: "12 spans",
      arguments: JSON.stringify({ query: "spaced repetition" }),
    });

    expect(line.getBoundingClientRect().width).toBeCloseTo(TOOL_LINE_WIDTH, 0);
    const summary = [...line.querySelectorAll("span")].find((span) =>
      span.textContent?.startsWith("· 12 spans"),
    )!;
    // One line of its own, wherever it landed — a part that fits nowhere on the
    // line it started on moves whole rather than splitting.
    expect(summary.getBoundingClientRect().height).toBeCloseTo(LINE, 1);
  });

  it("keeps a two-word settlement whole too", () => {
    // `refused by NeuralNote` and `run ended first` are the same shape as the
    // summary and would orphan the same way; they are also the lines a user
    // reads most carefully.
    const line = titleLine({
      status: "rejected",
      summary: "12 spans",
      arguments: JSON.stringify({ query: "spaced repetition" }),
    });

    const label = [...line.querySelectorAll("span")].find((span) =>
      span.textContent?.startsWith("· refused"),
    )!;
    expect(label.getBoundingClientRect().height).toBeCloseTo(LINE, 1);
  });

  it("reads the same as it always did, one space between the parts", () => {
    // The separator travels with the part it introduces and the space before it
    // stays outside, so the sentence is unchanged — the fix is where the line
    // may break, not what it says.
    const line = titleLine({
      status: "ok",
      summary: "12 spans",
      arguments: JSON.stringify({ query: "spaced repetition" }),
    });

    expect(line.textContent).toBe("Search notes · spaced repetition · 12 spans");
  });

  it("wraps a summary longer than the column instead of scrolling the pane", () => {
    // The trap in the obvious fix. `whitespace-nowrap` keeps the part whole and
    // pushes the pane into horizontal scroll the first time a note name runs
    // past the column — ablated, this case goes red exactly that way.
    //
    // The name has no hyphen, slash, dot or space in it on purpose: those are
    // all break opportunities, and a fixture carrying one wraps under any
    // setting and would prove nothing. This one can only be broken by
    // `overflow-wrap`, which is also the only thing that keeps the box's
    // MIN-CONTENT width inside the column.
    const line = titleLine({
      status: "ok",
      summary: "SpacedRepetitionAndTheForgettingCurveInPracticeAnnotated",
      arguments: JSON.stringify({ query: "spaced repetition" }),
    });

    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    // And it really is longer than one line — otherwise the case above proves
    // nothing about a part that has to break inside itself.
    expect(line.getBoundingClientRect().height).toBeGreaterThan(2 * LINE);
  });

  it("keeps a plan step's own verdict whole as well", () => {
    // The same anatomy one level up, and the same defect: a model-written step
    // label runs to the column edge and the step's account — "skipped as
    // unnecessary", "did not work" — breaks across two lines of it. Fixing the
    // cited line and leaving its sibling would be fixing the instance.
    const { nodes } = mount(
      {
        phase: "planning",
        planSteps: [
          {
            id: "s1",
            label: "Check whether the vault already has notes on this",
            status: "skipped",
          },
        ],
      },
      DOCKED_HOST_WIDTH,
    );
    const account = [...nodes[0].querySelectorAll("span")].find((span) =>
      span.textContent?.startsWith("· skipped"),
    )!;

    expect(account.getBoundingClientRect().height).toBeCloseTo(LINE, 1);
    expect(nodes[0].querySelector("p")!.textContent).toBe(
      "Check whether the vault already has notes on this · skipped as unnecessary",
    );
  });

  it("does not move the line the user was already reading", () => {
    // A settled node is not transient, but it sits above every node dispatched
    // after it: a part that changed the line COUNT would push the rest of the
    // rail down. One line before, one line after.
    const short = titleLine({ status: "ok", summary: "12 spans" });

    expect(short.getBoundingClientRect().height).toBeCloseTo(LINE, 1);
  });
});

describe("the stall notice occupies the line it reserved", () => {
  it("does not move the run when it appears", () => {
    // Fed a past `lastEventAt` rather than waited for: the notice is a
    // threshold crossing, and the threshold is arithmetic over timestamps.
    const quiet = mount({ phase: "planning" });
    const emptySlot = height(quiet.slot);
    const emptySection = height(quiet.section);

    // A second past the threshold, not exactly on it. Where the boundary
    // itself falls is `turnLiveness`'s own contract and is asserted there to
    // the millisecond; what this case needs is a turn that is unambiguously
    // stalled so the measurement is of the LAYOUT, not of the threshold.
    const quietFor = STALL_AFTER_MS + 1_000;
    const stalled = mount({
      phase: "planning",
      startedAt: Date.now() - quietFor,
      lastEventAt: Date.now() - quietFor,
      lastAliveAt: Date.now() - quietFor,
    });

    expect(stalled.slot.textContent).toContain("quiet for a while");
    expect(height(stalled.slot)).toBe(emptySlot);
    expect(height(stalled.section)).toBe(emptySection);
    // And the reservation is a real line, not a collapsed nothing.
    expect(emptySlot).toBeGreaterThan(10);
  });
});
