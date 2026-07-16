//! Path safety — the security spine. Every command that touches a path runs it
//! through [`ensure_within`] first, so nothing can read, write, or delete outside
//! the open vault, even via `..` segments or symlinks.

use crate::error::{CoreError, CoreResult};
use icu_properties::{props::GeneralCategory, CodePointMapData, CodePointMapDataBorrowed};
use std::path::{Path, PathBuf};

/// Resolve `target` to a real absolute path and prove it lives inside `root`.
///
/// - Existing targets are `canonicalize`d (resolves `..` and follows symlinks),
///   then checked against the canonical root.
/// - Non-existent targets (e.g. a file about to be created) have their *parent*
///   canonicalised and containment-checked, then the leaf name is rejoined.
///
/// Returns the resolved path on success, or [`CoreError::OutsideVault`].
pub fn ensure_within(root: &Path, target: &Path) -> CoreResult<PathBuf> {
    let root_c = root
        .canonicalize()
        .map_err(|e| CoreError::Io(format!("vault root unreadable: {e}")))?;

    let resolved = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // Target doesn't exist yet: validate via its parent.
            let parent = target
                .parent()
                .ok_or_else(|| CoreError::OutsideVault(target.display().to_string()))?;
            let parent_c = parent
                .canonicalize()
                .map_err(|_| CoreError::NotFound(parent.display().to_string()))?;
            let name = target
                .file_name()
                .ok_or_else(|| CoreError::InvalidName(target.display().to_string()))?;
            parent_c.join(name)
        }
    };

    if resolved == root_c || resolved.starts_with(&root_c) {
        Ok(resolved)
    } else {
        Err(CoreError::OutsideVault(target.display().to_string()))
    }
}

/// Reject names that are empty, navigational, separator-bearing, or contain
/// control characters — anything that could break out of the intended folder.
pub fn validate_name(name: &str) -> CoreResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidName("name cannot be empty".into()));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(CoreError::InvalidName(format!("'{name}' is not allowed")));
    }
    // A leading dot would make the entry hidden (the tree filters dotfiles, as
    // Obsidian does), so it would silently vanish from the sidebar with no way to
    // reopen it. Refuse it loudly instead of hiding the user's content.
    if trimmed.starts_with('.') {
        return Err(CoreError::InvalidName(
            "name cannot start with a dot (it would be hidden from the vault)".into(),
        ));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(CoreError::InvalidName(
            "name cannot contain path separators".into(),
        ));
    }
    if name.chars().any(|c| c == '\0' || c.is_control()) {
        return Err(CoreError::InvalidName(
            "name contains invalid characters".into(),
        ));
    }
    Ok(())
}

static GENERAL_CATEGORY: CodePointMapDataBorrowed<'static, GeneralCategory> =
    CodePointMapData::<GeneralCategory>::new();

/// Solidus / reverse-solidus look-alikes. None is a real path separator on any
/// filesystem, so on its own none can cause traversal — but a component that
/// *reads* as `a/b` while being a single stored name is a spoofing vector against
/// a human reading a citation or an Undo report. Refused as defence in depth, not
/// as a traversal control.
const CONFUSABLE_SEPARATORS: &[char] = &[
    '\u{2044}', // ⁄ FRACTION SLASH
    '\u{2215}', // ∕ DIVISION SLASH
    '\u{FF0F}', // ／ FULLWIDTH SOLIDUS
    '\u{29F8}', // ⧸ BIG SOLIDUS
    '\u{2571}', // ╱ BOX DRAWINGS LIGHT DIAGONAL UPPER RIGHT TO LOWER LEFT
    '\u{FF3C}', // ＼ FULLWIDTH REVERSE SOLIDUS
    '\u{29F9}', // ⧹ BIG REVERSE SOLIDUS
    '\u{2216}', // ∖ SET MINUS
    '\u{2572}', // ╲ BOX DRAWINGS LIGHT DIAGONAL UPPER LEFT TO LOWER RIGHT
    '\u{FE68}', // ﹨ SMALL REVERSE SOLIDUS
    '\u{29F5}', // ⧵ REVERSE SOLIDUS OPERATOR
];

/// A vault-relative path whose *grammar* has passed the single shared gate that
/// every security-sensitive vault boundary agrees on. This type is the one source
/// of truth for the structural rules — before it existed each boundary carried its
/// own overlapping copy, free to drift.
///
/// Holding a `VaultRelPath` proves, for the string it was parsed from:
/// - it is non-empty and not absolute (no leading `/`);
/// - it contains no backslash anywhere (so Windows separators, UNC `\\server\share`
///   prefixes, and mixed `a\b/c` forms are all rejected);
/// - it has no Windows drive-letter prefix (`C:` / `C:/…`);
/// - every `/`-separated component is non-empty and is neither `.` nor `..`
///   (no traversal, no doubled/leading/trailing separators);
/// - no component contains an ASCII/Unicode control, a Unicode *format* character
///   (zero-width joiners/spaces, the BOM, bidirectional overrides such as U+202E),
///   a line/paragraph separator, or a solidus look-alike.
///
/// It deliberately does **not** prove domain constraints — a `.md` extension, a
/// byte cap, Windows-portable component names, or a leading-dot ban. Those are
/// layered on top by the specific boundary; see [`parse_note_rel_path`]. Legitimate
/// accented content in either NFC or NFD form is accepted identically and never
/// silently renormalised — filesystem-level normalisation is left to the OS
/// `canonicalize` that the confinement checks already rely on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultRelPath {
    components: Vec<String>,
}

impl VaultRelPath {
    /// Validate `raw` against the shared grammar and capture its components.
    pub fn parse(raw: &str) -> CoreResult<Self> {
        Self::check_grammar(raw)?;
        let components: Vec<String> = raw.split('/').map(str::to_string).collect();
        // check_grammar rejects an empty `raw` and every empty component, so a
        // `split('/')` always yields at least one non-empty part here. leaf() and
        // parent_components() depend on this; assert it so a future change that
        // could construct an empty component list trips in tests rather than
        // panicking later at the .last()/slice.
        debug_assert!(
            !components.is_empty(),
            "a validated VaultRelPath must have at least one component"
        );
        Ok(Self { components })
    }

    /// Whether `raw` satisfies the shared grammar, without allocating its
    /// components. Boundaries that only filter untrusted lists use this.
    pub fn is_valid(raw: &str) -> bool {
        Self::check_grammar(raw).is_ok()
    }

    /// The validated, `/`-separated components. Always at least one.
    pub fn components(&self) -> &[String] {
        &self.components
    }

    /// Consume the value and return its components.
    pub fn into_components(self) -> Vec<String> {
        self.components
    }

    /// The final component (the leaf/file name). Always present.
    pub fn leaf(&self) -> &str {
        self.components
            .last()
            .expect("a VaultRelPath always has at least one component")
    }

    /// The components above the leaf (empty when the path is a bare leaf).
    pub fn parent_components(&self) -> &[String] {
        &self.components[..self.components.len() - 1]
    }

    fn check_grammar(raw: &str) -> CoreResult<()> {
        if raw.is_empty()
            || raw.starts_with('/')
            || raw.contains('\\')
            || has_windows_drive_prefix(raw)
        {
            return Err(CoreError::OutsideVault(raw.to_string()));
        }
        for component in raw.split('/') {
            if component.is_empty() || component == "." || component == ".." {
                return Err(CoreError::OutsideVault(raw.to_string()));
            }
            if let Some(disallowed) = component
                .chars()
                .find(|&character| is_forbidden_path_char(character))
            {
                return Err(CoreError::InvalidName(format!(
                    "vault-relative path component contains a disallowed character U+{:04X}",
                    disallowed as u32
                )));
            }
        }
        Ok(())
    }
}

/// The note-file path grammar shared by the model write path
/// ([`crate::ai::write_note_policy`]) and skill Undo: the shared [`VaultRelPath`]
/// grammar, plus a leading-dot ban ([`validate_name`]), Windows-portable component
/// names, and a mandatory `.md` extension. Both note boundaries validate through
/// this one function so neither can drift stricter or looser than the other.
pub fn parse_note_rel_path(raw: &str) -> CoreResult<VaultRelPath> {
    let path = VaultRelPath::parse(raw)?;
    for component in path.components() {
        validate_name(component)?;
        validate_portable_component(component)?;
    }
    if !path
        .leaf()
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("md"))
    {
        return Err(CoreError::InvalidName(
            "vault note path must end in .md".into(),
        ));
    }
    Ok(path)
}

fn is_forbidden_path_char(character: char) -> bool {
    if CONFUSABLE_SEPARATORS.contains(&character) {
        return true;
    }
    matches!(
        GENERAL_CATEGORY.get(character),
        GeneralCategory::Control
            | GeneralCategory::Format
            | GeneralCategory::LineSeparator
            | GeneralCategory::ParagraphSeparator
    )
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Reject components that a Windows client could not store portably: reserved
/// device names, the `<>:"|?*` character class, and trailing dot/space. Layered
/// on top of the [`VaultRelPath`] grammar for note files.
fn validate_portable_component(component: &str) -> CoreResult<()> {
    if component.starts_with(' ')
        || component.ends_with(['.', ' '])
        || component
            .chars()
            .any(|character| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err(CoreError::InvalidName(format!(
            "'{component}' is not a portable vault path component"
        )));
    }

    // Win32 also recognises device names when followed by extensions and treats
    // the ISO-8859-1 superscript digits as COM/LPT port numbers. Trim a space
    // immediately before the extension so `CON .md` cannot evade that namespace.
    let basename = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end_matches(' ');
    let reserved = matches!(
        basename.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    );
    if reserved {
        return Err(CoreError::InvalidName(format!(
            "'{component}' uses a reserved Windows device name"
        )));
    }
    Ok(())
}

/// The `rel_path` (vault-relative, `/`-joined) for a resolved absolute path.
/// Falls back to the file name if `abs` is somehow not under `root`.
pub fn rel_path(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .ok()
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            abs.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
}

#[cfg(test)]
mod vault_rel_path_tests {
    use super::*;

    #[test]
    fn rejects_traversal_absolute_and_separator_escapes_as_outside_vault() {
        for raw in [
            "",
            "../escape.md",
            "a/../../b.md",
            "a/..",
            "/unix/absolute",
            "C:/windows",
            "C:relative",
            "Z:\\drive",
            "\\\\server\\share",
            "a\\b/c",
            "Folder\\Note",
            "a//b",
            "/leading",
            "trailing/",
            ".",
            "a/./b",
        ] {
            assert!(
                matches!(VaultRelPath::parse(raw), Err(CoreError::OutsideVault(_))),
                "{raw:?} must be refused as OutsideVault"
            );
            assert!(!VaultRelPath::is_valid(raw), "{raw:?} must be invalid");
        }
    }

    #[test]
    fn rejects_invisible_component_characters() {
        for raw in [
            "a\u{200b}b",     // zero-width space
            "a\u{200d}b",     // zero-width joiner
            "a\u{feff}b",     // BOM / zero-width no-break space
            "a\u{2060}b",     // word joiner
            "note\u{202e}dm", // right-to-left override
            "a\u{202a}b",     // left-to-right embedding
            "a\u{2028}b",     // line separator
            "a\u{2029}b",     // paragraph separator
            "a\tb",           // ASCII control
        ] {
            assert!(
                matches!(VaultRelPath::parse(raw), Err(CoreError::InvalidName(_))),
                "{raw:?} must be refused as InvalidName"
            );
        }
    }

    #[test]
    fn rejects_every_confusable_separator_in_the_blocklist() {
        // Table-driven over the actual constant so no entry can be silently
        // dropped without a test turning red — each look-alike, embedded in an
        // otherwise-valid component, must be refused.
        for &sep in CONFUSABLE_SEPARATORS {
            let raw = format!("a{sep}b");
            assert!(
                matches!(VaultRelPath::parse(&raw), Err(CoreError::InvalidName(_))),
                "component containing U+{:04X} must be refused as InvalidName",
                sep as u32
            );
        }
    }

    #[test]
    fn accepts_legitimate_relative_paths_including_dot_prefixed_folders() {
        let path = VaultRelPath::parse("Areas/Reading/Alpha β.md").unwrap();
        assert_eq!(path.components(), ["Areas", "Reading", "Alpha β.md"]);
        assert_eq!(path.leaf(), "Alpha β.md");
        assert_eq!(path.parent_components(), ["Areas", "Reading"]);

        // The core grammar does not impose the note-domain leading-dot ban, so a
        // real `.neuralnote` inventory folder still validates.
        assert!(VaultRelPath::is_valid(".neuralnote"));
        // An interior colon is not a drive prefix; only a leading letter+colon is.
        assert!(VaultRelPath::is_valid("Areas/a:b"));
        assert!(!VaultRelPath::is_valid("C:relative"));
    }

    #[test]
    fn accepts_nfc_and_nfd_forms_consistently_without_renormalising() {
        let nfc = "Caf\u{00e9}.md"; // é as one code point
        let nfd = "Cafe\u{0301}.md"; // e + combining acute
        let parsed_nfc = VaultRelPath::parse(nfc).unwrap();
        let parsed_nfd = VaultRelPath::parse(nfd).unwrap();
        assert_eq!(parsed_nfc.leaf(), nfc, "NFC form is preserved verbatim");
        assert_eq!(parsed_nfd.leaf(), nfd, "NFD form is preserved verbatim");
    }

    #[test]
    fn percent_encoded_dot_dot_is_a_literal_component_not_traversal() {
        // The grammar never URL-decodes, so `%2e%2e` cannot smuggle traversal.
        let parsed = VaultRelPath::parse("a/%2e%2e/b").unwrap();
        assert_eq!(parsed.components(), ["a", "%2e%2e", "b"]);
    }

    #[test]
    fn note_paths_require_md_and_portable_leading_dot_free_components() {
        assert!(parse_note_rel_path("Folder/Note.md").is_ok());
        assert_eq!(
            parse_note_rel_path("Note.md").unwrap().parent_components(),
            [] as [String; 0]
        );
        for raw in [
            "Folder/Note.txt", // wrong extension
            ".hidden/Note.md", // leading-dot component
            "CON.md",          // reserved device name
            "bad:name.md",     // portable char class
            "question?.md",
            "Folder /Note.md", // component with a trailing space is not portable
            "../Note.md",      // traversal still refused by the shared grammar
        ] {
            assert!(
                parse_note_rel_path(raw).is_err(),
                "{raw:?} must be refused for note writes"
            );
        }
    }
}
