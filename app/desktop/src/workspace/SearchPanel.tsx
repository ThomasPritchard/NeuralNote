// Sidebar full-text search panel. The prop contract is FROZEN (see
// specs/search-and-graph-view.md §Frontend) so Workspace never changes:
// `focusSignal` bumps when ⌘K / the ribbon Search icon wants the field focused;
// `onOpen` routes result clicks through Workspace's guarded open (absolute path).
//
// Query flow: 200 ms trailing debounce, minimum 2 trimmed chars, and a
// monotonic request token (the useOpenNote loadId idiom) so a slow stale
// response can never overwrite a newer one. Failures are never silent: errors
// surface via the shared toast channel (useVault().reportError) plus a brief
// inline state, and partially-failed scans (skippedFiles) get a visible,
// non-blocking notice so a permissions problem never masquerades as "no results".

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Loader2, Search } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { useVault } from "../lib/store";
import type { FileHit, SearchMatch, SearchResponse } from "../lib/types";

const DEBOUNCE_MS = 200;
const MIN_QUERY_CHARS = 2;
// FileTree's interaction easing, mirrored so the two sidebars feel identical.
const EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

// Centered helper text for the transient states (idle/loading/empty/error).
const HINT = "px-2 py-6 text-center text-[12px] leading-relaxed";
const ROW_FOCUS =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary";
const BANNER = "mb-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-snug";

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "results"; query: string; response: SearchResponse }
  | { kind: "error" };

/** Wrap the matched `ranges` of a snippet in <mark>. Ranges are Unicode
 *  CODE-POINT offsets (the Rust side counts `char`s), so slicing goes through
 *  `Array.from(snippet)` — NEVER `String.prototype.slice`, which counts UTF-16
 *  units and drifts past any astral char (e.g. an emoji) before the match.
 *  Out-of-order or out-of-bounds ranges are clamped rather than trusted.
 *  Exported for direct unit testing. */
export function highlightSnippet(
  snippet: string,
  ranges: [number, number][],
): ReactNode[] {
  const chars = Array.from(snippet);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    const from = Math.min(Math.max(start, cursor), chars.length);
    const to = Math.min(Math.max(end, from), chars.length);
    if (from > cursor) parts.push(chars.slice(cursor, from).join(""));
    if (to > from) {
      parts.push(
        // Keyed on the clamped offsets — unique because ranges are disjoint.
        <mark
          key={`${from}-${to}`}
          className="rounded-[2px] bg-primary/25 text-foreground"
        >
          {chars.slice(from, to).join("")}
        </mark>,
      );
    }
    cursor = Math.max(cursor, to);
  }
  if (cursor < chars.length) parts.push(chars.slice(cursor).join(""));
  return parts;
}

function MatchRow({
  match,
  onOpen,
}: {
  match: SearchMatch;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={`flex w-full items-baseline gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-sidebar-accent ${ROW_FOCUS} ${EASE}`}
      >
        <span className="nn-mono shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
          {match.line}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] leading-snug text-muted-foreground">
          {highlightSnippet(match.snippet, match.ranges)}
        </span>
      </button>
    </li>
  );
}

function FileHitGroup({
  hit,
  onOpen,
}: {
  hit: FileHit;
  onOpen: (absPath: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(hit.path)}
        className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent ${ROW_FOCUS} ${EASE}`}
      >
        <span className="w-full truncate text-[13px] font-medium text-sidebar-foreground">
          {hit.title}
        </span>
        <span className="nn-mono w-full truncate text-[10px] text-muted-foreground/60">
          {hit.relPath}
        </span>
      </button>
      {hit.matches.length > 0 && (
        // Indent guide mirroring the file tree's nested-folder line.
        <ul className="ml-[7px] border-l border-border/60 pl-1.5">
          {hit.matches.map((m) => (
            <MatchRow key={m.line} match={m} onOpen={() => onOpen(hit.path)} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SearchResults({
  query,
  response,
  onOpen,
}: {
  query: string;
  response: SearchResponse;
  onOpen: (absPath: string) => void;
}) {
  return (
    <>
      {response.truncated && (
        <p className={`${BANNER} border-border bg-muted/50 text-muted-foreground`}>
          Showing first 200 matches
        </p>
      )}
      {/* Shown even with zero hits: a partially-failed scan must never read as
          a genuinely empty result. */}
      {response.skippedFiles > 0 && (
        <p className={`${BANNER} border-destructive/30 bg-destructive/10 text-destructive`}>
          {response.skippedFiles}{" "}
          {response.skippedFiles === 1 ? "file" : "files"} couldn't be read
        </p>
      )}
      {response.hits.length === 0 ? (
        <p className={`${HINT} text-muted-foreground/70`}>
          No notes match "{query}"
        </p>
      ) : (
        <ul aria-label="Search results" className="flex flex-col gap-1">
          {response.hits.map((h) => (
            <FileHitGroup key={h.relPath} hit={h} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </>
  );
}

export function SearchPanel({
  focusSignal,
  onOpen,
}: {
  focusSignal: number;
  onOpen: (absPath: string) => void;
}) {
  const { reportError } = useVault();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  // Monotonic token so a slow response can't overwrite a newer one (the
  // useOpenNote loadId idiom).
  const searchId = useRef(0);

  const runSearch = useCallback(
    async (q: string) => {
      const id = ++searchId.current;
      setState({ kind: "loading" });
      try {
        const response = await api.searchVault(q);
        if (id !== searchId.current) return;
        setState({ kind: "results", query: q, response });
      } catch (e) {
        if (id !== searchId.current) return;
        // Surfaced twice on purpose: the shared toast carries the message, the
        // panel keeps a brief inline marker — never silent.
        reportError(errorMessage(e));
        setState({ kind: "error" });
      }
    },
    [reportError],
  );

  // Debounced trigger: trailing 200 ms behind the last keystroke, gated on the
  // trimmed length. Dropping below the minimum resets to idle AND bumps the
  // token so any in-flight response is discarded.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_CHARS) {
      searchId.current++;
      setState({ kind: "idle" });
      return;
    }
    const timer = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  // ⌘K / the ribbon Search icon: Workspace bumps focusSignal to request focus.
  // 0 is the mount value — never steal focus for it.
  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    if (query !== "") setQuery("");
    else e.currentTarget.blur();
  };

  let body: ReactNode;
  switch (state.kind) {
    case "idle":
      body = (
        <p className={`${HINT} text-muted-foreground/70`}>
          Type at least two characters to search your vault.
        </p>
      );
      break;
    case "loading":
      // <output> carries an implicit status role + polite live region.
      body = (
        <output
          className={`${HINT} flex items-center justify-center gap-2 text-muted-foreground/70`}
        >
          <Loader2
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          Searching…
        </output>
      );
      break;
    case "error":
      body = (
        <p className={`${HINT} text-destructive`}>
          Search failed. See the error notice for details.
        </p>
      );
      break;
    case "results":
      body = (
        <SearchResults
          query={state.query}
          response={state.response}
          onOpen={onOpen}
        />
      );
      break;
  }

  return (
    <aside
      aria-label="Search"
      className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar"
    >
      {/* Field — faithful port of the prototype's search row. */}
      <div className="px-3 pb-2 pt-3">
        <label
          className={`flex items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-[13px] text-muted-foreground transition focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30 ${EASE}`}
        >
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search vault"
            placeholder="Search vault…"
            className="w-full bg-transparent placeholder:text-muted-foreground/70 focus:outline-none"
          />
          <kbd className="nn-mono rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ⌘K
          </kbd>
        </label>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 pb-2">{body}</div>
    </aside>
  );
}
