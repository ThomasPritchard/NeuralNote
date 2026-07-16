// Shared prop types for the galaxy overlay chrome (toolbar / legend / panel).

/** Legend/label metadata for one cluster. */
export interface ClusterMeta {
  label: string;
  color: string;
  drillable: boolean;
}

/** Cluster key → its legend metadata. Every node.cluster key is present.
 *  `drillable` marks clusters with sub-folders (they get the chevron). */
export type ClusterMap = Record<string, ClusterMeta>;
