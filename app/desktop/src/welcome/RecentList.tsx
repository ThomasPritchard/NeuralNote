import { FolderOpen } from "lucide-react";
import type { RecentVault } from "../lib/types";

interface RecentListProps {
  recents: RecentVault[];
  /** Open a recent vault by its absolute path. */
  onOpen: (path: string) => void;
}

/** The list of recently-opened vaults, with a tasteful empty state.
 *
 *  The list is a bounded, scrolling well rather than one that grows the welcome
 *  card (#164). The backend already caps the history at twelve entries
 *  (`crates/neuralnote-core/src/recents.rs:11`), and twelve rows measure 668px —
 *  on their own taller than the 600px minimum window, before the brand block,
 *  the actions and the footer are counted. So the ceiling here is the fix, not a
 *  second cap on the data: every remembered vault still renders, and the ones
 *  past the fold stay reachable — by scrolling, and by focus, which the well
 *  scrolls into view. (Whether Tab itself reaches a button is the platform's
 *  call, not this list's: WebKit follows the macOS "Keyboard navigation"
 *  setting and skips buttons while it is off.)
 *
 *  Proved in `Welcome.browser.test.tsx`, which has to be browser-tier — jsdom
 *  reports every rect as zeros, so "the card overflows the window" and "the card
 *  fits" read identically there. */
export function RecentList({ recents, onOpen }: Readonly<RecentListProps>) {
  return (
    <section className="w-full text-left">
      <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Recent
      </h2>
      {recents.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
          No recent vaults yet — open or create one to begin.
        </p>
      ) : (
        // Two deliberate numbers, in the shape the skill picker's popup already
        // uses (`../workspace/SkillPicker.tsx:64`).
        //
        // `max-h-52` (208px) is picked to cut a row IN HALF rather than land on
        // a boundary. A row is 52px on a 56px pitch, so 200px of content shows
        // three whole rows and most of a fourth. Both engines here draw overlay
        // scrollbars — invisible at rest — so the half-row is the only thing
        // telling the reader there are more vaults below; a ceiling that ended
        // flush after four would read as "four vaults, that is all".
        //
        // `p-1` is not decoration: the rows draw their focus indicator with
        // `focus-visible:ring-2`, painted OUTSIDE the button's border box, so a
        // well flush against its own rows would clip that ring on the first and
        // last one.
        <ul className="max-h-52 space-y-1 overflow-y-auto p-1">
          {recents.map((recent) => (
            <li key={recent.path}>
              <button
                type="button"
                onClick={() => onOpen(recent.path)}
                aria-label={`Open ${recent.name}`}
                className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-200 ease-spring hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
              >
                <FolderOpen
                  className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {recent.name}
                  </span>
                  <span
                    className="nn-mono block truncate text-xs text-muted-foreground"
                    title={recent.path}
                  >
                    {recent.path}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
