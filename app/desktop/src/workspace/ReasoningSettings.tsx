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
//   4. **A substitution is shown, never implied.** When the model's menu stops
//      accepting the stored effort the backend keeps the preference and sends
//      something else (amendment E3). Rendering only the menu would leave the
//      control blank — a value that is not on the list it draws from — while
//      every run bills for the substitute. So the stored value stays visible in
//      the control that owns it, and one line says what is going out instead.

import { useId } from "react";
import { Check, Info, Loader2 } from "lucide-react";
import { cn } from "../lib/cn";
import type { ReasoningControl, ReasoningEffortOverride } from "../lib/types";
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

/** The group the orphaned choice sits in, so the model's own list stays exactly
 *  the model's own list. The value inside it is still rendered verbatim — what
 *  the group says is that it is no longer on offer, which is a fact about
 *  availability rather than a claim about what the effort means. */
const ORPHAN_GROUP = "No longer offered";

/** The substitution, in one sentence, in the pane's own vocabulary ("a run" is
 *  what the hint beside it already calls the thing being billed).
 *
 *  Two shapes, near-identical in length on purpose (85 and 88 characters at the
 *  catalogue's own values): they differ by whether the model publishes a default
 *  — nothing the user did — so they must not lay out differently. Measured in
 *  the browser tier at 578px, which is this element's width in the narrowest
 *  window the app will open: `min(920 − 32, max-w-4xl)` − 192 (nav) − 48
 *  (`sm:px-6`) − 32 (card `p-4`) − 20 (own `px-2.5`) − 18 (glyph + gap). Both
 *  are one line there, and no `min-h` reservation is taken because a slot held
 *  open for a state almost nobody is in shows as a blank second line for
 *  everybody who is.
 *
 *  Deliberately NOT the error voice. Nothing failed — the model changed what it
 *  publishes, the preference is intact, and it applies again the moment the menu
 *  carries it. The reassurance is the last clause, and it is the reason this
 *  reads as an explanation rather than as a write that went wrong. */
function EffortOverrideNotice({
  id,
  override,
}: Readonly<{ id: string; override: ReasoningEffortOverride }>) {
  return (
    // A quiet well, not a tinted banner: it is told apart from the hint below it
    // by its ground, never by hue — the destructive and warning tones both say
    // "something needs fixing", which is the opposite of what happened. The
    // idiom is the key form's (`bg-background/50` + the theme hairline) at one
    // step smaller.
    <p
      id={id}
      className="flex items-start gap-1.5 rounded-md bg-background/50 px-2.5 py-1.5 text-[0.6875rem] leading-snug text-foreground/80 ring-1 ring-inset ring-border"
    >
      <Info className="mt-px size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 break-words">
        This model no longer offers <Effort value={override.stored} />, so runs{" "}
        {override.sending === null ? (
          "use its default"
        ) : (
          <>
            ask for <Effort value={override.sending} />
          </>
        )}{" "}
        instead. Your choice is kept.
      </span>
    </p>
  );
}

/** One effort value inside prose. Mono and a shade brighter than the sentence
 *  around it, so the two values a reader is comparing are the two things that
 *  stand out — typography carrying the emphasis, not a colour. */
function Effort({ value }: Readonly<{ value: string }>) {
  return <span className="nn-mono text-foreground">{value}</span>;
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
  effortOverride,
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
  /** The substitution the send path is applying right now, or `null` when what
   *  the user chose is what goes out. Present only while the current menu will
   *  not accept the stored effort — which is also the only way `effort` above
   *  can fail to match an option, so this is what keeps the control from
   *  rendering blank. Not derived here: the backend resolved it with the same
   *  call the send path uses. */
  effortOverride: ReasoningEffortOverride | null;
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
  const overrideId = useId();
  const affordance = affordanceFor(control);
  const hint = hintFor(control, model, reasoningOn);
  // The news before the standing description: a screen-reader user hears what
  // this model is doing with their setting first, and the general account of the
  // menu second. One string for both controls, because only one of them exists
  // at a time and the substitution is a fact about the whole setting.
  const describedBy =
    effortOverride === null ? hintId : `${overrideId} ${hintId}`;

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
              aria-describedby={describedBy}
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
            aria-describedby={describedBy}
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
            {/* The stored value, kept in the control so it never renders blank —
                a `<select>` whose value matches no option shows nothing at all,
                which reads as a setting that was lost rather than one that is
                being substituted. Disabled because it cannot be sent: it is
                here to be SEEN, and picking it again would only re-store what is
                already stored. Last, and in its own group, so the model's own
                menu stays contiguous above it. */}
            {effortOverride !== null && (
              <optgroup label={ORPHAN_GROUP}>
                <option value={effortOverride.stored} disabled>
                  {effortOverride.stored}
                </option>
              </optgroup>
            )}
          </select>
        </div>
      )}

      {/* Under the control it explains and above the standing hint, so nothing
          the user can operate moves when it appears. Absent is the ordinary
          case and costs exactly nothing: there is no reserved slot, because a
          slot held open for a state almost no one is in is a permanent tax to
          avoid a one-off growth at the bottom of a block. */}
      {effortOverride !== null && (
        <EffortOverrideNotice id={overrideId} override={effortOverride} />
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
