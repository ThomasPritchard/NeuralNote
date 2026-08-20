// The footer status bar. Shows the vault name and live counts derived from the
// current tree, plus the word count of the open note. The dot marks the local
// vault as healthy; it does not imply that cloud sync exists or is connected.
//
// The counts are gated on the tree's READ STATUS, never on the tree alone
// (issue #209). An unread or failed `read_tree` leaves an array that walks to
// zero, and "0 notes · 0 folders" beside a healthy dot is a confident false
// statement about someone's vault — worse than silence, because the sidebar
// reads through a separate lazy `list_dir` path and keeps listing the real
// contents right beside it. Only a completed read becomes a number. The
// vault-switch window is `loading` for exactly as long as the previous vault's
// tree is still in hand, so vault A's counts can never appear under vault B's
// name either.
//
// The notice sits OUTSIDE `.nn-status-secondary` on purpose: that cluster is
// hidden below 1050px, which is right for counts (a nicety) and wrong for a
// failure and its recovery button.
//
// Memoized: the editor draft lives a few components up, so this re-renders on
// every keystroke. React.memo keeps it inert while its props are unchanged, and
// the two useMemos avoid re-walking the whole tree / re-splitting the body when
// only the draft changed.

import { memo, useMemo } from "react";
import { RotateCw } from "lucide-react";
import type { NoteDoc, TreeNode } from "../lib/types";
import { countTree, wordCount } from "./fileMeta";
import type { VaultTreeStatus } from "./useVaultTree";

interface StatusBarProps {
  vaultName: string;
  tree: TreeNode[];
  /** Whether `tree` is a completed read — see `VaultTreeStatus`. Only `"ready"`
   *  earns a count. */
  status: VaultTreeStatus;
  /** Re-read the vault index (the hook's `refresh`). The retry entry point after
   *  a failed read, so recovery never needs the vault reopened. */
  onRetry: () => void;
  note: NoteDoc | null;
}

/** How the health dot paints per read status. It stays `aria-hidden`: the colour
 *  only reinforces a state the footer already states in words, so nothing here
 *  is carried by colour alone. `data-health` is the handle the regression
 *  fixture asserts on. */
const HEALTH: Record<VaultTreeStatus, { state: string; dotClass: string }> = {
  ready: { state: "healthy", dotClass: "size-1.5 rounded-full bg-healthy" },
  loading: { state: "unknown", dotClass: "size-1.5 rounded-full bg-muted-foreground" },
  failed: { state: "unavailable", dotClass: "size-1.5 rounded-full bg-warning" },
};

/** What stands in for the counts while they are not a fact: a plain word for the
 *  read in flight, and the failure plus its retry once the read has rejected. */
function VaultIndexNotice({
  status,
  onRetry,
}: Readonly<{ status: Exclude<VaultTreeStatus, "ready">; onRetry: () => void }>) {
  if (status === "loading") return <span>Reading vault…</span>;

  return (
    <span role="status" className="flex items-center gap-2">
      <span>Counts unavailable</span>
      <button
        type="button"
        onClick={onRetry}
        aria-label="Retry reading the vault"
        className="inline-flex items-center gap-1 rounded-sm px-0.5 text-foreground underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <RotateCw className="size-3" aria-hidden />
        Retry
      </button>
    </span>
  );
}

export const StatusBar = memo(function StatusBar({
  vaultName,
  tree,
  status,
  onRetry,
  note,
}: StatusBarProps) {
  const { notes, folders } = useMemo(() => countTree(tree), [tree]);
  const words = useMemo(
    () => (note ? wordCount(note.body) : null),
    [note],
  );
  const health = HEALTH[status];

  return (
    <footer className="nn-mono flex h-(--statusbar-height) shrink-0 items-center justify-between border-t border-border bg-titlebar px-3 text-[0.6875rem] text-muted-foreground">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-foreground/70">{vaultName}</span>
        {words !== null && (
          <>
            <span className="opacity-40">·</span>
            <span>{words} words</span>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {status !== "ready" && (
          <VaultIndexNotice status={status} onRetry={onRetry} />
        )}
        <div className="nn-status-secondary flex items-center gap-3">
          {status === "ready" && (
            <>
              <span>
                {notes} {notes === 1 ? "note" : "notes"}
              </span>
              <span className="opacity-40">·</span>
              <span>
                {folders} {folders === 1 ? "folder" : "folders"}
              </span>
              <span className="opacity-40">·</span>
            </>
          )}
          <span className="flex items-center gap-1.5 text-foreground/70">
            <span
              className={health.dotClass}
              data-testid="vault-health"
              data-health={health.state}
              aria-hidden
            />
            <span>Local only</span>
          </span>
        </div>
      </div>
    </footer>
  );
});
