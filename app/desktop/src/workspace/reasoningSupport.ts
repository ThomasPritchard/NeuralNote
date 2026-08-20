// The two reasoning derivations the UI shares, from the two backend facts that
// answer different questions.
//
// `reasoningCapability` reads the probed `ReasoningSupport`: "may the send path
// ask for reasoning", which fails OPEN on an unprobed model. Only a *verified*
// "unsupported" disables. "unknown" fails OPEN — the probe could not run
// (offline, a hand-typed model id, an upstream 5xx), and the user is never
// punished for our uncertainty; the per-turn backstop notice in ChatMessages
// catches the case where reasoning was requested and none arrived.
//
// `reasoningAlwaysOn` reads the backend-computed `ReasoningControl`: "may the
// user turn reasoning off", which fails CLOSED (spec §4.2). It lives here, once,
// because two surfaces render it — Settings as its "Always on" affordance and
// the composer as its chip — and a second copy is exactly how they came to give
// one model two different answers.

import type { ReasoningControl, ReasoningSupport } from "../lib/types";

export interface ReasoningCapability {
  /** True only when the probe positively verified the model can't reason. */
  disabled: boolean;
  /** The user-facing "why", naming the selected model — `null` when enabled.
   *  Associate it with the control (aria-describedby), not a hover title alone:
   *  a disabled control must still tell a screen reader why. */
  reason: string | null;
}

export function reasoningCapability(
  support: ReasoningSupport,
  model: string,
): ReasoningCapability {
  if (support === "unsupported") {
    return { disabled: true, reason: `${model} can't return reasoning.` };
  }
  return { disabled: false, reason: null };
}

/** This model reasons on every turn and the persisted opt-in cannot stop it.
 *
 *  Two controls say so: `locked` (mandatory, no menu) and an `efforts` menu that
 *  publishes no off position — a user picking how hard the model thinks without
 *  being able to stop it thinking. Both are `mandatory: true` upstream, folded
 *  into one field by `reasoning_control()` (amendment D1).
 *
 *  `pending` is deliberately false: an unanswered probe is not evidence that
 *  reasoning is forced, and claiming it would be the guessed control §4.2 fails
 *  closed against.
 *
 *  The variants are named one by one rather than caught by a `default:`, mirroring
 *  `ReasoningControl::offers` in `capabilities.rs`: a control variant added later
 *  has to answer this question explicitly instead of silently answering "no". */
export function reasoningAlwaysOn(control: ReasoningControl): boolean {
  switch (control.kind) {
    case "locked":
      return true;
    case "efforts":
      return !control.canDisable;
    case "hidden":
    case "pending":
    case "toggle":
      return false;
  }
}
