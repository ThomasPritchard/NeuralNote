//! The salted, case-folded correlation digest — the only thing that stands in
//! for a path when a request is described to the classifier.
//!
//! Split out of `subject.rs` because it is a distinct responsibility with its own
//! threat argument: the subject module decides *what facts* describe a request,
//! this one decides *how a request is identified without disclosing it*.

use crate::ai::approval::gated::GatedTool;
use caseless::Caseless;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// A per-run secret used to salt path digests.
///
/// Fresh per run, never persisted, and never sent anywhere. Without it, a party
/// holding the digest (the classifier's provider) could dictionary-attack common
/// note names back out of it; with it, they cannot. Per-run rather than
/// per-install because the digest only needs to be stable for the lifetime of the
/// `DeniedSet` and the verdict cache, both of which die with the run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathDigestSalt([u8; 32]);

impl PathDigestSalt {
    /// A fresh salt.
    ///
    /// `std`'s `RandomState` is seeded from OS entropy and re-keys per instance;
    /// it is the only OS entropy the standard library exposes, and the core is
    /// deliberately runtime- and dependency-light (no RNG crate). Four
    /// independently-keyed hashers over a fixed message give 256 bits derived
    /// from those keys.
    pub fn fresh() -> Self {
        use std::hash::{BuildHasher, Hasher, RandomState};
        let mut bytes = [0u8; 32];
        for chunk in 0..4 {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u64(chunk as u64);
            let word = hasher.finish().to_le_bytes();
            bytes[chunk * 8..chunk * 8 + 8].copy_from_slice(&word);
        }
        Self(bytes)
    }

    /// A fixed salt, so tests can assert on an exact digest.
    pub fn fixed(seed: u8) -> Self {
        Self([seed; 32])
    }
}

impl Default for PathDigestSalt {
    fn default() -> Self {
        Self::fresh()
    }
}

/// A salted, case-folded digest of a call's target identity — 128 bits rendered
/// as 32 lowercase hex characters.
///
/// This is a newtype over bytes, **not** a `String`: only hex digits can ever be
/// emitted, so no attacker-controllable text can travel in this field even though
/// its serialised form is textual.
///
/// Case is folded before hashing so `Note.md` and `note.md` collapse to one
/// subject the way a case-insensitive volume (the macOS default) does. On a
/// case-sensitive volume that is *conservative* — it merges two genuinely
/// distinct paths into one `DeniedSet` entry, which is more restrictive, never
/// less.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PathDigest([u8; 16]);

impl PathDigest {
    /// Digest `identity` under `salt`, domain-separated by the tool.
    ///
    /// The identity is the *stable* part of the request, not the whole call: for
    /// a note create it is the canonical vault-relative path and nothing else, so
    /// re-proposing the same path with reworded content produces the SAME digest
    /// and the `DeniedSet` still recognises it. Including the body would let a
    /// one-character edit defeat the denial counter.
    pub(in crate::ai::approval) fn compute(
        salt: &PathDigestSalt,
        tool: GatedTool,
        identity: &str,
    ) -> Self {
        let folded: String = identity.chars().default_case_fold().collect();
        let mut hasher = Sha256::new();
        hasher.update(salt.0);
        hasher.update(tool.name().as_bytes());
        hasher.update([0u8]);
        hasher.update(folded.as_bytes());
        let full = hasher.finalize();
        let mut truncated = [0u8; 16];
        truncated.copy_from_slice(&full[..16]);
        Self(truncated)
    }

    fn to_hex(self) -> String {
        self.0.iter().fold(String::with_capacity(32), |mut out, b| {
            use std::fmt::Write as _;
            let _ = write!(out, "{b:02x}");
            out
        })
    }
}

impl Serialize for PathDigest {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The grammar the subject's serialisation test enforces, restated here so
    /// this module can check its own output without reaching into a sibling's
    /// test module.
    fn is_digest(text: &str) -> bool {
        text.len() == 32
            && text
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
    }

    #[test]
    fn a_path_that_differs_only_in_case_produces_the_same_digest() {
        // macOS folds case in the filesystem. Without folding, `Note.md` and
        // `note.md` read as two subjects and one denial protects neither.
        let dir = tempfile::tempdir().unwrap();
        let salt = PathDigestSalt::fixed(3);
        let lower = PathDigest::compute(&salt, GatedTool::WriteNote, "notes/note.md");
        let upper = PathDigest::compute(&salt, GatedTool::WriteNote, "Notes/Note.MD");
        assert_eq!(lower, upper);
        drop(dir);
    }

    #[test]
    fn different_salts_produce_different_digests_for_the_same_path() {
        let a = PathDigest::compute(&PathDigestSalt::fixed(1), GatedTool::WriteNote, "a.md");
        let b = PathDigest::compute(&PathDigestSalt::fixed(2), GatedTool::WriteNote, "a.md");
        assert_ne!(a, b);
    }

    #[test]
    fn a_fresh_salt_is_not_the_all_zero_salt() {
        assert_ne!(PathDigestSalt::fresh(), PathDigestSalt::fixed(0));
        assert_ne!(PathDigestSalt::fresh(), PathDigestSalt::fresh());
    }

    #[test]
    fn the_digest_renders_as_thirty_two_lowercase_hex_characters() {
        let digest = PathDigest::compute(&PathDigestSalt::fixed(9), GatedTool::WriteNote, "a.md");
        assert!(is_digest(&digest.to_hex()));
        assert_eq!(serde_json::to_value(digest).unwrap(), digest.to_hex());
    }
}
