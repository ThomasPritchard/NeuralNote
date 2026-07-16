//! Bounded, insertion-recency (LRU) set of folders the user explicitly authorized
//! this session via the native picker.
//!
//! The vault-root authorization check (PA-004) only lets `open_vault` /
//! `create_vault` point the vault at a folder the user actually chose, so a
//! compromised webview can't aim every file command at an arbitrary path. That set
//! used to be an unbounded `HashSet`, so it retained every picked folder for the
//! whole process lifetime. This type caps it: memory and delete-scope authority
//! stay bounded, eviction drops the *oldest* entry (fail-closed — an evicted path
//! is no longer authorized), and re-picking a known folder refreshes its recency
//! instead of double-counting.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};

/// Cap on distinct authorized folders retained per session. A session realistically
/// picks a handful of folders; 32 sits far above that yet fixes the worst-case
/// memory and authority ceiling. Eviction never widens authority (it only forgets),
/// and any folder that was actually opened also lives in the on-disk recents list,
/// so a re-open still authorizes through `path_in_recents` even after eviction here.
const MAX_AUTHORIZED_PATHS: usize = 32;

/// Bounded LRU set of canonical folder paths. Callers canonicalize before both
/// `insert` and `contains`, so membership is an exact match on canonical form —
/// this type never transforms a path, and so can never widen authority.
#[derive(Default)]
pub(crate) struct AuthorizedPaths {
    members: HashSet<PathBuf>,
    order: VecDeque<PathBuf>,
}

impl AuthorizedPaths {
    /// Authorize a folder, refreshing its recency if already present. Re-inserting
    /// an existing path moves it to most-recent without double-counting. When the
    /// set is at capacity, the least-recently-inserted path is evicted first.
    pub(crate) fn insert(&mut self, path: PathBuf) {
        if self.members.remove(&path) {
            self.order.retain(|stored| stored != &path);
        }
        while self.members.len() >= MAX_AUTHORIZED_PATHS {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.members.remove(&oldest);
        }
        self.order.push_back(path.clone());
        self.members.insert(path);
    }

    /// Whether `path` is currently authorized. Read-only: a security check must not
    /// mutate state, so this deliberately does not refresh recency. An evicted path
    /// returns `false` (fail-closed).
    pub(crate) fn contains(&self, path: &Path) -> bool {
        self.members.contains(path)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.members.len()
    }
}

#[cfg(test)]
mod tests {
    use super::{AuthorizedPaths, MAX_AUTHORIZED_PATHS};
    use std::path::PathBuf;

    fn path(index: usize) -> PathBuf {
        PathBuf::from(format!("/vault/folder-{index}"))
    }

    #[test]
    fn authorized_and_never_added_paths_are_distinguished() {
        let mut set = AuthorizedPaths::default();
        set.insert(path(1));

        assert!(set.contains(&path(1)), "a picked path must be authorized");
        assert!(
            !set.contains(&path(2)),
            "a never-picked path must be denied (fail-closed)"
        );
    }

    #[test]
    fn set_does_not_grow_unbounded_and_stays_at_cap() {
        let mut set = AuthorizedPaths::default();
        for index in 0..(MAX_AUTHORIZED_PATHS * 3) {
            set.insert(path(index));
        }

        assert_eq!(
            set.len(),
            MAX_AUTHORIZED_PATHS,
            "the set must never exceed its cap however many folders are picked"
        );
    }

    #[test]
    fn oldest_is_evicted_and_an_evicted_path_is_no_longer_authorized() {
        let mut set = AuthorizedPaths::default();
        for index in 0..MAX_AUTHORIZED_PATHS {
            set.insert(path(index));
        }
        // One pick past capacity evicts the oldest (index 0).
        set.insert(path(MAX_AUTHORIZED_PATHS));

        assert!(
            !set.contains(&path(0)),
            "the evicted oldest path must fail closed, not silently stay authorized"
        );
        assert!(
            set.contains(&path(1)),
            "a still-resident path must remain authorized"
        );
        assert!(
            set.contains(&path(MAX_AUTHORIZED_PATHS)),
            "the newly picked path must be authorized"
        );
        assert_eq!(set.len(), MAX_AUTHORIZED_PATHS);
    }

    #[test]
    fn reinserting_an_existing_path_does_not_double_count_and_refreshes_recency() {
        let mut set = AuthorizedPaths::default();
        for index in 0..MAX_AUTHORIZED_PATHS {
            set.insert(path(index));
        }
        // Re-pick the oldest, promoting it to most-recent without growing the set.
        set.insert(path(0));
        assert_eq!(
            set.len(),
            MAX_AUTHORIZED_PATHS,
            "re-adding must not double-count"
        );

        // The next distinct pick now evicts index 1 (the new oldest), not the
        // refreshed index 0.
        set.insert(path(MAX_AUTHORIZED_PATHS));

        assert!(
            set.contains(&path(0)),
            "a refreshed path must survive the next eviction"
        );
        assert!(
            !set.contains(&path(1)),
            "the new oldest after the refresh must be the one evicted"
        );
        assert_eq!(set.len(), MAX_AUTHORIZED_PATHS);
    }

    #[test]
    fn eviction_never_authorizes_a_path_that_was_never_added() {
        let mut set = AuthorizedPaths::default();
        for index in 0..(MAX_AUTHORIZED_PATHS + 5) {
            set.insert(path(index));
        }
        // Churn must not manufacture authority for an unpicked path.
        assert!(!set.contains(&PathBuf::from("/etc/passwd")));
    }
}
