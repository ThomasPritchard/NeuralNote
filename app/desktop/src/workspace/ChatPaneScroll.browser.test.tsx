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

import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ChatTranscript } from "./ChatTranscript";
import { emptyAssistant, type AssistantMessage, type ChatMessage } from "./chatMessage";
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

async function render(messages: ChatMessage[]): Promise<void> {
  await act(async () => {
    root!.render(
      <ChatTranscript
        messages={messages}
        onOpenCitation={() => {}}
        onOpenNote={() => {}}
        onSendFollowUp={() => {}}
        busy={false}
        runIds={{}}
      />,
    );
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

/** Scroll the transcript up by a real key press. Doubles as the keyboard
 *  reachability check: a scroll container a keyboard user cannot move is a WCAG
 *  2.1.1 failure, and WebKit does not make one focusable on its own. */
async function scrollUpByKeyboard(port: HTMLElement): Promise<void> {
  await act(async () => {
    port.focus();
  });
  expect(document.activeElement).toBe(port);
  await userEvent.keyboard("{PageUp}");
  await waitForScrollEnd(port);
  expect(distanceFromBottom(port)).toBeGreaterThan(BOTTOM_THRESHOLD_PX);
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
