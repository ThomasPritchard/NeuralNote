// Display state shared between the Local AI card (which owns the data loads) and
// its presentational section views (LocalAiCatalogue, LocalAiInstalled). Kept in
// one module so the card and the children agree on the exact shapes.

import type { InstalledModel } from "../lib/types";

/** The installed-model scan as one explicit state machine. `checking` is a
 *  real state, distinct from "not installed": until the scan resolves (or
 *  after it fails) the catalogue can neither claim a model is Installed nor
 *  offer Download — treating "not yet known" as "not installed" is how an
 *  already-installed model got offered for a multi-gigabyte re-download. */
export type InstalledScan =
  | { status: "checking" }
  | { status: "ready"; models: InstalledModel[] }
  | { status: "error"; message: string };

/** The freshest streamed pull frame for the one in-flight download. */
export interface PullProgress {
  tag: string;
  status: string;
  completed: number | null;
  total: number | null;
  percent: number | null;
}
