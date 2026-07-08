// The Obsidian-style backlinks panel at the foot of the reader column: linked
// mentions (real links pointing at this note) and unlinked mentions (bare
// title matches), each a collapsible section with a count. Entries open their
// source note through the workspace's guarded open. Failures are never
// silent: a fetch error renders inline with a retry, and a partially-failed
// scan (skippedFiles) gets a visible, non-blocking notice even when the
// result is otherwise empty — a permissions problem must never masquerade as
// "no backlinks".

import { useEffect, useReducer, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Link2,
  Loader2,
  RotateCw,
  TextSearch,
  type LucideIcon,
} from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import type { Backlink, Backlinks, UnlinkedMention } from "../lib/types";

const EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

type PanelState =
  | { kind: "loading" }
  | { kind: "loaded"; backlinks: Backlinks }
  | { kind: "error"; message: string };

export function BacklinksPanel({
  notePath,
  onOpenLink,
}: Readonly<{
  /** Absolute path of the open note (what `read_backlinks` takes). */
  notePath: string;
  /** Open a source note by relPath (the workspace's guarded open). */
  onOpenLink?: (relPath: string) => void;
}>) {
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [retryToken, retry] = useReducer((n: number) => n + 1, 0);

  // Re-fetch when the open note changes. The cleanup flag guards against a
  // stale async resolve: a response for a note that is no longer open (or an
  // unmounted panel) is ignored rather than painted over the newer state.
  useEffect(() => {
    let stale = false;
    setState({ kind: "loading" });
    api
      .readBacklinks(notePath)
      .then((backlinks) => {
        if (!stale) setState({ kind: "loaded", backlinks });
      })
      .catch((e) => {
        if (!stale) setState({ kind: "error", message: errorMessage(e) });
      });
    return () => {
      stale = true;
    };
  }, [notePath, retryToken]);

  return (
    <section aria-label="Backlinks" className="mt-14 border-t border-border pt-4">
      {/* Eyebrow matches the app's section-label idiom (ChatMessages coverage). */}
      <h2 className="px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
        Backlinks
      </h2>
      <div className="mt-2">
        <PanelBody state={state} onOpenLink={onOpenLink} onRetry={retry} />
      </div>
    </section>
  );
}

function PanelBody({
  state,
  onOpenLink,
  onRetry,
}: Readonly<{
  state: PanelState;
  onOpenLink?: (relPath: string) => void;
  onRetry: () => void;
}>) {
  if (state.kind === "loading") {
    // <output> carries an implicit status role + polite live region.
    return (
      <output className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-muted-foreground/70">
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        Finding backlinks…
      </output>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="mx-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
        <span className="flex min-w-0 items-start gap-2">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words leading-snug">
            Backlinks couldn&apos;t be loaded: {state.message}
          </span>
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <RotateCw className="size-3.5" aria-hidden /> Retry
        </button>
      </div>
    );
  }

  const { linked, unlinked, skippedFiles } = state.backlinks;
  const empty = linked.length === 0 && unlinked.length === 0;

  return (
    <>
      {/* Shown even in the empty state: a partially-failed scan must never
          read as a clean "no backlinks". */}
      {skippedFiles > 0 && (
        <p className="mx-2.5 mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] leading-snug text-destructive">
          {skippedFiles} {skippedFiles === 1 ? "file" : "files"} couldn&apos;t be
          read
        </p>
      )}
      {empty ? (
        <p className="px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground/70">
          No backlinks yet — nothing links to or mentions this note.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <MentionSection
            label="Linked mentions"
            icon={Link2}
            entries={linked}
            defaultOpen
            onOpenLink={onOpenLink}
          />
          <MentionSection
            label="Unlinked mentions"
            icon={TextSearch}
            entries={unlinked}
            defaultOpen={false}
            onOpenLink={onOpenLink}
          />
        </div>
      )}
    </>
  );
}

function MentionSection({
  label,
  icon: Icon,
  entries,
  defaultOpen,
  onOpenLink,
}: Readonly<{
  label: string;
  icon: LucideIcon;
  entries: (Backlink | UnlinkedMention)[];
  defaultOpen: boolean;
  onOpenLink?: (relPath: string) => void;
}>) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-foreground/90 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
          EASE,
        )}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
            EASE,
            open && "rotate-90",
          )}
          aria-hidden
        />
        <Icon className="size-3.5 shrink-0 text-primary/80" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
        <span className="nn-mono ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {entries.length}
        </span>
      </button>

      {open &&
        (entries.length === 0 ? (
          <p className="py-1 pl-[34px] pr-2.5 text-[12px] text-muted-foreground/70">
            None found.
          </p>
        ) : (
          <ul className="mt-0.5 flex flex-col gap-px pl-4">
            {entries.map((entry, i) => (
              <MentionRow
                // line alone can repeat (two mentions on one line) — the index
                // disambiguates within the stable (sourceRel, line) pair.
                key={`${entry.sourceRel}:${entry.line}:${i}`}
                entry={entry}
                onOpen={() => onOpenLink?.(entry.sourceRel)}
              />
            ))}
          </ul>
        ))}
    </div>
  );
}

function MentionRow({
  entry,
  onOpen,
}: Readonly<{
  entry: Backlink | UnlinkedMention;
  onOpen: () => void;
}>) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${entry.sourceRel}`}
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
          EASE,
        )}
      >
        <span className="flex w-full items-baseline gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground/90">
            {entry.sourceTitle}
          </span>
          <span className="nn-mono ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
            :{entry.line}
          </span>
        </span>
        <span className="w-full truncate text-[12px] leading-snug text-muted-foreground">
          {entry.snippet}
        </span>
      </button>
    </li>
  );
}
