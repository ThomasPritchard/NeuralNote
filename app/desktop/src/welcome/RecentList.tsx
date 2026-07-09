import { FolderOpen } from "lucide-react";
import type { RecentVault } from "../lib/types";

interface RecentListProps {
  recents: RecentVault[];
  /** Open a recent vault by its absolute path. */
  onOpen: (path: string) => void;
}

/** The list of recently-opened vaults, with a tasteful empty state. */
export function RecentList({ recents, onOpen }: RecentListProps) {
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
        <ul className="space-y-1">
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
