// Center-pane link-graph view. The prop contract below is FROZEN (see
// specs/search-and-graph-view.md §Frontend) so Workspace never changes when
// the ported neural-galaxy renderer lands: `onOpenNote` takes a GraphNode id
// (vault-relative path) and routes "Open in reader" through Workspace's
// guarded open.
//
// TODO(phase-D): replace this skeleton with the galaxy port — fetch
// readLinkGraph() on mount, transform to the galaxy shape (cluster palette,
// degree-based node size, pink cross-folder bridges), size to this container
// via ResizeObserver, and surface empty ("No notes yet") and error states.

export function GraphView({
  onOpenNote: _onOpenNote,
}: {
  onOpenNote: (relPath: string) => void;
}) {
  return (
    <main
      aria-label="Graph view"
      className="grid flex-1 place-items-center bg-background"
    >
      <p className="text-[12px] text-muted-foreground">
        Graph view is coming in the next phase.
      </p>
    </main>
  );
}
