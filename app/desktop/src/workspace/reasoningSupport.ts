// The shared capability view-model behind the two reasoning toggles (the chat
// composer chip and the Settings checkbox): one derivation of "is the control
// disabled, and why" from the probed `ReasoningSupport`, so the two surfaces can
// never disagree on the states or the copy.
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
