// Persist the file tree's collapsed-folder set per vault, so a user's manual
// folds survive an app restart (the tree still opens everything by *default* —
// an empty stored set means all-open).
//
// This is pure client UI state: it lives in the webview's localStorage, never in
// the vault or the Rust core. A future mobile/PWA client wouldn't inherit "which
// sidebar folders this desktop user folded", so it deliberately doesn't go
// through the shared core. It also never touches vault markdown, so the
// Obsidian-compatibility / data-format rules aren't in play.
//
// Keyed by vault path so two vaults never clobber each other's fold state. Every
// access is guarded: a disabled or full localStorage (private mode, quota) must
// degrade to "don't persist", never throw into the render path.

const KEY_PREFIX = "nn:tree-collapsed:";

const keyFor = (vaultPath: string): string => `${KEY_PREFIX}${vaultPath}`;

/** The persisted collapsed-folder set for a vault; empty (all-open) if none or
 *  if storage is unreadable/corrupt. Non-string entries are dropped defensively
 *  so a hand-edited value can't inject junk relPaths into the tree. */
export function loadCollapsed(vaultPath: string): Set<string> {
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

/** Persist a vault's collapsed-folder set. Stale entries (a folder later renamed
 *  or deleted) are harmless — they simply never match a live node — and the set
 *  only grows by explicit user folds, so no pruning is needed. */
export function saveCollapsed(vaultPath: string, collapsed: Set<string>): void {
  try {
    localStorage.setItem(keyFor(vaultPath), JSON.stringify([...collapsed]));
  } catch {
    // localStorage unavailable or full — fold state just won't persist this
    // session. A UI convenience must never surface as an error.
  }
}
