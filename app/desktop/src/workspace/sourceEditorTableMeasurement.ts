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

/** Measure painted text plus cell padding; measuring the grid box would make
 *  track sizing circular. An unprimed probe returns null for character fallback. */
function measureTableCell(plan: CellPaintPlan): number | null {
  const advance = measuredWidth(plan);
  const padding = measuredCellPadding();
  if (advance === null || padding === null) return null;
  return advance + padding;
}

const tableMetricsRefresh = ViewPlugin.define((view: EditorView) => {
  const release = onMetricsEpochChange(() => {
    // The probe can refresh during a state update. Defer to avoid re-entry,
    // and ignore a queued refresh after the editor DOM has been removed.
    queueMicrotask(() => {
      if (!view.dom.isConnected) return;
      view.dispatch({ effects: refreshSourceEditorTableMetrics.of(null) });
    });
  });
  return { destroy: release };
});

/** Font/style epochs rebuild table metrics without changing the document.
 *  Register both the measurement provider and its refresh subscription. */
export const tableCellMeasurement: Extension = [
  tableCellMetrics.of(measureTableCell),
  tableMetricsRefresh,
];
