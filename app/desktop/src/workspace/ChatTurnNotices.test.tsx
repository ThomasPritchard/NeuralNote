// The turn's cost footer — what the run took and what it spent.
//
// The property under test is an honesty one: a token count the provider never
// reported must be ABSENT, never `0`. `0` claims a measurement was taken and
// came back empty, which is a different (and false) statement about the run —
// and it is the routine case on the local lane, which reports neither count.
//
// Every expected string below is pinned as a literal. Asserting the rendered
// text equals a value derived from the same view model it renders would compare
// a value against its own source and pass forever.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UsageView } from "./chatMessage";
import { UsageFooter, formatElapsed } from "./ChatTurnNotices";

const MODEL = "anthropic/claude-sonnet-4.5";

const usage = (overrides: Partial<UsageView> = {}): UsageView => ({
  elapsedMs: 4230,
  tokensIn: 1204,
  tokensOut: 318,
  model: MODEL,
  ...overrides,
});

/** The facts on the footer, in the order they are shown. */
function facts(): (string | null)[] {
  const list = screen.getByRole("list", { name: "What this turn cost" });
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

describe("UsageFooter", () => {
  it("reports elapsed time, both token counts and the model", () => {
    render(<UsageFooter usage={usage()} />);

    expect(facts()).toEqual(["4.2s", "1,204 tokens in", "318 tokens out", MODEL]);
  });

  it("leaves an unreported token count out entirely rather than showing zero", () => {
    // The local lane routinely reports neither. What goes red: default either
    // count to 0 and a fifth/sixth fact appears claiming the run consumed
    // nothing — a measurement that was never taken.
    render(<UsageFooter usage={usage({ tokensIn: null, tokensOut: null })} />);

    expect(facts()).toEqual(["4.2s", MODEL]);
    expect(screen.getByRole("list", { name: "What this turn cost" })).not.toHaveTextContent(
      /\btokens\b/,
    );
  });

  it("keeps the count the provider did report when the other is missing", () => {
    render(<UsageFooter usage={usage({ tokensOut: null })} />);
    expect(facts()).toEqual(["4.2s", "1,204 tokens in", MODEL]);
  });

  it("shows a genuine zero, because that IS a measurement", () => {
    // Absent and zero are different claims, and this is the arm that stops the
    // rule above from being implemented as "hide anything falsy".
    render(<UsageFooter usage={usage({ tokensIn: 0 })} />);
    expect(facts()).toEqual(["4.2s", "0 tokens in", "318 tokens out", MODEL]);
  });

  it("renders nothing at all until the backend reports a cost", () => {
    // A provider that never reports usage leaves the turn looking exactly as it
    // did before this footer existed.
    const { container } = render(<UsageFooter usage={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("formatElapsed", () => {
  it.each([
    [0, "0.0s"],
    [940, "0.9s"],
    [4230, "4.2s"],
    [59_940, "59.9s"],
    // Past a minute the decimal stops meaning anything.
    [60_000, "1m 00s"],
    [125_400, "2m 05s"],
  ])("renders %ims as %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});
