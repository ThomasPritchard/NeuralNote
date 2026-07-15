// Persist the file tree's EXPANDED-folder set per vault, so a user's manual
// expansions survive an app restart. The lazy tree (issue #40) opens every
// folder COLLAPSED by default — expansion is what drives per-directory loading —
// so an empty stored set means "all folders collapsed" (matching Obsidian).
//
// This is the deliberate flip from the old collapsed-set persistence: any value
// left behind under the previous `nn:tree-collapsed:` key is simply never read,
// so a vault upgraded from the eager tree opens fresh (fully collapsed) rather
// than mis-reading a collapsed set as an expanded one.
//
// This is pure client UI state: it lives in the webview's localStorage, never in
// the vault or the Rust core. A future mobile/PWA client wouldn't inherit "which
// sidebar folders this desktop user expanded", so it deliberately doesn't go
// through the shared core. It also never touches vault markdown, so the
// Obsidian-compatibility / data-format rules aren't in play.
//
// Keyed by vault path so two vaults never clobber each other's expand state.
// Every access is guarded: a disabled or full localStorage (private mode, quota)
// must degrade to "don't persist", never throw into the render path.

const KEY_PREFIX = "nn:tree-expanded:";

const keyFor = (vaultPath: string): string => `${KEY_PREFIX}${vaultPath}`;

/** The persisted expanded-folder set for a vault; empty (all-collapsed) if none
 *  or if storage is unreadable/corrupt. Non-string entries are dropped
 *  defensively so a hand-edited value can't inject junk relPaths into the tree. */
export function loadExpanded(vaultPath: string): Set<string> {
  try {
    const raw = localStorage.getItem(keyFor(vaultPath));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/** Persist a vault's expanded-folder set. Stale entries (a folder later renamed
 *  or deleted) are harmless — they simply never match a live node — and the set
 *  only grows by explicit user expansions, so no pruning is needed. */
export function saveExpanded(
  vaultPath: string,
  expanded: ReadonlySet<string>,
): void {
  try {
    localStorage.setItem(keyFor(vaultPath), JSON.stringify([...expanded]));
  } catch {
    // localStorage unavailable or full — expand state just won't persist this
    // session. A UI convenience must never surface as an error.
  }
}
