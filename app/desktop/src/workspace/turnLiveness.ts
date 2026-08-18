// What the live head knows about time: how long the run has been going, and
// whether it has gone quiet.
//
// Two rules shape everything here.
//
//   1. **A keepalive is not progress.** The backend forwards the provider's
//      comment lines so the pane can tell "still working" apart from "the
//      provider has gone away". Those two are different sentences, so they read
//      different timestamps: the notice watches `lastEventAt`, and only the
//      wording consults `lastAliveAt`.
//   2. **A notice is not a countdown.** The approval sheet deliberately does not
//      tick its expiry down (see `approvalCopy.ts`), because a security prompt
//      counting down manufactures urgency. This is a different thing — a run
//      clock counting up, and one boolean that flips once — and it stays that
//      way: nothing here exposes "time since the last event" as a number to
//      render, only the fact that a threshold was crossed.

import { useEffect, useState } from "react";
import type { AssistantMessage } from "./chatMessage";

/** How long a live run may go without a PROGRESS event before the head says so.
 *
 *  Named, because the number is a judgement and not arithmetic: long enough
 *  that an ordinary model round-trip (the tool-deciding turn can take fifteen
 *  seconds and emit nothing else) never trips it, short enough that a user
 *  wondering whether the app has hung gets an answer before they reach for the
 *  window's close button. */
export const STALL_AFTER_MS = 45_000;

/** How often the live clock is re-read. One second: the readout is shown to the
 *  second, so anything finer would render identically and commit more often. */
const TICK_MS = 1_000;

export interface TurnLiveness {
  /** Milliseconds the run has been going, or `null` before its first event —
   *  never `0` standing in for "not started", which would render as a real
   *  measurement of a run that has taken no time. */
  elapsedMs: number | null;
  /** Nothing has progressed for `STALL_AFTER_MS`. */
  stalled: boolean;
  /** Stalled, and not even a keepalive has arrived since — the provider itself
   *  has gone quiet, which is the more serious of the two sentences. */
  silent: boolean;
}

/** The fields the readout needs. A `Pick` rather than the whole turn, so the
 *  test fixtures say what actually drives it. */
export type LiveTurn = Pick<
  AssistantMessage,
  "startedAt" | "lastEventAt" | "lastAliveAt" | "usage" | "done"
>;

/** What the head should show about time, at `now`.
 *
 *  Pure, and independent of `now` once the run has settled: `usage.elapsedMs` is
 *  the backend's own measurement across the whole run and is authoritative from
 *  that point on. The one adjustment is that it may never rewind the number
 *  already on screen — the client started counting at the turn's first event and
 *  the backend counted from the run's start, so the two can disagree slightly,
 *  and a clock that jumps backwards at the finish line reads as a bug. The
 *  client's own figure is measured between the first and last events rather than
 *  against the render clock, so re-rendering a finished turn an hour later still
 *  shows what it showed then. */
export function turnLiveness(turn: LiveTurn, now: number): TurnLiveness {
  const started = turn.startedAt !== 0;
  const settledMs = turn.usage?.elapsedMs ?? null;
  const clientMs = started ? Math.max(0, turn.lastEventAt - turn.startedAt) : null;
  const tickingMs = started ? Math.max(0, now - turn.startedAt) : null;
  const stalled =
    started && !turn.done && now - turn.lastEventAt >= STALL_AFTER_MS;
  return {
    elapsedMs:
      settledMs === null ? tickingMs : Math.max(settledMs, clientMs ?? 0),
    stalled,
    silent: stalled && now - turn.lastAliveAt >= STALL_AFTER_MS,
  };
}

/** `turnLiveness`, re-read once a second while the run is live.
 *
 *  The interval lives with whoever renders the head, so the per-second commit
 *  stays inside that component instead of re-rendering the whole transcript —
 *  which would re-assert the scroll pin every second. It stops the moment the
 *  run is no longer live, and the settled reading needs no clock at all. */
export function useTurnLiveness(turn: LiveTurn, live: boolean): TurnLiveness {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(handle);
  }, [live]);
  return turnLiveness(turn, now);
}
