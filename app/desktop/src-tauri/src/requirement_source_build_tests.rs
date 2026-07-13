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
