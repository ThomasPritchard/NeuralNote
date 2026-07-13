//! Compiled-in requirement-file catalogues and their pure validation policy.

use crate::{CoreError, CoreResult};

/// Filesystem and permission policy for a compiled-in requirement download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequirementInstallKind {
    Executable,
    Asset,
}

/// A requirement filename the host may recognise in app-data. This catalogue is
/// broader than the downloadable table: pending files can be installed manually
/// without granting the downloader an unpinned URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequirementFile {
    pub name: &'static str,
    pub install_kind: RequirementInstallKind,
}

/// A trusted, compiled-in requirement file that the shell may download into app-data.
///
/// The webview supplies only `name`; the URL and mandatory digest always come from
/// this core-owned specification so an IPC caller cannot turn the downloader into
/// an arbitrary network or filesystem primitive or bypass integrity verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequirementBinary {
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub install_kind: RequirementInstallKind,
}

/// A pinned source archive compiled locally into one requirement executable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequirementSourceBuild {
    pub name: &'static str,
    pub version: &'static str,
    pub archive_url: &'static str,
    pub archive_sha256: &'static str,
    pub archive_root: &'static str,
    pub output_rel_path: &'static str,
}

const REQUIREMENT_BINARIES: &[RequirementBinary] = &[
    RequirementBinary {
        name: "yt-dlp",
        url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos",
        sha256: "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b",
        install_kind: RequirementInstallKind::Executable,
    },
    // Integrity source: GitHub's build-provenance attestation for this SHA-256; upstream publishes no checksum file.
    RequirementBinary {
        name: "bgutil-pot",
        url: "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/download/v0.8.1/bgutil-pot-macos-aarch64",
        sha256: "34b83baf0a557fecaa6d67a8177e53e169c2ccf987182883a4bae289a7176883",
        install_kind: RequirementInstallKind::Executable,
    },
    // Integrity source: GitHub's v0.8.1 asset digest, independently matched by
    // a direct TLS download on 2026-07-12. Upstream publishes no checksum file.
    RequirementBinary {
        name: "bgutil-plugin.zip",
        url: "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/download/v0.8.1/bgutil-ytdlp-pot-provider-rs.zip",
        sha256: "99fd83b98fa93b193d6a3b69dc74410d76e7a2b889868c54d16121cac9060344",
        install_kind: RequirementInstallKind::Asset,
    },
    // Integrity source: upstream Hugging Face LFS SHA-256 for the small.en model.
    RequirementBinary {
        name: "ggml-small.en.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
        sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
        install_kind: RequirementInstallKind::Asset,
    },
    // TODO(x86-64-assets): add the x86_64 bgutil-pot release asset when the catalogue can select by architecture.
];

const REQUIREMENT_SOURCE_BUILDS: &[RequirementSourceBuild] = &[RequirementSourceBuild {
    name: "whisper-cli",
    version: "v1.9.1",
    archive_url: "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.1",
    archive_sha256: "147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447",
    archive_root: "whisper.cpp-1.9.1",
    output_rel_path: "build/bin/whisper-cli",
}];

const REQUIREMENT_FILES: &[RequirementFile] = &[
    RequirementFile {
        name: "yt-dlp",
        install_kind: RequirementInstallKind::Executable,
    },
    RequirementFile {
        name: "bgutil-pot",
        install_kind: RequirementInstallKind::Executable,
    },
    RequirementFile {
        name: "bgutil-plugin.zip",
        install_kind: RequirementInstallKind::Asset,
    },
    RequirementFile {
        name: "whisper-cli",
        install_kind: RequirementInstallKind::Executable,
    },
    RequirementFile {
        name: "ggml-small.en.bin",
        install_kind: RequirementInstallKind::Asset,
    },
];

/// Every compiled-in requirement the host may recognise or install.
pub fn requirement_binaries() -> &'static [RequirementBinary] {
    REQUIREMENT_BINARIES
}

/// Every requirement file the host may recognise, including pending files that
/// cannot yet be downloaded because no trusted release specification exists.
pub fn requirement_files() -> &'static [RequirementFile] {
    REQUIREMENT_FILES
}

pub fn lookup_requirement_source_build(name: &str) -> CoreResult<RequirementSourceBuild> {
    validate_requirement_binary_name(name)?;
    REQUIREMENT_SOURCE_BUILDS
        .iter()
        .find(|build| build.name == name)
        .copied()
        .ok_or_else(|| {
            CoreError::NotFound(format!(
                "no source-build requirement is registered for '{name}'"
            ))
        })
}

/// Reject anything except one ordinary leaf filename before it reaches a join or
/// an app-data write. Both separator styles are rejected on every platform so the
/// same IPC value cannot become safe on macOS and dangerous on Windows later.
pub fn validate_requirement_binary_name(name: &str) -> CoreResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidName(
            "requirement binary name cannot be empty".into(),
        ));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(CoreError::InvalidName(format!(
            "requirement binary name '{name}' is navigational"
        )));
    }
    if name.contains(['/', '\\']) {
        return Err(CoreError::InvalidName(
            "requirement binary name cannot contain path separators".into(),
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(CoreError::InvalidName(
            "requirement binary name contains control characters".into(),
        ));
    }
    Ok(())
}

/// Resolve a caller-provided name against the compiled-in allowlist. Unknown
/// names are explicit errors; callers must never synthesize a URL from the name.
pub fn lookup_requirement_binary(name: &str) -> CoreResult<RequirementBinary> {
    validate_requirement_binary_name(name)?;
    REQUIREMENT_BINARIES
        .iter()
        .find(|binary| binary.name == name)
        .copied()
        .ok_or_else(|| {
            CoreError::NotFound(format!(
                "no downloadable requirement binary is registered for '{name}'"
            ))
        })
}

/// Compare the incrementally-computed SHA-256 supplied by the shell with the
/// trusted expected digest. Malformed policy and mismatched bytes both fail closed
/// with distinct, surfaced errors.
pub fn verify_requirement_checksum(expected_sha256: &str, actual_sha256: &str) -> CoreResult<()> {
    if expected_sha256.len() != 64 || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(CoreError::Io(
            "configured SHA-256 checksum must be exactly 64 hexadecimal characters".into(),
        ));
    }
    if !expected_sha256.eq_ignore_ascii_case(actual_sha256) {
        return Err(CoreError::Io("checksum mismatch".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONST_BACKED_FIXTURE: RequirementBinary = RequirementBinary {
        name: "fixture-bin",
        url: "https://example.invalid/fixture-bin",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        install_kind: RequirementInstallKind::Executable,
    };
    const CONST_EXECUTABLE_KIND: RequirementInstallKind = RequirementInstallKind::Executable;
    const CONST_ASSET_KIND: RequirementInstallKind = RequirementInstallKind::Asset;
    const CONST_REQUIREMENT_FILE: RequirementFile = RequirementFile {
        name: "fixture-asset",
        install_kind: RequirementInstallKind::Asset,
    };

    #[test]
    fn requirement_binary_fields_are_const_backed_static_strings() {
        assert_eq!(CONST_BACKED_FIXTURE.name, "fixture-bin");
    }

    #[test]
    fn requirement_install_kinds_are_const_backed() {
        assert_eq!(CONST_EXECUTABLE_KIND, RequirementInstallKind::Executable);
        assert_eq!(CONST_ASSET_KIND, RequirementInstallKind::Asset);
        assert_eq!(CONST_REQUIREMENT_FILE.name, "fixture-asset");
    }

    #[test]
    fn requirement_binary_catalogue_is_publicly_iterable_with_install_kind() {
        let catalogue = requirement_binaries();

        assert_eq!(catalogue.len(), 4);
        assert_eq!(
            catalogue
                .iter()
                .filter(|requirement| {
                    requirement.install_kind == RequirementInstallKind::Executable
                })
                .count(),
            2
        );
    }

    #[test]
    fn requirement_file_catalogue_includes_ready_and_pending_files() {
        assert_eq!(
            requirement_files(),
            [
                RequirementFile {
                    name: "yt-dlp",
                    install_kind: RequirementInstallKind::Executable,
                },
                RequirementFile {
                    name: "bgutil-pot",
                    install_kind: RequirementInstallKind::Executable,
                },
                RequirementFile {
                    name: "bgutil-plugin.zip",
                    install_kind: RequirementInstallKind::Asset,
                },
                RequirementFile {
                    name: "whisper-cli",
                    install_kind: RequirementInstallKind::Executable,
                },
                RequirementFile {
                    name: "ggml-small.en.bin",
                    install_kind: RequirementInstallKind::Asset,
                },
            ]
        );
    }

    #[test]
    fn pending_requirement_files_are_not_downloadable() {
        let name = "whisper-cli";
        assert!(matches!(
            lookup_requirement_binary(name),
            Err(CoreError::NotFound(message)) if message.contains(name)
        ));
    }

    #[test]
    fn whisper_cli_resolves_to_the_pinned_v1_9_1_source_build() {
        assert_eq!(
            lookup_requirement_source_build("whisper-cli").unwrap(),
            RequirementSourceBuild {
                name: "whisper-cli",
                version: "v1.9.1",
                archive_url:
                    "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.1",
                archive_sha256: "147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447",
                archive_root: "whisper.cpp-1.9.1",
                output_rel_path: "build/bin/whisper-cli",
            }
        );
    }

    #[test]
    fn whisper_model_resolves_to_the_pinned_asset() {
        assert_eq!(
            lookup_requirement_binary("ggml-small.en.bin").unwrap(),
            RequirementBinary {
                name: "ggml-small.en.bin",
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
                sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
                install_kind: RequirementInstallKind::Asset,
            }
        );
    }

    #[test]
    fn requirement_binary_name_accepts_a_bare_file_name() {
        assert!(validate_requirement_binary_name("yt-dlp").is_ok());
        assert!(validate_requirement_binary_name("fixture.bin").is_ok());
    }

    #[test]
    fn requirement_binary_name_rejects_navigation_separators_and_controls() {
        for name in [
            "",
            "   ",
            ".",
            "..",
            "bin/tool",
            "bin\\tool",
            "bad\nname",
            "bad\0name",
        ] {
            assert!(
                matches!(
                    validate_requirement_binary_name(name),
                    Err(CoreError::InvalidName(_))
                ),
                "{name:?} must be rejected"
            );
        }
    }

    #[test]
    fn requirement_binary_lookup_reports_an_unknown_valid_name_explicitly() {
        let result = lookup_requirement_binary("not-registered");

        assert!(matches!(
            result,
            Err(CoreError::NotFound(message)) if message.contains("not-registered")
        ));
    }

    #[test]
    fn requirement_binary_lookup_validates_before_searching() {
        assert!(matches!(
            lookup_requirement_binary("../escape"),
            Err(CoreError::InvalidName(_))
        ));
    }

    #[test]
    fn requirement_binary_catalogue_contains_pinned_ytdlp() {
        assert_eq!(
            lookup_requirement_binary("yt-dlp").unwrap(),
            RequirementBinary {
                name: "yt-dlp",
                url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos",
                sha256: "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b",
                install_kind: RequirementInstallKind::Executable,
            }
        );
    }

    #[test]
    fn requirement_binary_catalogue_contains_pinned_bgutil_pot() {
        assert_eq!(
            lookup_requirement_binary("bgutil-pot").unwrap(),
            RequirementBinary {
                name: "bgutil-pot",
                url: "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/download/v0.8.1/bgutil-pot-macos-aarch64",
                sha256: "34b83baf0a557fecaa6d67a8177e53e169c2ccf987182883a4bae289a7176883",
                install_kind: RequirementInstallKind::Executable,
            }
        );
    }

    #[test]
    fn requirement_binary_catalogue_contains_pinned_bgutil_plugin() {
        assert_eq!(
            lookup_requirement_binary("bgutil-plugin.zip").unwrap(),
            RequirementBinary {
                name: "bgutil-plugin.zip",
                url: "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/download/v0.8.1/bgutil-ytdlp-pot-provider-rs.zip",
                sha256: "99fd83b98fa93b193d6a3b69dc74410d76e7a2b889868c54d16121cac9060344",
                install_kind: RequirementInstallKind::Asset,
            }
        );
    }

    #[test]
    fn requirement_binary_checksum_accepts_the_expected_sha256() {
        let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        assert!(verify_requirement_checksum(digest, digest).is_ok());
        assert!(verify_requirement_checksum(&digest.to_uppercase(), digest).is_ok());
    }

    #[test]
    fn requirement_binary_checksum_rejects_a_malformed_expectation() {
        for expected in [
            "abc",
            "z123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ] {
            let result = verify_requirement_checksum(expected, "0");
            assert!(matches!(
                result,
                Err(CoreError::Io(message)) if message.contains("configured SHA-256 checksum")
            ));
        }
    }

    #[test]
    fn requirement_binary_checksum_mismatch_is_explicit() {
        let expected = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let actual = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

        assert!(matches!(
            verify_requirement_checksum(expected, actual),
            Err(CoreError::Io(message)) if message == "checksum mismatch"
        ));
    }

    #[test]
    fn requirement_binary_table_uses_https_and_lowercase_sha256() {
        for binary in REQUIREMENT_BINARIES {
            assert!(binary.url.starts_with("https://"), "{}", binary.name);
            assert_eq!(binary.sha256.len(), 64, "{}", binary.name);
            assert!(
                binary
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                "{}",
                binary.name
            );
        }
    }
}
