// Scroll-follow for the chat transcript (issue #109). A streamed answer grows
// the transcript downward; with no scroll management at all the viewport stays
// put and the user has to chase the answer by hand.
//
// The contract in one line: pinned to the bottom until the user scrolls up, and
// never fighting them afterwards. Three cases make that harder than "scroll on
// every render", and each is handled deliberately:
//
//   • Content appended ABOVE the viewport (a tool node opening mid-scroll).
//     `scrollTop` does not change, so no scroll event fires and nothing is
//     mistaken for user intent. Nothing here leans on CSS scroll anchoring
//     (`overflow-anchor`), which reached WebKit only in Safari 27 — the shipped
//     WKWebView cannot be assumed to have it.
//   • A `<details>` the user expands. At the ResizeObserver that growth is
//     indistinguishable from a streamed delta, so the ACTIVATING GESTURE is the
//     signal — a capture-phase click on the `<summary>`, which is also what a
//     keyboard activation dispatches. Deliberately not the `toggle` event:
//     measured in Chromium, `toggle` is queued as a task and lands AFTER both
//     the layout change and the observer delivery, far too late to hold
//     anything. The summary's screen position is captured on that gesture and
//     restored once the growth lands, which also undoes Chromium's own scroll
//     anchoring — it anchors BELOW the insertion and shoves the summary the
//     user just clicked ~85px up the pane.
//   • `prefers-reduced-motion`. A JS `behavior: "smooth"` argument OVERRIDES the
//     `scroll-behavior: auto !important` reset in styles.css (CSS only governs
//     `behavior: "auto"`), so the query is read here rather than left to the
//     stylesheet.
//
// This only ever scrolls DOWNWARD, which is why there is no "was that scroll
// mine?" flag: the release test is an upward move, and a programmatic scroll
// can never produce one.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Within this many pixels of the bottom counts as pinned. Wide enough to
 *  absorb the sub-pixel rounding a fractional device-pixel ratio introduces,
 *  narrow enough that a deliberate scroll-up releases on the first event. */
const BOTTOM_THRESHOLD_PX = 8;

export interface StickyScroll {
  /** The scroll port. */
  readonly containerRef: RefObject<HTMLDivElement | null>;
  /** The element that grows inside the port — observed for new content. */
  readonly contentRef: RefObject<HTMLDivElement | null>;
  /** Following is released AND there is content below the fold. */
  readonly showJump: boolean;
  /** Re-pin and travel to the newest content. */
  readonly jumpToLatest: () => void;
}

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function prefersReducedMotion(): boolean {
  return (
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
  );
}

/** Keep a scroll port pinned to its newest content.
 *
 *  @param turnCount Bumped when a turn starts (the transcript length). A rising
 *    count re-pins: the user asked for this, so the newest content is what they
 *    want to see even if they had scrolled back to read history. */
export function useStickyScroll({
  turnCount,
}: Readonly<{ turnCount: number }>): StickyScroll {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  // Read by listeners registered once for the port's lifetime, which must not
  // close over a stale render's value.
  const followingRef = useRef(true);
  const lastTopRef = useRef(0);
  // The disclosure the user just activated, and where it sat on screen. Set on
  // the gesture, consumed by the growth it causes.
  const anchorRef = useRef<{ element: Element; top: number } | null>(null);
  const anchorFrameRef = useRef(0);

  const syncJump = useCallback(() => {
    const el = containerRef.current;
    if (el === null) return;
    setShowJump(
      !followingRef.current && distanceFromBottom(el) > BOTTOM_THRESHOLD_PX,
    );
  }, []);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = containerRef.current;
    if (el === null) return;
    if (smooth && !prefersReducedMotion()) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    lastTopRef.current = el.scrollTop;
  }, []);

  const jumpToLatest = useCallback(() => {
    followingRef.current = true;
    scrollToBottom(true);
    setShowJump(false);
  }, [scrollToBottom]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    lastTopRef.current = el.scrollTop;

    const onScroll = () => {
      const top = el.scrollTop;
      const previous = lastTopRef.current;
      lastTopRef.current = top;
      // Order matters. A fold COLLAPSING clamps `scrollTop` downward, which
      // reads exactly like a user scrolling up — but it lands at the bottom, so
      // testing "am I at the bottom" first keeps the pin instead of dropping it.
      if (distanceFromBottom(el) <= BOTTOM_THRESHOLD_PX) {
        followingRef.current = true;
      } else if (top < previous) {
        followingRef.current = false;
      }
      syncJump();
    };

    const onActivate = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const summary = target.closest("summary");
      if (summary === null) return;
      anchorRef.current = { element: summary, top: summary.getBoundingClientRect().top };
      // Dropped a frame after the observer would have delivered, so a
      // disclosure that changes nothing leaves no stale anchor behind.
      cancelAnimationFrame(anchorFrameRef.current);
      anchorFrameRef.current = requestAnimationFrame(() => {
        anchorFrameRef.current = requestAnimationFrame(() => {
          anchorRef.current = null;
        });
      });
    };

    const onGrow = () => {
      const anchor = anchorRef.current;
      if (anchor === null) {
        if (followingRef.current) scrollToBottom(false);
        syncJump();
        return;
      }
      anchorRef.current = null;
      // Put the disclosure back exactly where the user clicked it. A no-op in
      // an engine with no scroll anchoring (WKWebView), a correction in one
      // that has it (Chromium) — the same visible result either way.
      if (el.contains(anchor.element)) {
        el.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
        lastTopRef.current = el.scrollTop;
      }
      // Holding the view still may have parked it above the bottom. That was
      // the user's own doing, so it releases the pin exactly as a scroll-up
      // would — and the jump control is how they come back.
      followingRef.current = distanceFromBottom(el) <= BOTTOM_THRESHOLD_PX;
      syncJump();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    // Capture phase, so the position is recorded before the UA flips `open`.
    // A keyboard activation of a `<summary>` dispatches a click too, so this
    // one listener covers both without the trace components knowing about it.
    el.addEventListener("click", onActivate, true);
    const observer = new ResizeObserver(onGrow);
    observer.observe(el);
    if (contentRef.current !== null) observer.observe(contentRef.current);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("click", onActivate, true);
      observer.disconnect();
      cancelAnimationFrame(anchorFrameRef.current);
    };
  }, [scrollToBottom, syncJump]);

  useEffect(() => {
    followingRef.current = true;
    scrollToBottom(false);
    setShowJump(false);
  }, [turnCount, scrollToBottom]);

  return { containerRef, contentRef, showJump, jumpToLatest };
}
