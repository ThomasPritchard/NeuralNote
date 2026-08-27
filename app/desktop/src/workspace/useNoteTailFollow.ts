import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Absorb fractional-pixel rounding without making a deliberate upward scroll
 * look pinned. */
export const NOTE_BOTTOM_TOLERANCE_PX = 8;

interface ActivityScrollState {
  following: boolean;
  scrollTop: number;
}

export interface NoteTailFollow {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly contentRef: RefObject<HTMLPreElement | null>;
  readonly overflowing: boolean;
  readonly paused: boolean;
  readonly jumpToLatest: () => void;
}

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function reducedMotionRequested(): boolean {
  return (
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
  );
}

/**
 * Follow one selected note preview without transferring reading position to a
 * sibling activity. The component remains one state owner while selection
 * changes; this hook keeps each activity's paused position in that owner.
 */
export function useNoteTailFollow({
  activityId,
  content,
}: Readonly<{ activityId: string; content: string }>): NoteTailFollow {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLPreElement>(null);
  const activityIdRef = useRef(activityId);
  const memoryRef = useRef(new Map<string, ActivityScrollState>());
  const lastTopRef = useRef(0);
  const [overflowing, setOverflowing] = useState(false);
  const [paused, setPaused] = useState(false);
  const overflowingRef = useRef(false);
  const pausedRef = useRef(false);
  activityIdRef.current = activityId;

  const stateFor = useCallback((id: string): ActivityScrollState => {
    const existing = memoryRef.current.get(id);
    if (existing !== undefined) return existing;
    const initial = { following: true, scrollTop: 0 };
    memoryRef.current.set(id, initial);
    return initial;
  }, []);

  const publishState = useCallback(
    (nextOverflowing: boolean, nextPaused: boolean) => {
      if (overflowingRef.current !== nextOverflowing) {
        overflowingRef.current = nextOverflowing;
        setOverflowing(nextOverflowing);
      }
      if (pausedRef.current !== nextPaused) {
        pausedRef.current = nextPaused;
        setPaused(nextPaused);
      }
    },
    [],
  );

  const reconcile = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const state = stateFor(activityIdRef.current);
    const nextOverflowing = viewport.scrollHeight > viewport.clientHeight;

    if (!nextOverflowing) {
      state.following = true;
      viewport.scrollTop = 0;
    } else if (state.following) {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      viewport.scrollTop = state.scrollTop;
    }

    state.scrollTop = viewport.scrollTop;
    lastTopRef.current = viewport.scrollTop;
    const nextPaused = nextOverflowing && !state.following;
    publishState(nextOverflowing, nextPaused);
  }, [publishState, stateFor]);

  useLayoutEffect(() => {
    reconcile();
  }, [activityId, content, reconcile]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;

    const onScroll = () => {
      const state = stateFor(activityIdRef.current);
      const top = viewport.scrollTop;
      if (distanceFromBottom(viewport) <= NOTE_BOTTOM_TOLERANCE_PX) {
        state.following = true;
      } else if (top < lastTopRef.current) {
        state.following = false;
      }
      state.scrollTop = top;
      lastTopRef.current = top;
      const nextOverflowing = viewport.scrollHeight > viewport.clientHeight;
      const nextPaused = nextOverflowing && !state.following;
      publishState(nextOverflowing, nextPaused);
    };

    viewport.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(reconcile);
    observer.observe(viewport);
    if (contentRef.current !== null) observer.observe(contentRef.current);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [publishState, reconcile, stateFor]);

  const jumpToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const state = stateFor(activityIdRef.current);
    state.following = true;
    if (reducedMotionRequested()) {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    }
    state.scrollTop = viewport.scrollTop;
    lastTopRef.current = viewport.scrollTop;
    publishState(overflowingRef.current, false);
  }, [publishState, stateFor]);

  return { viewportRef, contentRef, overflowing, paused, jumpToLatest };
}
