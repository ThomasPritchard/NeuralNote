import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";

import type { CellPaintPlan } from "./sourceEditorCellPaintPlan";
import {
  refreshSourceEditorTableMetrics,
  tableCellMetrics,
} from "./sourceEditorDecorations";
import {
  measuredCellPadding,
  measuredWidth,
  onMetricsEpochChange,
} from "./sourceEditorTextMetrics";

/**
 * The seam between CT-4's measurement probe (`sourceEditorTextMetrics.ts`) and
 * the render plan that sizes a table's columns from it — the `tableCellMetrics`
 * facet, which `sourceEditorDecorations.ts` defines and reads but deliberately
 * never fills. Two things live here and nowhere else.
 *
 * **The padding arithmetic.** {@link measuredWidth} reports a cell's text
 * advance and stops there: under CT-2 the cell is a grid item whose box is
 * whatever its track says, so measuring the box to size the track would be
 * circular. A track has to hold the advance AND the `padding-inline` the
 * stylesheet puts inside the cell (`--nn-table-cell-pad`), and adding it here
 * rather than inside `trackTemplate` keeps the render plan free of anything
 * DOM-shaped. Drop it and every column is a cell's padding too narrow, which
 * shows up as clipped text in the last column rather than as an error.
 *
 * **The epoch refresh.** The widths a track was stamped from belong to a style
 * generation, and that generation moves when a webfont settles or the typography
 * changes. Nothing else would ask for new ones: neither event is a document,
 * selection or viewport change, so a font arriving after first paint would leave
 * every column measured against the fallback face for the rest of the session.
 *
 * Neither path can change a byte. The only transaction dispatched here carries
 * one effect and no changes, and the render plan answers an unmeasured column
 * with character tracks rather than with a throw — losing a keystroke costs more
 * than a mis-sized column.
 */

/**
 * What a drawn cell occupies inline: the advance of the text it paints, plus the
 * padding its own box adds around that text.
 *
 * @param plan - the cell's canonical projection (CT-3)
 * @returns the width in CSS pixels, or `null` while the probe is not primed —
 *   the normal first frame, which the render plan answers with character tracks
 */
function measureTableCell(plan: CellPaintPlan): number | null {
  const advance = measuredWidth(plan);
  const padding = measuredCellPadding();
  if (advance === null || padding === null) return null;
  return advance + padding;
}

const tableMetricsRefresh = ViewPlugin.define((view: EditorView) => {
  const release = onMetricsEpochChange(() => {
    // Deferred, because the epoch can move from inside a state update: the probe
    // is primed lazily, so the first `measuredWidth` of a session syncs its
    // styles while the table field is being rebuilt, and dispatching there
    // re-enters the update cycle. The same microtask hop, for the same reason,
    // as `sourceEditorTableViewport`. `EditorView.destroy` releases this plugin
    // and then removes its DOM (`@codemirror/view/dist/index.js:8625-8637`), so
    // a hop that outlives the view finds it disconnected.
    queueMicrotask(() => {
      if (!view.dom.isConnected) return;
      view.dispatch({ effects: refreshSourceEditorTableMetrics.of(null) });
    });
  });
  return { destroy: release };
});

/**
 * Register alongside the other source-editor extensions, together with whatever
 * primes the probe. Position among them is free: the table field takes its first
 * measurement at `EditorState.create`, before any view plugin exists, and
 * answers `null` however this array is ordered. What is not free is registering
 * it at all — without a provider every cell measures `null` for the rest of the
 * session and the tracks stay on character widths, which looks correct and is
 * wrong by however much the painted text differs from its character count.
 */
export const tableCellMeasurement: Extension = [
  tableCellMetrics.of(measureTableCell),
  tableMetricsRefresh,
];
