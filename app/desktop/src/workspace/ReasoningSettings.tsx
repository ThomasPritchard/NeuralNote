// The per-model reasoning control. One shape per `ReasoningControl` variant, and
// nothing that is not in that value: the backend computes the control, this file
// only renders it. `capabilities.rs` states that as the guarantee.
//
// Three things here are load-bearing rather than cosmetic:
//
//   1. **The effort values are the model's own, verbatim and in its own order.**
//      The live catalogue carries 21 distinct menus — `deepseek-v4-flash` offers
//      `["xhigh","high"]` while `deepseek-v4-flash-0731` offers
//      `["max","high","low"]` — so any list, ranking or relabelling compiled in
//      here would be wrong for some model and would silently mis-set what the
//      user asked for. Nothing in this file knows an effort name.
//   2. **The label never leaves.** Four of the five variants have no interactive
//      control, and this pane is where a user lands after changing models. A row
//      that simply vanished would read as a broken pane rather than as a model
//      that can't do the thing; so the label is the anchor and only the
//      affordance beside it changes. "Renders nothing" means renders no CONTROL
//      — never no explanation.
//   3. **The footprint is declared, not emergent.** The affordance row and the
//      hint line both carry a declared minimum height, so `hidden`, `pending`,
//      `toggle` and `locked` occupy exactly the same box: a probe resolving
//      underneath the user moves nothing. Only `efforts` grows, by exactly the
//      one row that holds its menu.

import { useId } from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "../lib/cn";
import type { ReasoningControl } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { InlineError } from "./ProviderCard";
import { reasoningAlwaysOn } from "./reasoningSupport";

/** The `<select>` value standing for "send no effort at all" —
 *  `setReasoningEffort(null)`. It is NOT one of the model's values and never
 *  reaches the wire as one: it is the state the preference starts in, and the
 *  only way back to the provider's own default once a value has been picked.
 *  Empty-string sentinel for the same reason `ApprovalSettings` uses one. */
const MODEL_DEFAULT = "";

const BILLED = "Reasoning tokens are billed by OpenRouter.";

/** The one label, in every state. See note 2 at the top of the file. */
const LABEL = "Show model reasoning";

/** Which affordance sits beside the label. Derived from the variant alone —
 *  whether there is an off position at all is `reasoningAlwaysOn`'s answer, the
 *  same one the composer's chip reads (amendment D1 folded the `"none"` sentinel
 *  into it, so off is one affordance, always, and never a menu item).
 *
 *  Shared rather than re-derived here on purpose: this pane and the composer
 *  render the same fact, and the second copy is what let them tell one model's
 *  user two different things. */
type Affordance = "checkbox" | "alwaysOn" | "checking" | "unavailable";

function affordanceFor(control: ReasoningControl): Affordance {
  switch (control.kind) {
    case "hidden":
      return "unavailable";
    case "pending":
      return "checking";
    case "locked":
    case "toggle":
    case "efforts":
      return reasoningAlwaysOn(control) ? "alwaysOn" : "checkbox";
  }
}

/** The one hint line, which is also the control's accessible description.
 *
 *  `efforts` is the only variant that states the cost in full, and it states it
 *  where the money is actually spent: the chosen effort applies to every
 *  planning round as well as the answer (amendment E1), so a step up the menu
 *  multiplies across a run rather than costing one turn. */
function hintFor(
  control: ReasoningControl,
  model: string,
  reasoningOn: boolean,
): string {
  switch (control.kind) {
    case "hidden":
      return `${model} can't return reasoning.`;
    case "pending":
      return BILLED;
    case "locked":
      return "This model always reasons, so those tokens are billed either way.";
    case "toggle":
      // `default_on` is the MODEL's default, never the user's setting — the
      // checkbox reads the persisted opt-in and nothing else. It earns a line
      // only where it changes what to expect: reasoning the user did not ask
      // for still happens, and still bills.
      return control.defaultOn && !reasoningOn
        ? `${BILLED} This model reasons by default, even with this off.`
        : BILLED;
    case "efforts":
      // Naming an effort opts the user in (that is what picking one off the menu
      // means), so an off control with a live menu is not a trap — but it does
      // need saying before the click, not after.
      //
      // The two are deliberately the same length: they differ on a click the
      // user made, and matching their wrap keeps even that from reflowing.
      return reasoningOn
        ? "The model's own effort names, in its own order. More effort means more billed tokens on every step of a run."
        : "The model's own effort names, in its own order. Picking one turns reasoning on, and bills more on every step.";
  }
}

/** "Model default", naming the effort the model itself preselects when it
 *  publishes one. Surfacing which value that is helps; inventing one does not,
 *  so a model with no published default gets the bare label. */
function modelDefaultLabel(defaultEffort: string | null): string {
  return defaultEffort === null ? "Model default" : `Model default (${defaultEffort})`;
}

function AlwaysOn() {
  return (
    // Not a badge: the accent lives in the icon (a graphic, so 3:1 is the bar
    // and `primary` measures 4.46:1 on this ground) while the words stay in
    // `foreground/90` at 8.97:1. `text-primary` on a `primary/10` chip would
    // have been 3.85:1 — under the 4.5:1 that 11px body text needs.
    <span className="flex shrink-0 items-center gap-1 text-[0.75rem] text-foreground/90">
      <Check className="size-3.5 text-primary" aria-hidden />
      Always on
    </span>
  );
}

function Checking({
  rechecking,
  onRecheck,
}: Readonly<{ rechecking: boolean; onRecheck: () => void }>) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {/* An <output> for the same reason `LoadingRow` is one: implicit
          role="status", so the resolution is announced without stealing focus. */}
      <output className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        Checking…
      </output>
      {/* Settings reads `ai_status` once, on mount. The menu cache is not
          persisted, so a pane opened inside the launch probe window would
          otherwise sit on "checking" for as long as it stayed open. This is the
          way out — and it re-asks the same probe the chat pane runs, so a warm
          cache resolves it immediately.

          The name is FROZEN across both states: the spinner beside it already
          reports the in-flight one, and a label that changed would re-anchor
          every query that finds this button by name. */}
      <button
        type="button"
        onClick={onRecheck}
        disabled={rechecking}
        className={cn(buttonVariants({ tone: "quiet", size: "sm" }), "h-6 px-2 text-[0.6875rem]")}
      >
        Check again
      </button>
    </span>
  );
}

export function ReasoningSettings({
  control,
  model,
  reasoningOn,
  effort,
  saving,
  rechecking,
  error,
  onToggle,
  onPickEffort,
  onRecheck,
}: Readonly<{
  /** What the backend decided this model's control should be. Every shape below
   *  is one of its variants; nothing here is derived from anything else. */
  control: ReasoningControl;
  /** The selected model id, for the one line that names it. Never used to infer
   *  a capability — that is what `control` is for. */
  model: string;
  /** The persisted opt-in. The checkbox's only source of truth, so a model's own
   *  `default_on` can never masquerade as the user's setting. */
  reasoningOn: boolean;
  /** The persisted effort, or `null` for "send none". Only ever a value read off
   *  this model's own menu. */
  effort: string | null;
  /** A preference write is in flight. */
  saving: boolean;
  /** A capability re-check is in flight. */
  rechecking: boolean;
  error: string | null;
  onToggle: () => void;
  onPickEffort: (effort: string | null) => void;
  onRecheck: () => void;
}>) {
  const hintId = useId();
  const effortId = useId();
  const affordance = affordanceFor(control);
  const hint = hintFor(control, model, reasoningOn);

  return (
    <div className="flex flex-col gap-1.5">
      {/* Declared height, not emergent: a checkbox row, a spinner row, a badge
          row and a plain-text row all resolve to the same 1.5rem, so the four
          menu-less variants are the same box and a resolving probe moves
          nothing under the pointer. 1.5rem rather than the 1.25rem the text
          alone needs, because it is also the floor WCAG 2.2 target size asks of
          the two rows that carry something clickable — measured: at 1.25rem the
          re-check button made `pending` 4px taller than every state it resolves
          into, which is the single most common transition this control makes. */}
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        {affordance === "checkbox" ? (
          <label className="flex min-h-6 w-fit cursor-pointer items-center gap-2 text-[0.75rem] text-foreground/90">
            <input
              type="checkbox"
              checked={reasoningOn}
              onChange={onToggle}
              disabled={saving}
              aria-describedby={hintId}
              className="size-3.5 shrink-0 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span>{LABEL}</span>
          </label>
        ) : (
          <span className="text-[0.75rem] text-foreground/90">{LABEL}</span>
        )}

        {affordance === "alwaysOn" && <AlwaysOn />}
        {affordance === "checking" && (
          <Checking rechecking={rechecking} onRecheck={onRecheck} />
        )}
        {affordance === "unavailable" && (
          <span className="shrink-0 text-[0.75rem] text-muted-foreground">
            Unavailable
          </span>
        )}
      </div>

      {control.kind === "efforts" && (
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={effortId}
            className="shrink-0 text-[0.75rem] text-foreground/90"
          >
            Reasoning effort
          </label>
          {/* A native select, so a 2-item menu and a 7-item one occupy exactly
              the same row — the menu length is the model's business, not the
              layout's. `border-muted-foreground/80` rather than the theme
              hairline because this is a control boundary: `border-border`
              measures 1.34:1 against the field it encloses, where WCAG 1.4.11
              wants 3:1. This measures 3.16:1 inside and 5.36:1 out. */}
          <select
            id={effortId}
            value={effort ?? MODEL_DEFAULT}
            disabled={saving}
            aria-describedby={hintId}
            onChange={(event) =>
              onPickEffort(
                event.target.value === MODEL_DEFAULT ? null : event.target.value,
              )
            }
            className="nn-mono min-w-0 max-w-[16rem] flex-1 rounded-md border border-muted-foreground/80 bg-input px-2 py-1 text-[0.6875rem] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value={MODEL_DEFAULT}>
              {modelDefaultLabel(control.defaultEffort)}
            </option>
            {/* Verbatim, in the order the model published them. No sort, no
                relabel, no compiled-in tier scale. */}
            {control.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* `2lh` — exactly two of this paragraph's own lines — so a one-line hint
          and a two-line one leave the block the same height. A pixel figure here
          would go stale the moment the type scale moved. */}
      <p
        id={hintId}
        className="min-h-[2lh] text-[0.6875rem] leading-snug text-muted-foreground"
      >
        {hint}
      </p>

      {error && <InlineError alert>{error}</InlineError>}
    </div>
  );
}
