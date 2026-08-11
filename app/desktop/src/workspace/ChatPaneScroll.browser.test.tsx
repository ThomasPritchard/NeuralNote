// Real-browser proof of the chat transcript's scroll-follow (issue #109).
//
// This is the test the phase exists for. Scroll-follow is geometric: it is a
// running argument about `scrollHeight`, `scrollTop` and `clientHeight`, and
// jsdom has none of them — every one reads zero there, so a jsdom suite can be
// completely green while the pane never moves a pixel. `useStickyScroll.test.tsx`
// proves the DECISIONS against a stubbed layout; only this file proves the pane
// actually scrolls.
//
// It runs the real <ChatTranscript/> in headless Chromium with the app's real
// Tailwind pipeline, inside a host sized like the docked pane, and drives it the
// way a user does: a keyboard scroll (which also proves the region is reachable
// by keyboard at all), a click on the jump control, a click on a real activity
// disclosure.
//
// The disclosure case is the one that only a real engine could have caught.
// Chromium's scroll anchoring is `auto` by default and anchors BELOW the
// inserted content, so opening a fold shoves the summary the user just clicked
// ~85px up the pane before any of our code runs — and the `toggle` event lands
// after both the layout change and the ResizeObserver delivery, too late to
// stop it. Hence the assertion below is on the summary's SCREEN POSITION, not
// on `scrollTop`: "did the view move" is a question about pixels.
//
// One caveat the Definition of Done insists on: Chromium is not WKWebView, which
// has no scroll anchoring at all. A green run here still owes a hands-on check
// in a real build.
//
// And the caveat has teeth. The last test in this file is red in WebKit and
// green in Chromium against the SAME broken hook: the bug is a `scroll` event
// the engine defers past the next commit, and Chromium does not defer it. So
// `test:browser` (Chromium) certifies that defect as absent. Both engines are in
// the CI matrix; `test:browser:webkit` is the lane that lane's evidence lives in.

import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { act } from "react";
import { ChatTranscript } from "./ChatTranscript";
import {
  emptyAssistant,
  type AssistantMessage,
  type ChatMessage,
  type NoteEditView,
  type ToolApprovalView,
  type ToolCallView,
} from "./chatMessage";
import "../styles.css";

/** Roughly the docked pane's shipped width (`--chat-width`). */
const PANE_WIDTH_PX = 440;
const PANE_HEIGHT_PX = 360;
/** The hook's own tolerance — mirrored here, not tightened. */
const BOTTOM_THRESHOLD_PX = 8;

/** A settled turn whose activity trace is long enough to collapse behind a
 *  `<details>` (>2 grouped steps) and whose summary defaults to CLOSED (it read
 *  notes and dropped no citation), so the test has a fold to expand. */
function settledTurn(n: number, sentences: number): AssistantMessage {
  return {
    ...emptyAssistant(false, `turn-${n}`),
    activity: [
      { kind: "search", query: `spaced repetition ${n}`, hitCount: 12 },
      { kind: "reading", relPath: `Zettelkasten/Retrieval-${n}.md`, startLine: 12, endLine: 28 },
      { kind: "reading", relPath: `Notes/Recall-${n}.md`, startLine: 3, endLine: 40 },
      { kind: "verifying" },
    ],
    answer: Array.from(
      { length: sentences },
      (_, i) => `Answer ${n}.${i + 1}: retrieval practice beats rereading, reliably.`,
    ).join(" "),
    done: true,
  };
}

/** `turns` complete turns, the last one's answer grown to `tailSentences` —
 *  which is how an answer STREAMS: more content, the same number of messages,
 *  so nothing here is secretly testing the new-turn re-pin instead. */
function transcript(turns: number, tailSentences = 1): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let n = 1; n <= turns; n += 1) {
    messages.push(
      { role: "user", content: `Question ${n}?` },
      settledTurn(n, n === turns ? tailSentences : 1),
    );
  }
  return messages;
}

/** One dispatched, still-in-flight tool call carrying the kind of verbose,
 *  model-written argument a real run produces. The marker leads the string so it
 *  survives the hint's character bound, which is what lets a test name the node
 *  it is looking for. */
function inFlightCall(n: number): ToolCallView {
  return {
    id: `call-${n}`,
    name: "search_notes",
    title: "Search notes",
    arguments: JSON.stringify({
      query: `marker-${n} nested lists inside lists hierarchy sublevels indented bulleted numbered subsections subitems parent child items`,
    }),
    status: null,
    summary: null,
    detail: null,
  };
}

/** A turn mid-run: `steps` dispatched calls and an answer of `answerSentences`
 *  sentences (0 = the answer has not started, so the process rail is open and
 *  carrying the live view). */
function liveTurn(steps: number, answerSentences: number): AssistantMessage {
  return {
    ...emptyAssistant(false, "turn-live"),
    phase: "reading",
    toolCalls: Array.from({ length: steps }, (_, i) => inFlightCall(i)),
    answer: Array.from(
      { length: answerSentences },
      (_, i) => `Answer ${i + 1}: retrieval practice beats rereading, reliably.`,
    ).join(" "),
    done: false,
  };
}

/** Settled history, then a live turn — the shape the pane is in while a run
 *  streams: everything above is static and only the last turn changes height. */
function liveTranscript(steps: number, answerSentences = 0): ChatMessage[] {
  return [
    ...transcript(3),
    { role: "user", content: "Read that note and explain the nested list examples." },
    liveTurn(steps, answerSentences),
  ];
}

/** A note the model is composing: `lines` of body, complete once the arguments
 *  have closed. `abandoned` stays null — this is the healthy path. */
function writeEdit(lines: number, complete: boolean): NoteEditView {
  return {
    id: "call-write",
    relPath: "Atomic/Spaced recall.md",
    kind: "atomic",
    body: `${Array.from({ length: lines }, (_, i) => `composed line ${i + 1}`).join("\n")}\n`,
    complete,
    abandoned: null,
  };
}

/** A turn whose write is either still composing (card open, tall) or settled
 *  (card folded to one line). The answer is already streaming in BOTH arms, so
 *  the process rail is folded away in both and the only thing whose height
 *  changes between them is the card itself. */
function writeTurn(lines: number, settled: boolean, answerSentences: number): AssistantMessage {
  return {
    ...emptyAssistant(false, "turn-write"),
    phase: "thinking",
    noteEdits: [writeEdit(lines, settled)],
    toolCalls: settled
      ? [
          {
            id: "call-write",
            name: "write_note",
            title: "Write note",
            arguments: "{}",
            status: "ok",
            summary: null,
            detail: null,
          },
        ]
      : [],
    answer: Array.from(
      { length: answerSentences },
      (_, i) => `Answer ${i + 1}: retrieval practice beats rereading, reliably.`,
    ).join(" "),
    done: false,
  };
}

function writeTranscript(
  lines: number,
  settled: boolean,
  answerSentences = 1,
): ChatMessage[] {
  return [
    ...transcript(3),
    { role: "user", content: "capture that idea about recall" },
    writeTurn(lines, settled, answerSentences),
  ];
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function scrollPort(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[aria-label="Conversation"]');
  if (el === null) throw new Error("the conversation region did not render");
  return el;
}

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

const jumpControl = () => page.getByRole("button", { name: "Jump to latest" });

/** The note-write card's rendered height, in real pixels. */
function writeCardHeight(): number {
  const el = host!.querySelector<HTMLElement>('[aria-label^="Note write"]');
  if (el === null) throw new Error("the note-write card did not render");
  return el.getBoundingClientRect().height;
}

/** The rail nodes of the newest turn — the live one in every test below. */
function liveRailNodes(): HTMLElement[] {
  const rails = host!.querySelectorAll<HTMLElement>(
    '[aria-label="What the assistant did"]',
  );
  const rail = rails[rails.length - 1];
  if (rail === undefined) throw new Error("the process rail did not render");
  return [...rail.querySelectorAll<HTMLElement>("li")];
}

// Every follow decision happens in a ResizeObserver callback, and observer
// delivery rides the rendering update — which the browser throttles hard for a
// backgrounded frame. When the whole browser suite runs, several test iframes
// exist at once and delivery can land well after any fixed sleep, so anything
// that depends on the observer having run is POLLED. A sleep is kept only where
// the assertion is that something did NOT happen.
const POLL = { timeout: 5000, interval: 50 } as const;

/** Give a scroll that should NOT happen every chance to happen. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  });
}

function transcriptTree(messages: ChatMessage[]) {
  return (
    <ChatTranscript
      messages={messages}
      onOpenCitation={() => {}}
      onOpenNote={() => {}}
      onSendFollowUp={() => {}}
      busy={false}
      runIds={{}}
    />
  );
}

async function render(messages: ChatMessage[]): Promise<void> {
  await act(async () => {
    root!.render(transcriptTree(messages));
  });
  await settle();
}

async function mount(messages: ChatMessage[]): Promise<HTMLElement> {
  await document.fonts.ready;
  // A host shaped like the docked pane: a fixed-height column, which is what
  // makes `min-h-0 flex-1 overflow-y-auto` resolve to a real scroll port.
  host = document.createElement("div");
  host.style.width = `${PANE_WIDTH_PX}px`;
  host.style.height = `${PANE_HEIGHT_PX}px`;
  host.style.display = "flex";
  host.style.flexDirection = "column";
  document.body.append(host);
  root = createRoot(host);
  await render(messages);
  const port = scrollPort();
  // Everything below is vacuous unless the transcript genuinely overflows.
  await expect
    .poll(() => port.scrollHeight - port.clientHeight, POLL)
    .toBeGreaterThan(100);
  return port;
}

/** Wait for a scroll animation to actually finish. Chromium ANIMATES a keyboard
 *  scroll, so polling "has it moved yet?" returns on the first frame and hands
 *  back a position the browser is still travelling away from. */
async function waitForScrollEnd(port: HTMLElement): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      let timer = 0;
      const done = () => {
        port.removeEventListener("scrollend", done);
        clearTimeout(timer);
        resolve();
      };
      port.addEventListener("scrollend", done);
      timer = window.setTimeout(done, 2000);
    });
  });
}

/** Wait until the scroll position holds still across a settle interval.
 *
 *  `scrollend` is not enough on its own. It fires once for a scroll that is
 *  still queued behind another, so a caller can be handed a position the pane is
 *  about to leave. Two equal samples 150ms apart mean nothing is in flight. */
async function waitForScrollToRest(port: HTMLElement): Promise<void> {
  await expect
    .poll(async () => {
      const before = port.scrollTop;
      await settle();
      return port.scrollTop === before;
    }, POLL)
    .toBe(true);
}

/** Scroll the transcript up by a real key press. Doubles as the keyboard
 *  reachability check: a scroll container a keyboard user cannot move is a WCAG
 *  2.1.1 failure, and WebKit does not make one focusable on its own. */
async function scrollUpByKeyboard(port: HTMLElement): Promise<void> {
  await act(async () => {
    port.focus();
  });
  expect(document.activeElement).toBe(port);
  // A single PageUp is not reliable when the whole browser suite runs: several
  // test iframes exist at once, and a backgrounded one can drop the key or never
  // run Chromium's ANIMATED keyboard scroll, so `waitForScrollEnd` returns with
  // the port still at the bottom. Measured ~30-50% failure at this line.
  //
  // Retry DELIVERY, not the assertion. The condition below is the same one the
  // old code asserted once, so a hook that genuinely stopped releasing on scroll
  // still fails — it just no longer fails because a keypress went missing.
  //
  // Every press is allowed to come to REST before the next one is considered.
  // Without that, a press issued while the previous scroll was still travelling
  // stacked a second one that landed after the caller had already recorded where
  // the user parked — the caller then measured a ~300px move nobody made. It
  // failed every WebKit run and roughly one Chromium run in five, and both
  // reported the same fingerprint: an expected position that varied per run
  // against an actual position that never did.
  await expect
    .poll(async () => {
      if (distanceFromBottom(port) <= BOTTOM_THRESHOLD_PX) {
        await userEvent.keyboard("{PageUp}");
        await waitForScrollEnd(port);
        await waitForScrollToRest(port);
      }
      return distanceFromBottom(port);
    }, POLL)
    .toBeGreaterThan(BOTTOM_THRESHOLD_PX);
}

describe("chat transcript — real-browser scroll follow", () => {
  it("pins to the bottom and follows an answer as it streams in", async () => {
    const port = await mount(transcript(4));
    await expect.poll(() => distanceFromBottom(port), POLL).toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    const heightBefore = port.scrollHeight;
    const topBefore = port.scrollTop;

    await render(transcript(4, 12));

    await expect.poll(() => distanceFromBottom(port), POLL).toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    expect(port.scrollHeight).toBeGreaterThan(heightBefore);
    expect(port.scrollTop).toBeGreaterThan(topBefore);
  });

  it("stops following once the user scrolls up, and only then offers the jump control", async () => {
    const port = await mount(transcript(6));
    await expect.poll(() => distanceFromBottom(port), POLL).toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    expect(jumpControl().query()).toBeNull();

    await scrollUpByKeyboard(port);
    const parked = port.scrollTop;
    const heightBefore = port.scrollHeight;
    await expect.poll(() => jumpControl().query(), POLL).not.toBeNull();

    // The answer keeps streaming. The viewport must stay on what they are reading.
    await render(transcript(6, 12));
    await expect.poll(() => port.scrollHeight, POLL).toBeGreaterThan(heightBefore);
    await settle();

    expect(port.scrollTop).toBe(parked);
    expect(jumpControl().query()).not.toBeNull();
  });

  it("re-pins when the jump control is clicked", async () => {
    const port = await mount(transcript(6));
    await scrollUpByKeyboard(port);
    await expect.poll(() => jumpControl().query(), POLL).not.toBeNull();

    await userEvent.click(jumpControl());

    await expect.poll(() => distanceFromBottom(port), POLL).toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    await expect.poll(() => jumpControl().query(), POLL).toBeNull();
  });

  it("re-pins when a new turn starts, even after the user scrolled away", async () => {
    const port = await mount(transcript(6));
    await scrollUpByKeyboard(port);
    await expect.poll(() => jumpControl().query(), POLL).not.toBeNull();

    await render(transcript(7));

    await expect.poll(() => distanceFromBottom(port), POLL).toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    await expect.poll(() => jumpControl().query(), POLL).toBeNull();
  });

  it("leaves an expanded activity disclosure exactly where the user clicked it", async () => {
    const port = await mount(transcript(6));
    await expect.poll(() => distanceFromBottom(port), POLL).toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);

    const folds = host!.querySelectorAll<HTMLDetailsElement>("details");
    const fold = folds[folds.length - 1];
    expect(fold, "the settled activity trace should collapse behind a fold").toBeDefined();
    expect(fold.open).toBe(false);
    const summary = fold.querySelector("summary");
    expect(summary).not.toBeNull();

    // Hover first: Playwright scrolls an element into view before acting on it,
    // so taking the baseline afterwards keeps that movement out of the measure.
    await userEvent.hover(summary!);
    await settle();
    const summaryTopBefore = summary!.getBoundingClientRect().top;
    const heightBefore = port.scrollHeight;
    // If the hover pushed us off the bottom the pin is already released and the
    // rest of this test would pass for the wrong reason.
    expect(distanceFromBottom(port)).toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);

    await userEvent.click(summary!);
    // The restoration happens in the observer callback, so poll for it: without
    // it, Chromium's own scroll anchoring leaves the summary ~85px higher.
    await expect
      .poll(() => summary!.getBoundingClientRect().top, POLL)
      .toBeCloseTo(summaryTopBefore, 0);

    expect(fold.open).toBe(true);
    // Vacuous unless opening it actually added content.
    expect(port.scrollHeight).toBeGreaterThan(heightBefore);
    // Parked above the bottom by their own gesture: the pin releases and the
    // way back is offered rather than taken for them.
    await expect.poll(() => jumpControl().query(), POLL).not.toBeNull();
  });
});

describe("chat transcript — the live process rail", () => {
  it("keeps every dispatched tool node on the rail while the run is live", async () => {
    // Five steps: more than the three the rail used to window down to, which is
    // how a dispatched call went missing mid-turn in a real build. The rail is
    // the complete, ordered account of what the agent did — a timeline that
    // drops steps while they are happening destroys the audit at exactly the
    // moment the user is watching it.
    await mount(liveTranscript(5));

    expect(liveRailNodes()).toHaveLength(5);
    for (let n = 0; n < 5; n += 1) {
      const present = liveRailNodes().some((node) =>
        node.textContent?.includes(`marker-${n}`),
      );
      expect(present, `the node for call ${n} should still be on the rail`).toBe(true);
    }
  });

  it("keeps following when the rail changes height above the viewport", async () => {
    // No synthetic user scroll anywhere in this test. The only thing that moves
    // is the run: steps land on the rail, then the answer starts, which folds
    // the whole process away — several hundred pixels REMOVED above the
    // viewport — and the answer keeps streaming underneath it.
    const port = await mount(liveTranscript(2));
    await expect
      .poll(() => distanceFromBottom(port), POLL)
      .toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);

    for (const steps of [3, 4, 5, 6, 7]) {
      await render(liveTranscript(steps));
    }
    await expect
      .poll(() => distanceFromBottom(port), POLL)
      .toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);

    // The answer's first tokens and the ones after them, with no frame between
    // and a layout read in the middle. That reproduces the frame the pin used to
    // die in: the engine lays out the folded-away rail, clamps `scrollTop` down
    // to the new maximum on its own, and queues the resulting `scroll` event —
    // which is delivered only after the answer has grown the transcript back, by
    // which point the position it reports is nowhere near the bottom and reads
    // exactly like a user scrolling up (issue #109).
    //
    // Engine note: this goes red in WebKit, the family this app ships on, and
    // NOT in Chromium, which dispatches the clamp's scroll event before the
    // second commit lands. A green Chromium run is not evidence about this bug;
    // `test:browser:webkit` is.
    await act(async () => {
      flushSync(() => root!.render(transcriptTree(liveTranscript(7, 1))));
      void port.scrollHeight;
      flushSync(() => root!.render(transcriptTree(liveTranscript(7, 24))));
    });
    await settle();

    await expect
      .poll(() => distanceFromBottom(port), POLL)
      .toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    expect(jumpControl().query()).toBeNull();
  });
});

describe("chat transcript — a note write composing in the port", () => {
  it("keeps following while a write card grows and then collapses", async () => {
    // The note-write card is the one element in the pane that grows AND shrinks
    // on its own: it tails the composing body line by line, then folds the whole
    // body away the instant the write settles. That collapse happens above the
    // viewport while the answer is still streaming below it — the exact shape
    // that broke scroll-follow once already (issue #109), and the reason this
    // card owes the browser tier a test rather than only a jsdom one.
    //
    // Engine note, same as the rail's test below: the failure mode is a `scroll`
    // event the engine defers past the next commit, and Chromium does not defer
    // it. `test:browser:webkit` is where this assertion carries evidence.
    const port = await mount(writeTranscript(2, false));
    await expect
      .poll(() => distanceFromBottom(port), POLL)
      .toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);

    // The note composes: fragment by fragment, the card grows.
    for (const lines of [4, 8, 12]) {
      await render(writeTranscript(lines, false));
    }
    await expect
      .poll(() => distanceFromBottom(port), POLL)
      .toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    const composedHeight = writeCardHeight();
    // Vacuous unless the card is genuinely tall enough for its collapse to move
    // the content above the viewport.
    expect(composedHeight).toBeGreaterThan(120);

    // The write settles — the card folds its body away — and the answer keeps
    // streaming. Two commits inside one task with a layout read between them:
    // that is the frame the engine clamps `scrollTop` in and then queues the
    // resulting scroll event for delivery long after the content has grown back.
    await act(async () => {
      flushSync(() => root!.render(transcriptTree(writeTranscript(12, true, 1))));
      void port.scrollHeight;
      flushSync(() => root!.render(transcriptTree(writeTranscript(12, true, 24))));
    });
    await settle();

    await expect.poll(() => writeCardHeight(), POLL).toBeLessThan(composedHeight);
    await expect
      .poll(() => distanceFromBottom(port), POLL)
      .toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    expect(jumpControl().query()).toBeNull();
  });
});

// ── The approval sheet in the scroll port ────────────────────────────────────

const APPROVAL_CALL_ID = "call-write";

function approvalView(pending: boolean): ToolApprovalView {
  return {
    id: APPROVAL_CALL_ID,
    tool: "writeNote",
    relPath: "Atomic/Spaced recall.md",
    reason: "modeAlwaysAsk",
    expiresInSecs: 120,
    checking: false,
    resolution: pending ? null : "approved",
    autoApprovedRule: null,
  };
}

/** A live turn whose gated write is either waiting on the user (the sheet is up)
 *  or already answered (the sheet is gone). The answer streams in BOTH arms, so
 *  the sheet is never the last thing in the port — which is what stops the
 *  sheet's own mount focus from parking the view at the bottom and making a
 *  follow assertion pass for the wrong reason. */
function approvalTurn(pending: boolean, answerSentences: number): AssistantMessage {
  const approval = approvalView(pending);
  return {
    ...emptyAssistant(false, "turn-approval"),
    phase: "thinking",
    toolCalls: [
      {
        id: APPROVAL_CALL_ID,
        name: "write_note",
        title: "Write note",
        arguments: '{"rel_path":"Atomic/Spaced recall.md"}',
        status: pending ? null : "ok",
        summary: null,
        detail: null,
      },
    ],
    toolApprovals: [approval],
    pendingApproval: pending ? approval : null,
    answer: Array.from(
      { length: answerSentences },
      (_, i) => `Answer ${i + 1}: retrieval practice beats rereading, reliably.`,
    ).join(" "),
    done: false,
  };
}

function approvalTranscript(pending: boolean, answerSentences = 1): ChatMessage[] {
  return [
    ...transcript(3),
    { role: "user", content: "capture that idea about recall" },
    approvalTurn(pending, answerSentences),
  ];
}

/** The pinned security sheet, by its accessible name — the question itself. */
const approvalSheet = () => page.getByRole("region", { name: /^Allow NeuralNote/ });

describe("chat transcript — the approval sheet appearing and going", () => {
  it("keeps following when a request arrives, and keeps the sheet in the port", async () => {
    const port = await mount(approvalTranscript(false, 1));
    await expect
      .poll(() => distanceFromBottom(port), POLL)
      .toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    expect(approvalSheet().query()).toBeNull();
    const heightBefore = port.scrollHeight;

    await render(approvalTranscript(true, 1));

    const sheet = approvalSheet().query();
    expect(sheet).not.toBeNull();
    // Pinned IN the transcript, not floated over it: a security prompt that
    // escaped the scroll port would be a modal by another name.
    expect(port.contains(sheet)).toBe(true);
    // Vacuous unless the sheet genuinely added height.
    await expect.poll(() => port.scrollHeight, POLL).toBeGreaterThan(heightBefore);
    await expect
      .poll(() => distanceFromBottom(port), POLL)
      .toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    expect(jumpControl().query()).toBeNull();
  });

  it("keeps following when the sheet is answered away while the answer streams", async () => {
    // The §109 shape, and the reason this test is at the browser tier at all:
    // the sheet is REMOVED above the viewport while content keeps arriving
    // below it. The engine clamps `scrollTop` down to the new maximum by itself
    // and queues the resulting `scroll` event; by the time it is delivered the
    // answer has grown the transcript back, so the position it reports looks
    // exactly like a user scrolling up. Pin lost, nobody touched anything.
    //
    // Engine note: this reproduces in WebKit, the family this app ships on, and
    // NOT in Chromium, which dispatches the clamp's scroll event before the
    // second commit lands. A green Chromium run is not evidence about this bug;
    // `test:browser:webkit` is.
    const port = await mount(approvalTranscript(true, 1));
    await expect
      .poll(() => distanceFromBottom(port), POLL)
      .toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    const sheetHeight = approvalSheet().element().getBoundingClientRect().height;
    // Vacuous unless the sheet is tall enough for its removal to move content
    // above the viewport.
    expect(sheetHeight).toBeGreaterThan(80);

    await act(async () => {
      flushSync(() => root!.render(transcriptTree(approvalTranscript(false, 1))));
      void port.scrollHeight;
      flushSync(() => root!.render(transcriptTree(approvalTranscript(false, 24))));
    });
    await settle();

    expect(approvalSheet().query()).toBeNull();
    await expect
      .poll(() => distanceFromBottom(port), POLL)
      .toBeLessThanOrEqual(BOTTOM_THRESHOLD_PX);
    expect(jumpControl().query()).toBeNull();
  });

  it("brings a user who scrolled away to the request, rather than pinging at them", async () => {
    // The one place a request is allowed to move a view the user parked, and it
    // is deliberate. The pane's standing rule is that streaming content never
    // yanks — but this is not content. It blocks the run, it expires in 120
    // seconds, and an unanswered one settles as "nobody answered in time".
    //
    // It also falls out of taking focus at all: `focus()` scrolls its target
    // into view, and focus that lands somewhere off screen is a WCAG 2.4.7
    // failure. Either the sheet takes focus AND the view follows, or it does
    // neither. `ElicitCard`, the same pattern for a model-authored question,
    // already resolves this the same way.
    const port = await mount(approvalTranscript(false, 12));
    await scrollUpByKeyboard(port);
    await expect.poll(() => jumpControl().query(), POLL).not.toBeNull();

    await render(approvalTranscript(true, 12));

    const sheet = approvalSheet().element();
    expect(document.activeElement).toBe(sheet);
    // The property that matters is pixels, not `scrollTop`: the thing the user
    // must answer is on screen.
    const sheetBox = sheet.getBoundingClientRect();
    const portBox = port.getBoundingClientRect();
    expect(sheetBox.bottom).toBeLessThanOrEqual(portBox.bottom + 1);
    expect(sheetBox.top).toBeGreaterThanOrEqual(portBox.top - 1);
  });
});
