// One flattened tree row: a node, an inline create input, or one of the lazy-only
// status rows (loading / error / "N more…"), each wrapped in one indent-guide
// layer per ancestor level. Stacked flush rows join their `border-l` hairlines
// into the same continuous guide lines the old recursive nesting drew. Extracted
// from FileTree so the composing view stays lean; the row markup and TreeRow's
// React.memo boundary (issue #25) are untouched.

import type { KeyboardEvent, ReactNode } from "react";
import type { TreeNode } from "../lib/types";
import type { FlatRow } from "./flattenTree";
import {
  CreateRow,
  ErrorRow,
  LoadingRow,
  MoreRow,
  TreeRow,
  type TreeContext,
} from "./TreeRow";

/** The keyboard "Move to" shortcut (issue #24): `m` (no modifier) on a focused
 *  row opens the destination picker for that entry. Ignored while an inline
 *  input holds focus so typing a name that contains "m" never opens the dialog. */
function handleMoveShortcut(
  event: KeyboardEvent<HTMLDivElement>,
  node: TreeNode,
  onMove: (node: TreeNode) => void,
) {
  if (event.defaultPrevented) return;
  if (event.key !== "m" && event.key !== "M") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  ) {
    return;
  }
  event.preventDefault();
  onMove(node);
}

export function FlatTreeRow({
  row,
  ctx,
  onMove,
}: Readonly<{
  row: FlatRow;
  ctx: TreeContext;
  onMove: (node: TreeNode) => void;
}>) {
  let content: ReactNode;
  switch (row.kind) {
    case "node":
      content = (
        // Wrapper carries this row's "Move to" shortcut; keydowns bubble up from
        // the row's focused button. TreeRow itself is untouched, so its
        // React.memo boundary (issue #25) is preserved exactly.
        <div
          role="presentation"
          onKeyDown={(event) => handleMoveShortcut(event, row.node, onMove)}
        >
          <TreeRow node={row.node} ctx={ctx} />
        </div>
      );
      break;
    case "create":
      content = <CreateRow kind={row.createKind} ctx={ctx} />;
      break;
    case "loading":
      content = <LoadingRow />;
      break;
    case "error":
      content = (
        <ErrorRow parentPath={row.parentPath} message={row.message} onRetry={ctx.onRetry} />
      );
      break;
    case "more":
      content = <MoreRow count={row.count} />;
      break;
  }
  for (let i = 0; i < row.depth; i++) {
    content = <div className="ml-[7px] border-l border-border/60 pl-2">{content}</div>;
  }
  return content;
}
