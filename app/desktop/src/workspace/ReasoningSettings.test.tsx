// The per-model reasoning control, one `ReasoningControl` variant at a time.
//
// The two cases a later change is most likely to break in silence get their own
// tests and their own reasons:
//
//   * `hidden` must render NO control. A checkbox that crept back would let a
//     user opt into reasoning on a model that cannot return any.
//   * `pending` must render NO menu. Locked decision 2 forbids guessing one, and
//     the shape a guess would take — yesterday's options, greyed out — looks
//     exactly like a working control.
//
// The effort values are the model's own, so the suite drives the two real
// catalogue menus that share a family and share nothing else:
// `deepseek-v4-flash` = ["xhigh","high"], `deepseek-v4-flash-0731` =
// ["max","high","low"]. Anything compiled into the component would be wrong for
// one of them.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReasoningControl } from "../lib/types";
import { ReasoningSettings } from "./ReasoningSettings";

const MODEL = "deepseek/deepseek-v4-flash";
const LABEL = "Show model reasoning";
const BILLED = "Reasoning tokens are billed by OpenRouter.";

function setup(
  control: ReasoningControl,
  patch: Partial<Parameters<typeof ReasoningSettings>[0]> = {},
) {
  const onToggle = vi.fn();
  const onPickEffort = vi.fn();
  const onRecheck = vi.fn();
  const view = render(
    <ReasoningSettings
      control={control}
      model={MODEL}
      reasoningOn={false}
      effort={null}
      saving={false}
      rechecking={false}
      error={null}
      onToggle={onToggle}
      onPickEffort={onPickEffort}
      onRecheck={onRecheck}
      {...patch}
    />,
  );
  return { ...view, user: userEvent.setup(), onToggle, onPickEffort, onRecheck };
}

describe("ReasoningSettings — hidden", () => {
  it("renders no control at all, and says why the setting is inert", () => {
    setup({ kind: "hidden" });

    // The three shapes a control could take here. None of them may exist: this
    // model cannot reason, so there is nothing to opt into, pick or re-ask.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    // But the row does not silently disappear either — the label stays put and
    // the reason names the model, so switching to a model that cannot reason
    // reads as a fact about that model rather than as a broken pane.
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(`${MODEL} can't return reasoning.`),
    ).toBeInTheDocument();
    // No billing note for a setting that can't spend anything.
    expect(screen.queryByText(BILLED)).not.toBeInTheDocument();
  });
});

describe("ReasoningSettings — pending", () => {
  it("renders a checking state and never a menu", () => {
    setup({ kind: "pending" });

    // The whole of locked decision 2: no menu may exist before the probe has
    // answered, and no opt-in may pretend the shape is already known.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/effort/i)).not.toBeInTheDocument();

    expect(screen.getByRole("status")).toHaveTextContent("Checking…");
    expect(screen.getByText(LABEL)).toBeInTheDocument();
  });

  it("offers a way out of a pending state that nothing else would resolve", async () => {
    const { user, onRecheck } = setup({ kind: "pending" });

    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(onRecheck).toHaveBeenCalledOnce();
  });

  it("disables the re-check while one is in flight, keeping its name", () => {
    // The name is the anchor every query uses; the spinner beside it is what
    // reports the in-flight state.
    setup({ kind: "pending" }, { rechecking: true });

    expect(screen.getByRole("button", { name: "Check again" })).toBeDisabled();
  });
});

describe("ReasoningSettings — toggle", () => {
  it("renders an on/off switch and no effort menu", () => {
    setup({ kind: "toggle", defaultOn: false });

    expect(screen.getByRole("checkbox", { name: LABEL })).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: LABEL })).toHaveAccessibleDescription(
      BILLED,
    );
  });

  it("reads the persisted opt-in, never the model's own default", () => {
    // `default_on` describes what the MODEL does, not what the user chose.
    // Letting it tick the box would show a setting nobody made — and this is the
    // billed one, so the box has to mean exactly what the config holds.
    setup({ kind: "toggle", defaultOn: true }, { reasoningOn: false });

    expect(screen.getByRole("checkbox", { name: LABEL })).not.toBeChecked();
  });

  it("says so when the model reasons by default and the user is opted out", () => {
    setup({ kind: "toggle", defaultOn: true }, { reasoningOn: false });

    expect(
      screen.getByText(
        `${BILLED} This model reasons by default, even with this off.`,
      ),
    ).toBeInTheDocument();
  });

  it("drops that line once the user is opted in — it only changes an off state", () => {
    setup({ kind: "toggle", defaultOn: true }, { reasoningOn: true });

    expect(screen.getByRole("checkbox", { name: LABEL })).toBeChecked();
    expect(screen.getByText(BILLED)).toBeInTheDocument();
  });

  it("reports a toggle without deciding the next state itself", async () => {
    const { user, onToggle } = setup({ kind: "toggle", defaultOn: false });

    await user.click(screen.getByRole("checkbox", { name: LABEL }));

    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("ReasoningSettings — locked", () => {
  it("shows reasoning as on and gives no control to move", () => {
    setup({ kind: "locked" });

    // Not a toggle the user can fail to move, and not an empty row either.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.getByText("Always on")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This model always reasons, so those tokens are billed either way.",
      ),
    ).toBeInTheDocument();
  });
});

/** The rendered menu, minus the "no effort at all" entry the component adds. */
function renderedEfforts() {
  const menu = screen.getByRole("combobox", { name: "Reasoning effort" });
  return within(menu)
    .getAllByRole("option")
    .map((option) => option.textContent)
    .slice(1);
}

describe("ReasoningSettings — efforts", () => {
  const FLASH: ReasoningControl = {
    kind: "efforts",
    options: ["xhigh", "high"],
    defaultEffort: "high",
    canDisable: true,
  };
  const FLASH_0731: ReasoningControl = {
    kind: "efforts",
    options: ["max", "high", "low"],
    defaultEffort: null,
    canDisable: true,
  };

  it("renders the model's own values, verbatim and in its own order", () => {
    setup(FLASH);

    expect(renderedEfforts()).toEqual(["xhigh", "high"]);
  });

  it("renders a disjoint menu from the same model family just as literally", () => {
    // Same family, nothing in common but "high". A component that knew a tier
    // scale would have to be wrong about one of these two.
    setup(FLASH_0731);

    expect(renderedEfforts()).toEqual(["max", "high", "low"]);
  });

  it("survives a seven-value menu without reordering or truncating it", () => {
    const options = ["max", "xhigh", "high", "medium", "low", "minimal", "off-peak"];
    setup({ kind: "efforts", options, defaultEffort: "medium", canDisable: true });

    expect(renderedEfforts()).toEqual(options);
  });

  it("names the model's own preselected effort on the no-effort entry", () => {
    setup(FLASH);

    expect(
      within(screen.getByRole("combobox", { name: "Reasoning effort" })).getByRole(
        "option",
        { name: "Model default (high)" },
      ),
    ).toBeInTheDocument();
  });

  it("invents no default when the model publishes none", () => {
    setup(FLASH_0731);

    const menu = screen.getByRole("combobox", { name: "Reasoning effort" });
    expect(within(menu).getByRole("option", { name: "Model default" })).toBeInTheDocument();
    expect(within(menu).queryByRole("option", { name: /Model default \(/ })).not.toBeInTheDocument();
  });

  it("selects the persisted effort, and the no-effort entry when there is none", () => {
    const { unmount } = setup(FLASH, { effort: "xhigh", reasoningOn: true });
    expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toHaveValue("xhigh");
    unmount();

    setup(FLASH, { effort: null, reasoningOn: true });
    expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toHaveValue("");
  });

  it("reports the chosen value exactly as the model spelled it", async () => {
    const { user, onPickEffort } = setup(FLASH);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Reasoning effort" }),
      "xhigh",
    );

    expect(onPickEffort).toHaveBeenCalledExactlyOnceWith("xhigh");
  });

  it("reports the no-effort entry as null, not as a value", async () => {
    // The way back to the provider's own default once a value has been picked.
    // Sending a string here would set an effort the user just cleared.
    const { user, onPickEffort } = setup(FLASH, { effort: "xhigh", reasoningOn: true });

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Reasoning effort" }),
      "Model default (high)",
    );

    expect(onPickEffort).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("offers the off switch when the model has an off position", () => {
    setup(FLASH, { reasoningOn: true });

    expect(screen.getByRole("checkbox", { name: LABEL })).toBeChecked();
    expect(screen.queryByText("Always on")).not.toBeInTheDocument();
  });

  it("offers no off switch when the model has none — the menu still stands", () => {
    // `can_disable: false` is the whole of "there is genuinely no off position".
    // A checkbox here would be a control that cannot do what it says.
    setup({ ...FLASH, canDisable: false }, { reasoningOn: true });

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("Always on")).toBeInTheDocument();
    expect(renderedEfforts()).toEqual(["xhigh", "high"]);
  });

  it("states the run-wide cost of a step up the menu", () => {
    // The chosen effort applies to every planning round as well as the answer
    // (amendment E1), so the cost is multiplied across a run rather than paid
    // once. Saying so at the point of choice is the only place it lands.
    setup(FLASH, { reasoningOn: true });

    expect(
      screen.getByRole("combobox", { name: "Reasoning effort" }),
    ).toHaveAccessibleDescription(
      "The model's own effort names, in its own order. More effort means more billed tokens on every step of a run.",
    );
  });

  it("warns that picking an effort is itself the opt-in", () => {
    setup(FLASH, { reasoningOn: false });

    expect(
      screen.getByText(/Picking one turns reasoning on, and bills more/),
    ).toBeInTheDocument();
  });
});

describe("ReasoningSettings — write states", () => {
  it("locks the controls while a preference write is in flight", () => {
    setup(
      { kind: "efforts", options: ["high"], defaultEffort: null, canDisable: true },
      { saving: true },
    );

    expect(screen.getByRole("checkbox", { name: LABEL })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toBeDisabled();
  });

  it("surfaces a rejected write next to the control it belongs to", () => {
    setup(
      { kind: "toggle", defaultOn: false },
      { error: "\"xhigh\" is no longer one of this model's reasoning efforts" },
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "\"xhigh\" is no longer one of this model's reasoning efforts",
    );
  });
});
