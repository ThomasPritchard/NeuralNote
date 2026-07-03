// Sidebar full-text search panel. The prop contract below is FROZEN (see
// specs/search-and-graph-view.md §Frontend) so Workspace never changes when
// the real panel lands: `focusSignal` bumps when ⌘K / the ribbon Search icon
// wants the field focused; `onOpen` routes result clicks through Workspace's
// guarded open (absolute path).
//
// TODO(phase-C2): replace this skeleton with the prototype-styled field
// (Search icon, "Search vault…" placeholder, ⌘K kbd chip), 200 ms debounce,
// min 2 chars, results grouped by file with <mark>-highlighted snippets, and
// idle/empty/truncated/error states.

export function SearchPanel({
  focusSignal: _focusSignal,
  onOpen: _onOpen,
}: {
  focusSignal: number;
  onOpen: (absPath: string) => void;
}) {
  return (
    <aside
      aria-label="Search"
      className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar"
    >
      <p className="px-4 py-3 text-[12px] leading-snug text-muted-foreground">
        Search is coming in the next phase.
      </p>
    </aside>
  );
}
