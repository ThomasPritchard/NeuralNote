use super::{
    create_private_staging, extract_source_archive, validate_source_entry, whisper_build_specs,
};
use neuralnote_core::ai::lookup_requirement_source_build;
use std::path::Path;

fn archive(entries: &[(&str, tar::EntryType, &[u8], Option<&str>)]) -> Vec<u8> {
    use std::io::Write as _;
    let mut compressed = Vec::new();
    {
        let encoder =
            flate2::write::GzEncoder::new(&mut compressed, flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (path, kind, body, link) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(*kind);
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            if let Some(link) = link {
                header.set_link_name(link).unwrap();
            }
            builder.append_data(&mut header, path, *body).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }
    compressed.flush().unwrap();
    compressed
}

#[test]
fn source_archive_extracts_only_regular_files_under_the_expected_root() {
    let bytes = archive(&[(
        "whisper.cpp-1.9.1/CMakeLists.txt",
        tar::EntryType::Regular,
        b"project(whisper)",
        None,
    )]);
    let staging = tempfile::tempdir().unwrap();
    let recipe = lookup_requirement_source_build("whisper-cli").unwrap();

    let root = extract_source_archive(&bytes, staging.path(), &recipe).unwrap();

    assert_eq!(root, staging.path().join("whisper.cpp-1.9.1"));
    assert_eq!(
        std::fs::read(root.join("CMakeLists.txt")).unwrap(),
        b"project(whisper)"
    );
}

/// Every tarball GitHub's codeload endpoint serves — including the pinned
/// whisper.cpp v1.9.1 one — opens with a `pax_global_header` record. `tar` hands
/// that record to the caller (unlike GNU long names and pax *local* extensions,
/// which it consumes itself), and it carries no archive root, so the root rule
/// rejected it and the whole install died before a single file was written.
/// It is tar metadata, not a filesystem entry, so it is skipped rather than
/// validated.
#[test]
fn a_pax_global_header_does_not_abort_the_pinned_source_archive() {
    let bytes = archive(&[
        (
            "pax_global_header",
            tar::EntryType::XGlobalHeader,
            b"52 comment=0000000000000000000000000000000000000000\n",
            None,
        ),
        (
            "whisper.cpp-1.9.1/CMakeLists.txt",
            tar::EntryType::Regular,
            b"project(whisper)",
            None,
        ),
    ]);
    let staging = tempfile::tempdir().unwrap();
    let recipe = lookup_requirement_source_build("whisper-cli").unwrap();

    let root = extract_source_archive(&bytes, staging.path(), &recipe).unwrap();

    assert_eq!(root, staging.path().join("whisper.cpp-1.9.1"));
    assert!(!staging.path().join("pax_global_header").exists());
}

/// Skipping the metadata record must not become a smuggling route. Two shapes
/// have to stay harmless: a *regular* file that merely calls itself
/// `pax_global_header` still lands on disk, so it still has to obey the
/// archive-root rule; and a genuine `g` record naming a path outside the archive
/// root writes nothing, because the skip happens before `unpack_in` rather than
/// after a path check. (A `..` path cannot be expressed here at all — `tar`'s
/// *builder* refuses to write one — so the escape this can construct is a
/// sibling of the expected root.)
#[test]
fn the_pax_skip_is_not_a_smuggling_route() {
    let staging = tempfile::tempdir().unwrap();
    let recipe = lookup_requirement_source_build("whisper-cli").unwrap();

    let disguised = archive(&[(
        "pax_global_header",
        tar::EntryType::Regular,
        b"payload",
        None,
    )]);
    assert!(extract_source_archive(&disguised, staging.path(), &recipe).is_err());
    assert!(!staging.path().join("pax_global_header").exists());

    let escaping = archive(&[
        (
            "escaped/payload",
            tar::EntryType::XGlobalHeader,
            b"payload",
            None,
        ),
        (
            "whisper.cpp-1.9.1/CMakeLists.txt",
            tar::EntryType::Regular,
            b"project(whisper)",
            None,
        ),
    ]);
    let second = tempfile::tempdir().unwrap();

    extract_source_archive(&escaping, second.path(), &recipe).unwrap();

    assert!(!second.path().join("escaped").exists());
    assert!(second
        .path()
        .join("whisper.cpp-1.9.1/CMakeLists.txt")
        .exists());
}

#[test]
fn source_archive_rejects_links_navigation_and_wrong_roots() {
    let recipe = lookup_requirement_source_build("whisper-cli").unwrap();
    for (path, kind, link) in [
        ("other-root/file", tar::EntryType::Regular, None),
        (
            "whisper.cpp-1.9.1/link",
            tar::EntryType::Symlink,
            Some("/tmp/escape"),
        ),
        (
            "whisper.cpp-1.9.1/hard",
            tar::EntryType::Link,
            Some("whisper.cpp-1.9.1/file"),
        ),
    ] {
        let bytes = archive(&[(path, kind, b"x", link)]);
        let staging = tempfile::tempdir().unwrap();
        assert!(extract_source_archive(&bytes, staging.path(), &recipe).is_err());
    }
    for path in ["../escape", "/absolute", "whisper.cpp-1.9.1/../escape"] {
        assert!(validate_source_entry(Path::new(path), tar::EntryType::Regular, &recipe).is_err());
    }
}

#[test]
fn whisper_build_processes_use_static_argv_cleared_env_and_private_paths() {
    let staging = Path::new("/private/tmp/neuralnote-whisper");
    let source = staging.join("whisper.cpp-1.9.1");
    let cmake = Path::new("/opt/homebrew/bin/cmake");

    let [configure, build] = whisper_build_specs(cmake, staging, &source).unwrap();

    assert_eq!(configure.program, cmake);
    assert_eq!(configure.cwd.as_deref(), Some(source.as_path()));
    assert_eq!(configure.args[0], "-S");
    assert_eq!(configure.args[2], "-B");
    assert_eq!(build.args[0], "--build");
    assert_eq!(build.args[2], "--config");
    assert!(format!("{:?}", configure.environment).contains("ClearAndSet"));
}

/// The published artefact is a single file and the staging tree that produced it
/// is deleted straight afterwards, so anything whisper.cpp links dynamically is
/// gone by the time the user runs it. A default (shared) configure emits a
/// `whisper-cli` carrying six `@rpath` dylib references and an `LC_RPATH` naming
/// the deleted staging `build/bin`, which dyld cannot satisfy. Building the
/// libraries into the executable is what keeps the one-file publish honest.
#[test]
fn the_configure_step_links_whisper_statically_so_one_published_file_is_self_contained() {
    let staging = Path::new("/private/tmp/neuralnote-whisper");
    let source = staging.join("whisper.cpp-1.9.1");

    let [configure, _build] =
        whisper_build_specs(Path::new("/opt/homebrew/bin/cmake"), staging, &source).unwrap();

    assert!(
        configure
            .args
            .iter()
            .any(|arg| arg == "-DBUILD_SHARED_LIBS=OFF"),
        "configure args must disable shared libraries, got {:?}",
        configure.args
    );
}

#[cfg(unix)]
#[test]
fn source_build_rejects_an_app_data_build_symlink() {
    use std::os::unix::fs::symlink;
    let app_data = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), app_data.path().join("build")).unwrap();

    assert!(create_private_staging(app_data.path()).is_err());
    assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
}
