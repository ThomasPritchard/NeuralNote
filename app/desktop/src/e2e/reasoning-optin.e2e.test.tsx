// Journey 9: OpenRouter reasoning — the opt-in and the per-model effort, end-to-end
// through the REAL Tauri IPC seam.
//
// The AiSettingsPage component tests stub `../lib/api` wholesale, so they never
// reach `invoke`. That leaves the command contracts unverified: ts-rs generates
// the *struct* `AiStatus`, but nothing type-checks a command's name string or its
// return type, so `invoke<AiStatus>("set_reasoning", …)` and
// `invoke<AiStatus>("set_reasoning_effort", …)` in `api.ts` are hand-written
// assertions. This journey drives them against the stateful `mockVault` backend,
// which mirrors the Rust commands.
//
// Reasoning tokens are BILLED. Three properties matter more than the happy path:
//
//   1. Off unless asked for — a keyed user whose config predates the flag sees an
//      unticked box and a plain statement that the tokens cost money.
//   2. The control never lies about what is persisted. Each write returns the
//      freshly written status and the control renders *that*, rather than issuing
//      a follow-up `ai_status` read whose failure `refreshStatus` would swallow —
//      which would show "off" while the config said "on", billing the user for
//      reasoning they never consented to.
//   3. The effort menu is the model's own. It is fetched, stored and sent
//      verbatim; a value the current menu does not offer is refused by the shell
//      and surfaced, never coerced to something nearby.

import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type CreateMockVaultOptions } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

const TOGGLE = { name: /show model reasoning/i };
const EFFORT_MENU = { name: "Reasoning effort" };

/** A keyed user on a probed model that publishes no effort menu — the plain
 *  on/off case. The verdict and the catalogue answer are both seeded because the
 *  control is `pending` until BOTH have: the shell will not guess a shape it has
 *  not been told (locked decision 2). */
const PROBED_TOGGLE: CreateMockVaultOptions["apiKey"] = {
  hasKey: true,
  model: "anthropic/claude-sonnet-4.5",
  reasoningSupported: "supported",
  catalogueControl: { kind: "toggle", defaultOn: false },
};

/** A real catalogue menu, verbatim. Its sibling `deepseek-v4-flash-0731`
 *  publishes `["max","high","low"]` — same model family, nothing shared but
 *  "high" — which is why no part of this menu may be compiled into the UI. */
const PROBED_EFFORTS: CreateMockVaultOptions["apiKey"] = {
  hasKey: true,
  model: "deepseek/deepseek-v4-flash",
  reasoningSupported: "supported",
  catalogueControl: {
    kind: "efforts",
    options: ["xhigh", "high"],
    defaultEffort: "high",
    canDisable: true,
  },
};

/** Render the app and open the recent vault, resolving once the chat pane mounts. */
async function openWorkspace(opts: CreateMockVaultOptions = {}) {
  const result = renderApp({ recents, ...opts });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByText("Neural Assistant AI"); // the chat pane header, in every view
  return result;
}

/** Open Settings from the ribbon cog, navigate to AI, and return the live dialog. */
async function openSettings(user: Awaited<ReturnType<typeof openWorkspace>>["user"]) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "AI" }));
  return dialog;
}

describe("Journey 9: OpenRouter reasoning — opt-in", () => {
  it("is off for a keyed user, and says the tokens are billed", async () => {
    const { user } = await openWorkspace({ apiKey: PROBED_TOGGLE });

    const dialog = await openSettings(user);

    // `ProviderConfig.reasoning` is `#[serde(default)]`, so a config written before
    // the field existed reads back false. The user is never opted in by default.
    const toggle = await within(dialog).findByRole("checkbox", TOGGLE);
    expect(toggle).not.toBeChecked();

    // The cost is stated where the choice is made, not buried in docs.
    expect(
      within(dialog).getByText("Reasoning tokens are billed by OpenRouter."),
    ).toBeInTheDocument();
  });

  it("persists the opt-in across a Settings close and reopen", async () => {
    const { user } = await openWorkspace({ apiKey: PROBED_TOGGLE });

    const dialog = await openSettings(user);
    await user.click(await within(dialog).findByRole("checkbox", TOGGLE));
    expect(await within(dialog).findByRole("checkbox", TOGGLE)).toBeChecked();

    await user.click(within(dialog).getByRole("button", { name: "Close settings" }));
    await screen.findByLabelText("Ask across your vault");

    // Reopening re-reads `ai_status` from the backend. The tick survives, so the
    // write really landed in the config rather than only in React state — this is
    // the round trip `invoke("set_reasoning")` → `invoke("ai_status")`.
    const reopened = await openSettings(user);
    expect(await within(reopened).findByRole("checkbox", TOGGLE)).toBeChecked();
  });

  it("shows the opt-in even when the next status read fails", async () => {
    const { user, backend } = await openWorkspace({ apiKey: PROBED_TOGGLE });

    const dialog = await openSettings(user);
    const toggle = await within(dialog).findByRole("checkbox", TOGGLE);
    expect(toggle).not.toBeChecked();

    // Every `ai_status` read from here on fails. The write itself still succeeds,
    // so reasoning IS persisted — and the box must say so. Rendering the status the
    // write returned is what makes that true; a follow-up read would have been
    // swallowed by `refreshStatus`, leaving the box unticked and the user billed.
    backend.setFailure("ai_status", { kind: "io", message: "config unreadable" });

    await user.click(toggle);

    expect(await within(dialog).findByRole("checkbox", TOGGLE)).toBeChecked();
  });

  it("leaves the box untouched and surfaces the error when the write fails", async () => {
    const { user, backend } = await openWorkspace({ apiKey: PROBED_TOGGLE });

    const dialog = await openSettings(user);
    // Settle the control before arming the failure — the checkbox only exists
    // once the probed control has arrived.
    await within(dialog).findByRole("checkbox", TOGGLE);
    backend.setFailure("set_reasoning", {
      kind: "io",
      message: "could not write your AI settings",
    });

    await user.click(within(dialog).getByRole("checkbox", TOGGLE));

    // Nothing was persisted, so the control never claims the opt-in — and the
    // failure is visible, never a silent no-op.
    expect(
      await within(dialog).findByText("could not write your AI settings"),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", TOGGLE)).not.toBeChecked();
  });

  it("shows a checking state — never a guessed menu — before the probe answers", async () => {
    // Neither the verdict nor the catalogue has answered for this model, which is
    // the real state on every cold launch: the verdict is persisted, the effort
    // menu cache is not. The control must say it is still asking rather than
    // offer a shape it does not have.
    const { user } = await openWorkspace({
      apiKey: { hasKey: true, model: "anthropic/claude-sonnet-4.5" },
    });

    const dialog = await openSettings(user);

    expect(await within(dialog).findByText(/show model reasoning/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox", TOGGLE)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", EFFORT_MENU)).not.toBeInTheDocument();
  });
});

describe("Journey 9b: OpenRouter reasoning — the model's own effort menu", () => {
  it("offers the model's values verbatim, and persists the one that is picked", async () => {
    const { user } = await openWorkspace({ apiKey: PROBED_EFFORTS });

    const dialog = await openSettings(user);
    const menu = await within(dialog).findByRole("combobox", EFFORT_MENU);

    // The catalogue's own names, in the catalogue's own order, plus the one entry
    // the UI adds: "send no effort at all", which is `null` on the wire.
    expect(
      within(menu)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Model default (high)", "xhigh", "high"]);

    await user.selectOptions(menu, "xhigh");

    // Picking an effort is itself the opt-in — that is what choosing one off the
    // menu means — and the status the write returned is what says so.
    expect(await within(dialog).findByRole("checkbox", TOGGLE)).toBeChecked();

    await user.click(within(dialog).getByRole("button", { name: "Close settings" }));
    await screen.findByLabelText("Ask across your vault");

    // The round trip: `invoke("set_reasoning_effort")` → `invoke("ai_status")`.
    const reopened = await openSettings(user);
    expect(await within(reopened).findByRole("combobox", EFFORT_MENU)).toHaveValue("xhigh");
  });

  it("clears back to the model's own default without opting the user out", async () => {
    const { user } = await openWorkspace({
      apiKey: { ...PROBED_EFFORTS, reasoning: true, reasoningEffort: "xhigh" },
    });

    const dialog = await openSettings(user);
    await user.selectOptions(
      await within(dialog).findByRole("combobox", EFFORT_MENU),
      "Model default (high)",
    );

    // Clearing the effort is "take whatever this model does by default", not
    // "stop reasoning" — two different requests, and the opt-in is the other one.
    expect(await within(dialog).findByRole("combobox", EFFORT_MENU)).toHaveValue("");
    expect(within(dialog).getByRole("checkbox", TOGGLE)).toBeChecked();
  });

  it("surfaces a refused effort rather than coercing it to something nearby", async () => {
    const { user, backend } = await openWorkspace({ apiKey: PROBED_EFFORTS });

    const dialog = await openSettings(user);
    await within(dialog).findByRole("combobox", EFFORT_MENU);
    // The shell refuses an effort the currently probed menu does not offer: the
    // menu moved underneath the control, which is a real condition worth seeing.
    // Coercing would send — and bill for — an effort the user never chose.
    backend.setFailure("set_reasoning_effort", {
      kind: "invalidContent",
      message: '"xhigh" is no longer one of this model\'s reasoning efforts (high).',
    });

    await user.selectOptions(within(dialog).getByRole("combobox", EFFORT_MENU), "xhigh");

    expect(
      await within(dialog).findByText(
        /no longer one of this model's reasoning efforts/,
      ),
    ).toBeInTheDocument();
    // Nothing was persisted, so the menu still shows what the config holds.
    expect(within(dialog).getByRole("combobox", EFFORT_MENU)).toHaveValue("");
  });
});
