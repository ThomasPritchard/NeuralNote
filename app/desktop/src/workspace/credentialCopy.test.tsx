// What the two credential surfaces are allowed to promise about the API key.
//
// Both of them used to say the key "never leaves this machine" — a claim about
// the key *in transit*, and a false one: the key is bearer-auth'd to
// https://openrouter.ai on every chat turn and every model-catalogue refresh
// (issue #207). The true half of that sentence is about the key *at rest*.
//
// This suite is deliberately written against the rendered text of BOTH
// surfaces, not against the shared constant: a test that asserted
// `getByText(THE_CONSTANT)` would pass just as happily if one component still
// held its own literal. The single-source requirement is pinned behaviourally
// instead — the two surfaces must render the identical claim.

import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ALWAYS_ASK_APPROVAL_STATUS } from "../lib/approvalStatusFixture";
import type { AiStatus } from "../lib/types";
import { KeySetupPanel } from "./KeySetupPanel";
import { OpenRouterCard } from "./OpenRouterCard";

/** The regression class, not just the one sentence that shipped it: any way of
 *  telling the user the key stays put. */
const TRANSMISSION_IMMUNITY =
  /(never|doesn't|does not|won't|will not)\s+leave|stays?\s+(on|only\s+on)\s+(this|your)\s+(machine|computer|device|mac)|only\s+(ever\s+)?(on|lives\s+on)\s+(this|your)\s+(machine|computer|device|mac)/i;

/** Where the shared claim starts, in whatever lead-in a surface puts before it. */
const CLAIM_ANCHOR = /your key is stored/i;

const NO_KEY_STATUS: AiStatus = {
  activeProvider: "openRouter",
  reasoningSupported: "unknown",
  reasoningControl: { kind: "pending" },
  openrouter: {
    hasKey: false,
    model: "anthropic/claude-sonnet-4.5",
    reasoning: false,
    reasoningEffort: null,
  },
  local: { activeModelTag: null },
  approval: ALWAYS_ASK_APPROVAL_STATUS,
};

const normalise = (text: string) => text.replaceAll(/\s+/g, " ").trim();

/** Render one surface and read back both its whole copy and the credential
 *  claim inside it. Unmounted before returning so surfaces can be compared
 *  without their queries colliding in one document. */
function copyOf(ui: ReactElement): { all: string; claim: string } {
  const view = render(ui);
  const line = normalise(view.getByText(CLAIM_ANCHOR).textContent ?? "");
  const all = normalise(view.baseElement.textContent ?? "");
  cleanup();
  return { all, claim: line.slice(line.search(CLAIM_ANCHOR)) };
}

const keySetupCopy = () =>
  copyOf(
    <KeySetupPanel
      model="anthropic/claude-sonnet-4.5"
      saving={false}
      onSave={vi.fn()}
      onSkip={vi.fn()}
    />,
  );

const openRouterCardCopy = () =>
  copyOf(
    <OpenRouterCard
      status={NO_KEY_STATUS}
      switching={false}
      onActivate={() => Promise.resolve()}
      refreshStatus={() => Promise.resolve()}
      applyStatus={vi.fn()}
    />,
  );

describe.each([
  ["KeySetupPanel (the chat pane's first-run key setup)", keySetupCopy],
  ["OpenRouterCard (the AI settings page)", openRouterCardCopy],
])("%s — what it promises about the API key", (_name, readCopy) => {
  it("never claims the key stays on this machine", () => {
    expect(readCopy().all).not.toMatch(TRANSMISSION_IMMUNITY);
  });

  it("says the key is sent to OpenRouter, and what for", () => {
    const { claim } = readCopy();
    expect(claim).toMatch(/sent to OpenRouter/i);
    expect(claim).toMatch(/authenticate/i);
  });

  it("keeps the true at-rest half: the keychain, not a file", () => {
    const { claim } = readCopy();
    expect(claim).toMatch(/keychain/i);
    expect(claim).toMatch(/file/i);
  });
});

describe("the credential claim across both surfaces", () => {
  it("is one sentence, worded identically in both places", () => {
    expect(openRouterCardCopy().claim).toBe(keySetupCopy().claim);
  });
});
