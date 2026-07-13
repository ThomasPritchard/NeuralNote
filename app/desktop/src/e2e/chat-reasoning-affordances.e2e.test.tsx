// Journey 10: the chat pane's three Slice-3 affordances, end-to-end through the
// REAL Tauri IPC seam (jsdom + mockIPC), not the component-level api stub.
//
// The ChatPane component tests stub `../lib/api` wholesale, so they never drive
// `refresh_reasoning_support` through `invoke`, and never prove the mount-time
// capability probe reaches the composer chip. This journey does, against the
// stateful `mockVault` backend that mirrors the Rust command pair.
//
// Three properties, each a way the pane could mislead the user:
//   1. On a model verified to lack reasoning, the chip is inert AND says why —
//      visibly, not on hover — so the user is never left with a dead control.
//   2. When reasoning was asked for and none came back, the pane stays quiet;
//      an empty implementation detail is not useful conversation content.
//   3. When a search genuinely finds nothing, the pane says "nothing covers
//      this" — and (asserted in the unit suite) never when a note WAS read.

import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type CreateMockVaultOptions } from "./mockVault";
import type { ChatEvent } from "../lib/types";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

const REASONING_CHIP = { name: /show model reasoning/i };
const BACKSTOP = /Reasoning was on, but the model didn't return any/;

/** Render the app and open the recent vault, resolving once the chat pane mounts. */
async function openWorkspace(opts: CreateMockVaultOptions = {}) {
  const result = renderApp({ recents, ...opts });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByText("Cited recall");
  return result;
}

async function ask(user: ReturnType<typeof renderApp>["user"], prompt: string) {
  await user.type(await screen.findByLabelText("Ask across your vault"), prompt);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

describe("Journey 10: chat-pane reasoning affordances", () => {
  it("marks the chip inert and names the model when the probe says unsupported", async () => {
    // Seed the cached verdict as "unknown" (the pre-probe state — chip fails
    // open, enabled) and let the mount-time `refresh_reasoning_support` probe be
    // what DISCOVERS "unsupported". If the probe path were dead, the chip would
    // stay enabled and this test would fail — which is the point: it proves the
    // probe reaches the chip, not just that a seeded verdict renders.
    await openWorkspace({
      apiKey: {
        hasKey: true,
        model: "acme/no-thoughts",
        reasoning: false,
        reasoningSupported: "unknown",
        probedSupport: "unsupported",
      },
    });

    const chip = await screen.findByRole("button", REASONING_CHIP);
    // The reason line appears only after the probe flips the verdict via IPC.
    await screen.findByText("acme/no-thoughts can't return reasoning.");

    // aria-disabled, not native disabled: the chip stays focusable so the reason
    // is reachable by keyboard, and the reason is a visible line, not a title.
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).not.toBeDisabled();
    expect(chip).toHaveAccessibleDescription(/can't return reasoning/i);
  });

  it("stays quiet when reasoning was on but none arrived", async () => {
    const noThinking: ChatEvent[] = [
      { type: "answer", delta: "A plain answer, no reasoning." },
      { type: "done" },
    ];
    const { user } = await openWorkspace({
      apiKey: {
        hasKey: true,
        model: "anthropic/claude-sonnet-4.5",
        reasoning: true,
        reasoningSupported: "supported",
      },
      chatScript: noThinking,
    });

    await ask(user, "anything");

    expect(screen.queryByText(BACKSTOP)).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
  });

  it("shows the nothing-found card when a search reads and cites nothing", async () => {
    const nothingFound: ChatEvent[] = [
      { type: "searching", query: "fibonacci trading" },
      { type: "retrieved", query: "fibonacci trading", hitCount: 0 },
      { type: "answer", delta: "Your notes don't cover that. Try adding one." },
      {
        type: "coverage",
        searchedTerms: ["fibonacci trading"],
        notesRead: [],
        truncated: false,
        skippedFiles: 0,
      },
      { type: "done" },
    ];
    const { user } = await openWorkspace({
      apiKey: { hasKey: true, model: "anthropic/claude-sonnet-4.5" },
      chatScript: nothingFound,
    });

    await ask(user, "What do my notes say about the Fibonacci trading strategy?");

    expect(
      await screen.findByText("Nothing in your vault covers this"),
    ).toBeInTheDocument();
    // The searched term is surfaced so the user sees what was actually looked for.
    const terms = screen.getByRole("list", { name: "Searched terms" });
    expect(within(terms).getByText("fibonacci trading")).toBeInTheDocument();
  });
});
