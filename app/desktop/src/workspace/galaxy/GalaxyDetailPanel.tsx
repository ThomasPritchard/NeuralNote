import { X } from "lucide-react";
import type { GalaxyNode } from "./graph";
import { BRIDGE_PINK } from "./galaxyLinks";
import type { ClusterMap } from "./galaxyTypes";
import { plural } from "./galaxyText";
import { setHover } from "./nodeRegistry";

interface GalaxyDetailPanelProps {
  /** The selected node — the panel only mounts while one is selected. */
  selected: GalaxyNode;
  clusters: ClusterMap;
  /** Direct neighbours, pre-resolved against the render graph so the count and
   *  the rows can never disagree. */
  neighbours: { node: GalaxyNode; bridge: boolean }[];
  /** Traverse to a neighbour (select + fly). */
  onNodeClick: (node: GalaxyNode) => void;
  /** Close the panel and fly back to the pre-focus camera pose. */
  onClose: () => void;
  onOpenNote: (id: string) => void;
}

/** Selected-node detail panel: cluster badge, title, neighbour list, and the
 *  "Open in reader" action. Presentational — selection/camera state lives in
 *  the parent (NeuralGalaxy). */
export function GalaxyDetailPanel({
  selected,
  clusters,
  neighbours,
  onNodeClick,
  onClose,
  onOpenNote,
}: Readonly<GalaxyDetailPanelProps>) {
  return (
    <div className="absolute right-5 top-24 w-72 rounded-xl border border-border bg-card/90 p-4 backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <span
          className="nn-mono rounded-full px-2 py-0.5 text-[0.625rem]"
          style={{ background: `${selected.color}22`, color: selected.color }}
        >
          {clusters[selected.cluster]?.label ?? selected.cluster}
        </span>
        <button type="button" onClick={onClose} aria-label="Close">
          <X className="size-4 text-muted-foreground hover:text-foreground" />
        </button>
      </div>
      <h3 className="nn-heading mt-2 text-base font-semibold leading-snug text-foreground">{selected.title}</h3>
      <div className="nn-mono mt-3 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
        {plural(neighbours.length, "connected note")}
      </div>
      <div className="mt-1.5 max-h-56 overflow-y-auto">
        {neighbours.map(({ node: nb, bridge }) => (
          <button
            key={nb.id}
            type="button"
            onClick={() => onNodeClick(nb)}
            onMouseEnter={() => setHover(nb.id, true)}
            onMouseLeave={() => setHover(nb.id, false)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition hover:bg-primary/10"
          >
            <span className="size-2 shrink-0 rounded-full" style={{ background: nb.color }} />
            <span className="truncate">{nb.title}</span>
            {bridge && (
              <span className="nn-mono ml-auto shrink-0 text-[0.5625rem]" style={{ color: BRIDGE_PINK }}>
                Cross-folder
              </span>
            )}
          </button>
        ))}
      </div>
      <button
        onClick={() => onOpenNote(selected.id)}
        className="mt-3 w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
      >
        Open in reader
      </button>
    </div>
  );
}
