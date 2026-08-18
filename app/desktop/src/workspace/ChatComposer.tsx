// The chat pane's composer footer: the error notices (stop / reasoning), the
// active-skill chip row, the `@` suggestion popup, the input + send/stop button,
// and the meta strip (model menu, reasoning opt-in chip, keyboard hint). Purely
// presentational — every value and handler is supplied by the pane's hooks.
//
// The reasoning affordance has two shapes, and which one renders is a fact about
// the model rather than a style: where the model publishes no off position there
// is nothing to write, so it is a READOUT and not a control. A pressable chip
// that silently does nothing is the worse of the two failures — the click looks
// broken rather than the model looking mandatory — and a `button` with
// `aria-pressed` announces itself as a toggle to a screen reader whatever the
// pixels do.

import {
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { AlertTriangle, Brain, Loader2, Send, Square } from "lucide-react";
import { cn } from "../lib/cn";
import type { AiStatus, SkillListing } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { ChatModelMenu } from "./ChatModelMenu";
import type { ReasoningCapability } from "./reasoningSupport";
import type { SkillPickerEntry } from "./skillAutocomplete";
import {
  SkillChips,
  SkillSuggestions,
  SKILL_LISTBOX_ID,
  skillOptionId,
  type SkillPickerNotice,
} from "./SkillPicker";

/** The box both reasoning shapes wear — identical geometry and type, so what
 *  changes on a model switch is what the strip SAYS and never what it occupies.
 *  Load-bearing: the strip has no slack at the docked width (376px holds a
 *  114.8px model menu, an 83.2px chip and a keyboard hint that already wraps),
 *  so a shape one word wider does not push anything aside — it wraps the pill
 *  itself onto three lines and grows the composer by 30px. Measured. */
const REASONING_CHIP =
  "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium";

/** The on colours. `text-primary` in both shapes: "reasoning is on" must not
 *  look like two different facts depending on who decided it. */
const REASONING_ON = "text-primary";

/** Reasoning on a model that cannot be told not to — a state, not an affordance.
 *
 *  A `<span>`, so nothing announces a pressed state that cannot change and
 *  nothing takes a tab stop that leads nowhere. What tells it from the control
 *  is the app's own state idiom, the one Settings already uses for this exact
 *  fact: the accent lives in the word and the glyph, and the pill's fill and
 *  ring — the two things that read as a button's boundary — are gone. Under a
 *  pointer it says the same thing again, with no hover response and no hand
 *  cursor before the click rather than after it.
 *
 *  The sentence itself has nowhere visible to go on a strip with no spare
 *  pixels, so it is carried where it costs none: in the accessible name, and in
 *  the hover title for anyone who asks. */
function ReasoningState() {
  return (
    <span
      title="This model always reasons — it can't be turned off."
      className={cn(REASONING_CHIP, REASONING_ON, "cursor-default")}
    >
      <Brain className="size-3 shrink-0" aria-hidden />
      Reasoning
      <span className="sr-only">, always on</span>
    </span>
  );
}

function ComposerActionButton({
  buttonRef,
  busy,
  stopping,
  inputEmpty,
  onSend,
  onCancel,
}: Readonly<{
  buttonRef: RefObject<HTMLButtonElement | null>;
  busy: boolean;
  stopping: boolean;
  inputEmpty: boolean;
  onSend: () => void;
  onCancel: () => void;
}>) {
  const label = busy ? (stopping ? "Stopping" : "Stop response") : "Send";
  const disabled = busy ? stopping : inputEmpty;
  let icon = <Send className="size-4" aria-hidden />;
  if (busy) {
    icon = stopping ? (
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
    ) : (
      <Square className="size-3.5 fill-current" aria-hidden />
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={busy ? onCancel : onSend}
      disabled={disabled}
      aria-label={label}
      className={cn(buttonVariants({ tone: "chat", size: "icon" }), "size-9")}
    >
      {icon}
    </button>
  );
}

export function ChatComposer({
  stopError,
  reasoningError,
  activeSkills,
  onRemoveSkill,
  pickerOpen,
  suggestions,
  pickerNotice,
  pickerActive,
  onPickSkill,
  onHoverSkill,
  composerRef,
  composerActionRef,
  input,
  busy,
  stopping,
  onInputChange,
  onComposerKeyDown,
  syncCaret,
  onComposerBlur,
  onComposerFocus,
  onSend,
  onCancel,
  status,
  onStatusChange,
  onOpenSettings,
  onToggleReasoning,
  savingReasoning,
  capability,
  reasoningIndicatorOn,
  reasoningLocked,
  reasoningReasonId,
}: Readonly<{
  stopError: string | null;
  reasoningError: string | null;
  activeSkills: SkillPickerEntry[];
  onRemoveSkill: (id: string) => void;
  pickerOpen: boolean;
  suggestions: SkillListing[];
  pickerNotice: SkillPickerNotice | null;
  pickerActive: number;
  onPickSkill: (skill: SkillPickerEntry) => void;
  onHoverSkill: (index: number) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  composerActionRef: RefObject<HTMLButtonElement | null>;
  input: string;
  busy: boolean;
  stopping: boolean;
  onInputChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onComposerKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  syncCaret: (e: { currentTarget: HTMLTextAreaElement }) => void;
  onComposerBlur: () => void;
  onComposerFocus: () => void;
  onSend: () => void;
  onCancel: () => void;
  status: AiStatus | null;
  onStatusChange: (next: AiStatus) => void;
  onOpenSettings: () => void;
  onToggleReasoning: () => void;
  savingReasoning: boolean;
  capability: ReasoningCapability;
  /** Whether the reasoning affordance reads as ON — the persisted opt-in OR a
   *  model whose reasoning cannot be turned off. Derived by
   *  `useChatPaneProvider`; this file renders it and derives nothing. */
  reasoningIndicatorOn: boolean;
  /** This model reasons on every turn and the persisted opt-in cannot stop it,
   *  so there is no off position to write and `toggleReasoning` is a no-op.
   *  `reasoningAlwaysOn`'s answer, read where the fact is rendered — the same
   *  one Settings reads for its "Always on" affordance. */
  reasoningLocked: boolean;
  reasoningReasonId: string;
}>) {
  return (
    <div className="shrink-0 border-t border-border px-4 pb-3 pt-3">
      {stopError && (
        <p
          role="alert"
          className="mb-2 flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[0.6875rem] leading-snug text-destructive"
        >
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
          {stopError}
        </p>
      )}
      {reasoningError && (
        // The pane's error voice (mirrors the turn error box), announced:
        // a toggle that silently failed to persist would misbill the user.
        <p
          role="alert"
          className="mb-2 flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[0.6875rem] leading-snug text-destructive"
        >
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{reasoningError}</span>
        </p>
      )}
      <SkillChips skills={activeSkills} onRemove={onRemoveSkill} />
      <div className="relative">
        {pickerOpen && (
          <SkillSuggestions
            suggestions={suggestions}
            notice={suggestions.length === 0 ? pickerNotice : null}
            active={pickerActive}
            onPick={onPickSkill}
            onHover={onHoverSkill}
          />
        )}
        <div className="flex items-end gap-2 rounded-xl bg-background/40 p-2 ring-1 ring-inset ring-border transition focus-within:bg-background/60 focus-within:ring-2 focus-within:ring-ring">
        <textarea
          ref={composerRef}
          rows={1}
          value={input}
          disabled={busy}
          onChange={onInputChange}
          onKeyDown={onComposerKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onBlur={onComposerBlur}
          // Coming back to the composer is a fresh session for the
          // popup: a blur-dismissal must not outlive it (the key alone
          // can collide with an identically retyped trigger).
          onFocus={onComposerFocus}
          aria-label="Ask across your vault"
          aria-autocomplete="list"
          // The listbox exists only when there are options — a popup
          // showing the quiet loading/error line is not a listbox, so
          // the combobox wiring stays off until options render.
          aria-controls={suggestions.length > 0 ? SKILL_LISTBOX_ID : undefined}
          aria-activedescendant={
            suggestions.length > 0 ? skillOptionId(pickerActive) : undefined
          }
          placeholder="Ask across your vault…"
          className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[0.8125rem] leading-5 placeholder:text-muted-foreground/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <ComposerActionButton
          buttonRef={composerActionRef}
          busy={busy}
          stopping={stopping}
          inputEmpty={input.trim() === ""}
          onSend={onSend}
          onCancel={onCancel}
        />
        </div>
      </div>
      {/* The composer's meta strip: the reasoning opt-in on the left (a
          quiet chip — it changes what the next turn requests, so it lives
          at the point of send), the keyboard hint on the right. */}
      <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-1">
          {status && (
            <ChatModelMenu
              status={status}
              busy={busy}
              onStatusChange={onStatusChange}
              onOpenSettings={onOpenSettings}
            />
          )}
          {reasoningLocked ? (
            <ReasoningState />
          ) : (
            <button
            type="button"
            onClick={onToggleReasoning}
            // Two different inert states, split on purpose. A write in
            // flight is transient — native disabled is fine. "unsupported"
            // is EXPLANATORY: aria-disabled keeps the chip focusable so a
            // keyboard/SR user can reach it and get the why (the visible
            // line below, wired via aria-describedby); the click guard
            // lives in toggleReasoning.
            //
            // The third inert state is not here at all: a mandatory model
            // renders the readout above instead, because "inert with an
            // explanation" and "not a control in the first place" are
            // different facts and only one of them is a button.
            disabled={savingReasoning}
            aria-disabled={capability.disabled || undefined}
            aria-pressed={reasoningIndicatorOn}
            aria-label="Show model reasoning"
            aria-describedby={capability.reason ? reasoningReasonId : undefined}
            className={cn(
              REASONING_CHIP,
              "ring-1 ring-inset transition-colors motion-reduce:transition-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              reasoningIndicatorOn
                ? cn(REASONING_ON, "bg-primary/10 ring-primary/30")
                : "text-muted-foreground ring-border",
              savingReasoning || capability.disabled
                ? "cursor-not-allowed opacity-50"
                : !reasoningIndicatorOn && "hover:bg-muted hover:text-foreground",
            )}
            >
              <Brain className="size-3 shrink-0" aria-hidden />
              Reasoning
            </button>
          )}
        </div>
        <p className="nn-compact-label text-right text-[0.625rem] leading-none text-muted-foreground/60">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
      {capability.reason && (
        // Not hover-only, not SR-only: the persistent "why" is a plain
        // visible line every user can perceive, and it doubles as the
        // chip's accessible description.
        <p
          id={reasoningReasonId}
          className="mt-1 px-1 text-[0.625rem] leading-snug text-muted-foreground/70"
        >
          {capability.reason}
        </p>
      )}
    </div>
  );
}
