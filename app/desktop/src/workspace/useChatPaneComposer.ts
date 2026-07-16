// The chat pane's composer concern: the controlled input buffer + caret, the
// `@` skill-picker popup (a pure derivation of buffer + caret + the async
// catalogue), the removable-chip authority over `activeSkills`, and the
// send/focus wiring. The trigger is a pure function of value + caret, exactly
// like the editor's `[[` autocomplete. `activeSkills` is owned by the pane and
// shared with the turn loop, so it (and its setter) arrive as inputs here.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { SkillListing } from "../lib/types";
import {
  filterSkillSuggestions,
  findSkillTrigger,
  removeSkillTrigger,
  type SkillPickerEntry,
  type SkillTrigger,
} from "./skillAutocomplete";
import type { SkillPickerNotice } from "./SkillPicker";

/** The backend skill catalogue as an explicit state machine: until the load
 *  resolves the picker can neither offer skills nor claim there are none —
 *  "not yet known" must never silently read as "no skills" (the same union
 *  discipline as LocalAiCard's installed-model scan). */
type SkillsCatalogue =
  | { status: "loading" }
  | { status: "ready"; skills: SkillListing[] }
  | { status: "error"; message: string };

/** While the catalogue isn't usable yet, an active trigger still opens the
 *  popup — showing this quiet loading/error line instead of options, so typing
 *  `@` during the load never looks like "there are no skills". */
function skillPickerNotice(
  catalogue: SkillsCatalogue,
): SkillPickerNotice | null {
  if (catalogue.status === "loading") {
    return { kind: "loading", message: "Loading skills…" };
  }
  if (catalogue.status === "error") {
    return {
      kind: "error",
      message: `Couldn't load skills: ${catalogue.message}`,
    };
  }
  return null;
}

/** What the composer's `@` popup shows for one render. */
interface SkillPickerState {
  trigger: SkillTrigger | null;
  /** Identity of the current trigger — Escape/blur dismissals are keyed to it,
   *  so typing another character re-derives the key and may reopen the popup. */
  triggerKey: string | null;
  suggestions: SkillListing[];
  notice: SkillPickerNotice | null;
  open: boolean;
  active: number;
}

/** Derive the `@` picker's render state from the composer buffer, the caret,
 *  and the async catalogue. A pure function of its inputs, exactly like the
 *  trigger itself (the editor's `[[` autocomplete discipline). */
function deriveSkillPicker(args: {
  input: string;
  caret: number;
  dismissedKey: string | null;
  pickerIndex: number;
  catalogue: SkillsCatalogue;
  activeSkills: readonly SkillPickerEntry[];
}): SkillPickerState {
  const { input, caret, dismissedKey, pickerIndex, catalogue, activeSkills } =
    args;
  const trigger = findSkillTrigger(input, caret);
  const triggerKey =
    trigger === null ? null : `${trigger.start}:${trigger.query}`;
  // Only enabled skills are offerable — activation authority stays with the
  // Rust `SkillRegistry`, and offering a disabled skill would set up a
  // guaranteed "could not be activated" notice.
  const offerableSkills =
    catalogue.status === "ready"
      ? catalogue.skills.filter((s) => s.enabled)
      : [];
  const suggestions =
    trigger !== null && triggerKey !== dismissedKey
      ? filterSkillSuggestions(
          offerableSkills,
          trigger.query,
          activeSkills.map((s) => s.id),
        )
      : [];
  const notice = skillPickerNotice(catalogue);
  const open =
    suggestions.length > 0 ||
    (trigger !== null && triggerKey !== dismissedKey && notice !== null);
  return {
    trigger,
    triggerKey,
    suggestions,
    notice,
    open,
    active:
      suggestions.length > 0 ? Math.min(pickerIndex, suggestions.length - 1) : 0,
  };
}

export interface ChatPaneComposer {
  composerRef: RefObject<HTMLTextAreaElement | null>;
  composerActionRef: RefObject<HTMLButtonElement | null>;
  input: string;
  suggestions: SkillListing[];
  pickerNotice: SkillPickerNotice | null;
  pickerOpen: boolean;
  pickerActive: number;
  setPickerIndex: Dispatch<SetStateAction<number>>;
  pickSkill: (skill: SkillPickerEntry) => void;
  removeSkill: (id: string) => void;
  send: () => void;
  syncCaret: (e: { currentTarget: HTMLTextAreaElement }) => void;
  onInputChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onComposerKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onComposerBlur: () => void;
  onComposerFocus: () => void;
}

/** Own the composer buffer, the `@` picker, and the send/focus wiring. `busy`
 *  and `sendPrompt` come from the turn loop; `activeSkills` (+ its setter) from
 *  the pane, so a picked chip and the next send share one field. */
export function useChatPaneComposer({
  busy,
  sendPrompt,
  activeSkills,
  setActiveSkills,
  reportError,
  refreshSignal,
}: {
  busy: boolean;
  sendPrompt: (prompt: string) => void;
  activeSkills: SkillPickerEntry[];
  setActiveSkills: Dispatch<SetStateAction<SkillPickerEntry[]>>;
  reportError: (message: string) => void;
  refreshSignal: number;
}): ChatPaneComposer {
  // The backend catalogue the picker offers (Settings › Skills is the other
  // consumer). Loaded on mount and re-read whenever Settings closes — the one
  // place a skill's enabled state can change out from under the picker.
  const [skillsCatalogue, setSkillsCatalogue] = useState<SkillsCatalogue>({
    status: "loading",
  });
  // Ref mirror (the messagesRef idiom): the catalogue effect's failure handler
  // needs to know whether a last-good catalogue exists, without the effect
  // re-running on every catalogue change.
  const skillsCatalogueRef = useRef(skillsCatalogue);
  skillsCatalogueRef.current = skillsCatalogue;
  const [input, setInput] = useState("");
  // The caret mirrors the textarea's selectionStart (the trigger is a pure
  // function of value + caret, exactly like the editor's `[[` autocomplete).
  const [caret, setCaret] = useState(0);
  const [pickerIndex, setPickerIndex] = useState(0);
  // Escape/blur dismiss the popup for the CURRENT trigger text only — typing
  // another character re-derives the key and the popup may reopen.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerActionRef = useRef<HTMLButtonElement>(null);
  const composerRunOwnsFocusRef = useRef(false);
  const previousBusyRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);

  useEffect(() => {
    if (busy === previousBusyRef.current) return;

    if (busy && composerRunOwnsFocusRef.current) {
      composerActionRef.current?.focus();
    } else if (!busy && composerRunOwnsFocusRef.current) {
      composerRunOwnsFocusRef.current = false;
      composerRef.current?.focus();
    }

    previousBusyRef.current = busy;
  }, [busy]);

  // Load the picker's catalogue. `refreshSignal` bumps when Settings closes,
  // so a skill toggled there is reflected without remounting the pane. A
  // failed REFRESH keeps the last good catalogue on screen (stale beats
  // blank) but still surfaces the failure on the pane's shared error channel
  // — exactly like a failed `aiStatus` read; only a load with nothing to fall
  // back on lands on the quiet in-picker error line instead, surfaced where
  // the data is consumed. Either way, never silent.
  useEffect(() => {
    let cancelled = false;
    api
      .listSkills()
      .then((skills) => {
        if (!cancelled) setSkillsCatalogue({ status: "ready", skills });
      })
      .catch((e) => {
        if (cancelled) return;
        if (skillsCatalogueRef.current.status === "ready") {
          reportError(errorMessage(e));
        } else {
          setSkillsCatalogue({ status: "error", message: errorMessage(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshSignal, reportError]);

  // The popup's render state is a pure derivation of buffer + caret + the
  // async catalogue — see `deriveSkillPicker` for the offerability and
  // loading/error-notice rules.
  const {
    trigger,
    triggerKey,
    suggestions,
    notice: pickerNotice,
    open: pickerOpen,
    active: pickerActive,
  } = deriveSkillPicker({
    input,
    caret,
    dismissedKey,
    pickerIndex,
    catalogue: skillsCatalogue,
    activeSkills,
  });

  // A changed trigger is a new search: highlight from the top again.
  useEffect(() => {
    setPickerIndex(0);
  }, [triggerKey]);

  // Restore the caret after a pick edits the buffer mid-text (a controlled
  // textarea moves the caret to the end on programmatic value changes).
  useEffect(() => {
    if (pendingCaretRef.current === null) return;
    composerRef.current?.setSelectionRange(
      pendingCaretRef.current,
      pendingCaretRef.current,
    );
    pendingCaretRef.current = null;
  }, [input]);

  /** Run one chat turn. Shared by the composer and by a dormant elicitation's
   *  late answer (which is an ordinary turn by design — spec §3.4). */
  const send = useCallback(() => {
    const prompt = input.trim();
    if (prompt === "" || busy) return;
    composerRunOwnsFocusRef.current = true;
    setInput("");
    sendPrompt(prompt);
  }, [input, busy, sendPrompt]);

  /** Swap the typed `@query` for a chip; the picker and the chips both feed
   *  the same `activeSkills` field on the next send. */
  const pickSkill = useCallback(
    (skill: SkillPickerEntry) => {
      if (trigger === null) return;
      const removed = removeSkillTrigger(input, trigger.start, caret);
      setActiveSkills((prev) => [...prev, skill]);
      setInput(removed.value);
      setCaret(removed.caret);
      pendingCaretRef.current = removed.caret;
      // A mouse pick must not strand focus: typing continues in the composer.
      composerRef.current?.focus();
    },
    [trigger, input, caret, setActiveSkills],
  );

  const removeSkill = useCallback(
    (id: string) => {
      setActiveSkills((prev) => prev.filter((s) => s.id !== id));
    },
    [setActiveSkills],
  );

  const syncCaret = (e: { currentTarget: HTMLTextAreaElement }) => {
    setCaret(e.currentTarget.selectionStart ?? 0);
  };

  /** The keys the open `@` popup claims; true means the event was consumed.
   *  With no options yet (the quiet loading/error line), only Escape is
   *  claimed: arrows keep moving the caret and Enter falls through to an
   *  ordinary send. */
  const handlePickerKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const len = suggestions.length;
    if (len > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPickerIndex((pickerActive + 1) % len);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPickerIndex((pickerActive - 1 + len) % len);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickSkill(suggestions[pickerActive]);
        return true;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissedKey(triggerKey);
      return true;
    }
    return false;
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // While the `@` popup is open it owns the nav keys — Enter picks a skill,
    // it never sends mid-pick.
    if (pickerOpen && handlePickerKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    syncCaret(e);
  };

  // Coming back to the composer is a fresh session for the popup: a
  // blur-dismissal must not outlive it (the key alone can collide with an
  // identically retyped trigger).
  const onComposerBlur = () => setDismissedKey(triggerKey);
  const onComposerFocus = () => setDismissedKey(null);

  return {
    composerRef,
    composerActionRef,
    input,
    suggestions,
    pickerNotice,
    pickerOpen,
    pickerActive,
    setPickerIndex,
    pickSkill,
    removeSkill,
    send,
    syncCaret,
    onInputChange,
    onComposerKeyDown,
    onComposerBlur,
    onComposerFocus,
  };
}
