// Edit mode: a deliberately plain textarea seeded with the full raw file. Cmd/Ctrl+S
// saves. Save errors are shown inline and the buffer is kept — edits are never
// lost silently. Rich editing is out of scope; this is the honest raw editor.
//
// The textarea is *uncontrolled* (`defaultValue` + onChange) so a multi-MB note
// doesn't pay an O(size) controlled re-render on every keystroke; dirty/draft
// state is still tracked via onChange. `defaultValue` seeds the buffer on mount
// and is enough because every disk-content swap that should replace the buffer
// (opening another note, reloading from disk) drops to read mode in useOpenNote,
// which unmounts this editor — so the next edit-mode mount re-seeds from the
// fresh draft. Save/overwrite keep it mounted, but the buffer already holds the
// saved bytes, so no re-seed is needed and the cursor stays put.
//
// `[[` autocomplete: when the caret sits after an unclosed `[[`, a suggestion
// popup lists the vault's note names (from `noteIndex`), filtered by the typed
// prefix. ↑/↓ move, Enter/Tab insert `[[name]]` (auto-closing the `]]`), Esc
// dismisses; clicking a row inserts too. Insertion writes the DOM value
// directly and re-fires the existing onChange, so the textarea STAYS
// uncontrolled and the cursor lands right after the inserted link.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AlertTriangle, RotateCw, Save } from "lucide-react";
import { cn } from "../lib/cn";
import type { NoteIndexEntry } from "./linkResolve";
import {
  filterWikilinkSuggestions,
  findWikilinkTrigger,
  insertWikilink,
  type WikilinkSuggestion,
} from "./wikilinkAutocomplete";

const EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

/** Popup metrics used for clamping (w-72 / max-h-56 + hint row). */
const POPUP_WIDTH = 288;
const POPUP_MAX_HEIGHT = 252;

/** Styles mirrored onto the measuring div so it wraps exactly like the
 *  textarea (the standard textarea-caret-position technique). */
const MIRROR_STYLES = [
  "box-sizing",
  "border-left-width",
  "border-right-width",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "line-height",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "tab-size",
  "text-indent",
  "text-transform",
  "word-spacing",
] as const;

interface PopupPosition {
  left: number;
  top: number;
}

/** Pixel position (relative to the textarea's offsetParent) for a popup
 *  anchored just below the character at `index`. Renders the text up to
 *  `index` into a hidden mirror with the textarea's exact metrics, then reads
 *  a marker span's offsets — the only way to locate a caret through soft
 *  wraps. In jsdom (tests) every offset is 0, which is harmless: position is
 *  cosmetic there. */
function popupPositionAt(ta: HTMLTextAreaElement, index: number): PopupPosition {
  const style = globalThis.getComputedStyle(ta);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "0";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.width = `${ta.clientWidth}px`;
  for (const prop of MIRROR_STYLES) {
    mirror.style.setProperty(prop, style.getPropertyValue(prop));
  }
  mirror.appendChild(document.createTextNode(ta.value.slice(0, index)));
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  (ta.parentElement ?? document.body).appendChild(mirror);

  const lineHeight = Number.parseFloat(style.lineHeight) || 24;
  const caretLeft = ta.offsetLeft + marker.offsetLeft - ta.scrollLeft;
  const caretTop = ta.offsetTop + marker.offsetTop - ta.scrollTop;
  mirror.remove();

  const parent = ta.offsetParent as HTMLElement | null;
  const maxLeft = (parent?.clientWidth ?? ta.clientWidth) - POPUP_WIDTH - 8;
  const left = Math.max(8, Math.min(caretLeft, maxLeft));
  // Below the caret line by default; flip above when it would run off the
  // bottom of the pane and there is room above.
  const below = caretTop + lineHeight + 4;
  const paneHeight = parent?.clientHeight ?? 0;
  const flip =
    paneHeight > 0 &&
    below + POPUP_MAX_HEIGHT > paneHeight &&
    caretTop - POPUP_MAX_HEIGHT - 4 > 0;
  return { left, top: flip ? caretTop - POPUP_MAX_HEIGHT - 4 : below };
}

interface AutocompleteState {
  start: number;
  prefix: string;
  left: number;
  top: number;
}

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saveError: string | null;
  /** The file changed on disk; save is blocked pending the user's choice. */
  conflict: boolean;
  /** Force-save over the external change. */
  onOverwrite: () => void;
  /** Reload from disk, discarding the local draft. */
  onReload: () => void;
  /** Vault note index feeding the `[[` autocomplete. Omitted, the editor
   *  behaves exactly as before (no popup). */
  noteIndex?: NoteIndexEntry[];
}

export function Editor({
  value,
  onChange,
  onSave,
  saveError,
  conflict,
  onOverwrite,
  onReload,
  noteIndex,
}: Readonly<EditorProps>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [ac, setAc] = useState<AutocompleteState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const acRef = useRef(ac);
  acRef.current = ac;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave]);

  /** Re-derive the trigger from the current caret. Cheap (string scan to the
   *  caret); the mirror measurement only runs when the trigger changes. */
  const syncAutocomplete = useCallback(
    (ta: HTMLTextAreaElement) => {
      if (!noteIndex || noteIndex.length === 0) return;
      const caret = ta.selectionStart ?? 0;
      const found =
        ta.selectionEnd === caret ? findWikilinkTrigger(ta.value, caret) : null;
      const prev = acRef.current;
      if (!found) {
        if (prev) setAc(null);
        return;
      }
      if (prev?.start === found.start && prev?.prefix === found.prefix) {
        return;
      }
      setActiveIndex(0);
      setAc({ ...found, ...popupPositionAt(ta, found.start) });
    },
    [noteIndex],
  );

  const suggestions: WikilinkSuggestion[] =
    ac !== null && noteIndex !== undefined
      ? filterWikilinkSuggestions(noteIndex, ac.prefix)
      : [];
  const open = ac !== null && suggestions.length > 0;
  const active = Math.min(activeIndex, suggestions.length - 1);

  const applySuggestion = useCallback(
    (suggestion: WikilinkSuggestion) => {
      const ta = textareaRef.current;
      const trigger = acRef.current;
      if (!ta || !trigger) return;
      const next = insertWikilink(
        ta.value,
        trigger.start,
        ta.selectionStart ?? trigger.start + 2,
        suggestion.name,
      );
      // Direct DOM write + the existing onChange keeps the textarea
      // uncontrolled — no controlled re-render of a multi-MB buffer.
      ta.value = next.value;
      ta.setSelectionRange(next.caret, next.caret);
      onChange(next.value);
      setAc(null);
      ta.focus();
    },
    [onChange],
  );

  const onTextareaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return; // never trap typing while the popup is closed
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        break;
      case "Enter":
      case "Tab":
        e.preventDefault();
        applySuggestion(suggestions[active]);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        setAc(null);
        break;
      default:
        break;
    }
  };

  // Keep the active option in view as ↑/↓ move (no-op in jsdom).
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2.5 text-[12px] text-amber-300"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            This note changed on disk since you opened it. Your edits are kept here.
          </span>
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onReload}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RotateCw className="size-3.5" aria-hidden /> Reload (discard edits)
            </button>
            <button
              type="button"
              onClick={onOverwrite}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/90 px-2.5 py-1 font-medium text-black transition-colors hover:bg-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <Save className="size-3.5" aria-hidden /> Overwrite
            </button>
          </span>
        </div>
      )}
      {saveError && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-[12px] text-destructive">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="leading-snug">Couldn&apos;t save: {saveError}</span>
        </div>
      )}
      <textarea
        ref={textareaRef}
        defaultValue={value}
        onChange={(e) => {
          onChange(e.target.value);
          syncAutocomplete(e.target);
        }}
        onKeyDown={onTextareaKeyDown}
        onKeyUp={(e) => {
          // Caret-only moves don't fire onChange; re-check after nav keys.
          if (
            e.key === "ArrowLeft" ||
            e.key === "ArrowRight" ||
            e.key === "ArrowUp" ||
            e.key === "ArrowDown" ||
            e.key === "Home" ||
            e.key === "End" ||
            e.key === "PageUp" ||
            e.key === "PageDown"
          ) {
            syncAutocomplete(e.currentTarget);
          }
        }}
        onClick={(e) => syncAutocomplete(e.currentTarget)}
        onBlur={() => setAc(null)}
        spellCheck={false}
        aria-label="Note source"
        aria-autocomplete="list"
        aria-controls={open ? "nn-wikilink-listbox" : undefined}
        aria-activedescendant={open ? `nn-wikilink-option-${active}` : undefined}
        className="nn-mono min-h-0 flex-1 resize-none bg-background px-6 py-6 text-[13px] leading-6 text-foreground/90 outline-none placeholder:text-muted-foreground/60"
        placeholder="Write in Markdown…"
      />

      {open && ac !== null && (
        <div
          className="absolute z-30 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
          style={{ left: ac.left, top: ac.top }}
        >
          <ul // NOSONAR(S6819): correct ARIA combobox pattern — DOM focus stays in the textarea, which drives this popup via aria-activedescendant; a native <select> can't provide an inline caret-anchored autocomplete
            ref={listRef}
            role="listbox"
            id="nn-wikilink-listbox"
            aria-label="Link to note"
            className="max-h-56 overflow-y-auto p-1"
          >
            {suggestions.map((s, i) => (
              // The textarea keeps DOM focus (combobox pattern); the option is
              // "focused" via aria-activedescendant, so no tabindex here. The
              // row's mousedown is swallowed (not the whole popup's — the list
              // scrollbar must stay draggable) so focus never leaves the
              // textarea and the click can insert before any blur fires.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                key={s.relPath}
                id={`nn-wikilink-option-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applySuggestion(s)}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  "flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                  EASE,
                  i === active
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground/90",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="nn-mono max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground/70">
                  {s.relPath}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-border bg-muted/40 px-2.5 py-1 text-[10px] leading-relaxed text-muted-foreground/70">
            ↑↓ navigate · ↵ link · esc dismiss
          </p>
        </div>
      )}
    </div>
  );
}
