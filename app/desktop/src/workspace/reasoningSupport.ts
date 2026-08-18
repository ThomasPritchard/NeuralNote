// The capability view-model behind the chat composer's reasoning chip: one
// derivation of "is the control disabled, and why" from the probed
// `ReasoningSupport`.
//
// Settings does NOT use this. Its control is `ReasoningControl` — a value the
// backend computes per model, covering the same "can't reason" case plus the
// three this verdict cannot express (still checking, forced on, and an effort
// menu). The two answer different questions: this one is "may the send path ask
// for reasoning", which fails OPEN on an unprobed model, while the control is
// "what may the user choose", which fails closed (spec §4.2).
//
// Only a *verified* "unsupported" disables. "unknown" fails OPEN — the probe
// could not run (offline, a hand-typed model id, an upstream 5xx), and the user
// is never punished for our uncertainty; the per-turn backstop notice in
// ChatMessages catches the case where reasoning was requested and none arrived.

import type { ReasoningSupport } from "../lib/types";

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
