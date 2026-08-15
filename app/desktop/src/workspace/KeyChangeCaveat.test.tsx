// The shared "your other window is still using the previous key" notice.
//
// Two things are worth pinning here, and neither is "the component renders its
// own constant" — that assertion would be a tautology. What matters is that the
// copy obeys the constraints it was written under, and that the notice is
// announced and dismissible.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KEY_CHANGE_CAVEAT_MESSAGE, KeyChangeCaveat } from "./KeyChangeCaveat";

describe("the key-change caveat copy", () => {
  it("carries no internal vocabulary", () => {
    // The backend calls this a cross-process "revision" that failed to
    // "publish". None of that means anything to someone holding a laptop, and
    // the repo's plain-language convention rules it out of user-facing copy.
    expect(KEY_CHANGE_CAVEAT_MESSAGE).not.toMatch(
      /revision|publish|cross-process|instance|keychain|IPC/i,
    );
  });

  it("says what happened, and what the user should do about it", () => {
    // The save landed — leading with the failure would be the opposite false
    // report to the one this notice exists to fix.
    expect(KEY_CHANGE_CAVEAT_MESSAGE).toMatch(/^Key saved\./);
    expect(KEY_CHANGE_CAVEAT_MESSAGE).toMatch(/another window/i);
    expect(KEY_CHANGE_CAVEAT_MESSAGE).toMatch(/restart/i);
  });

  it("does not claim a second window exists", () => {
    // A change that could not be announced is not evidence that anything was
    // listening. Asserting "another window IS using your old key" to a user who
    // has one window open would be a false report of its own, so the sentence
    // is conditional.
    expect(KEY_CHANGE_CAVEAT_MESSAGE).toMatch(/\bIf NeuralNote is open in another window\b/);
  });
});

describe("the key-change caveat notice", () => {
  it("is announced, and is not dressed as a failure", () => {
    render(<KeyChangeCaveat onDismiss={vi.fn()} />);

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(KEY_CHANGE_CAVEAT_MESSAGE);
    // Warning tokens, never the destructive ones: the key really is stored.
    expect(notice).toHaveClass("border-warning/40");
    expect(notice.className).not.toMatch(/destructive/);
  });

  it("hands the dismissal back to its owner rather than hiding itself", async () => {
    // The condition outlives any render — the app cannot tell whether another
    // window exists, or whether it has since been restarted — so the surface
    // that raised the notice owns when it goes away.
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<KeyChangeCaveat onDismiss={onDismiss} />);

    await user.click(screen.getByRole("button", { name: "Dismiss this notice" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
