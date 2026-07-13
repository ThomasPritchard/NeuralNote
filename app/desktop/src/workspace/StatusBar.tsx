// The footer status bar. Shows the vault name and live counts derived from the
// current tree, plus the word count of the open note. The dot reflects that the
// store keeps the tree in step with the local disk — not any cloud sync.
//
// Memoized: the editor draft lives a few components up, so this re-renders on
// every keystroke. React.memo keeps it inert while its props are unchanged, and
// the two useMemos avoid re-walking the whole tree / re-splitting the body when
// only the draft changed.

import { memo, useMemo } from "react";
import type { NoteDoc, TreeNode } from "../lib/types";
import { countTree, wordCount } from "./fileMeta";

interface StatusBarProps {
  vaultName: string;
  tree: TreeNode[];
  note: NoteDoc | null;
}

export const StatusBar = memo(function StatusBar({
  vaultName,
  tree,
  note,
}: StatusBarProps) {
  const { notes, folders } = useMemo(() => countTree(tree), [tree]);
  const words = useMemo(
    () => (note ? wordCount(note.body) : null),
    [note],
  );

  return (
    <footer className="nn-mono flex h-(--statusbar-height) shrink-0 items-center justify-between border-t border-border bg-titlebar px-3 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-foreground/70">{vaultName}</span>
        {words !== null && (
          <>
            <span className="opacity-40">·</span>
            <span>{words} words</span>
          </>
        )}
      </div>
      <div className="nn-status-secondary flex shrink-0 items-center gap-3">
        <span>
          {notes} {notes === 1 ? "note" : "notes"}
        </span>
        <span className="opacity-40">·</span>
        <span>
          {folders} {folders === 1 ? "folder" : "folders"}
        </span>
        <span className="opacity-40">·</span>
        <span className="flex items-center gap-1.5 text-foreground/70">
          <span className="size-1.5 rounded-full bg-healthy" aria-hidden />
          <span>In sync with disk</span>
        </span>
      </div>
    </footer>
  );
});
