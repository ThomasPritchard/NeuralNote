// The chat pane's composer footer: the error notices (stop / reasoning), the
// active-skill chip row, the `@` suggestion popup, the input + send/stop button,
// and the meta strip (model menu, reasoning opt-in chip, keyboard hint). Purely
// presentational — every value and handler is supplied by the pane's hooks.

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
  reasoningOn,
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
  reasoningOn: boolean;
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
          <button
          type="button"
          onClick={onToggleReasoning}
          // Two different inert states, split on purpose. A write in
          // flight is transient — native disabled is fine. "unsupported"
          // is EXPLANATORY: aria-disabled keeps the chip focusable so a
          // keyboard/SR user can reach it and get the why (the visible
          // line below, wired via aria-describedby); the click guard
          // lives in toggleReasoning.
          disabled={savingReasoning}
          aria-disabled={capability.disabled || undefined}
          aria-pressed={reasoningOn}
          aria-label="Show model reasoning"
          aria-describedby={capability.reason ? reasoningReasonId : undefined}
          className={cn(
            "flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ring-1 ring-inset transition-colors motion-reduce:transition-none",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            reasoningOn
              ? "bg-primary/10 text-primary ring-primary/30"
              : "text-muted-foreground ring-border",
            savingReasoning || capability.disabled
              ? "cursor-not-allowed opacity-50"
              : !reasoningOn && "hover:bg-muted hover:text-foreground",
          )}
          >
            <Brain className="size-3 shrink-0" aria-hidden />
            Reasoning
          </button>
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
