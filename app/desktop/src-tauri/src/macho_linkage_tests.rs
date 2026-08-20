use super::{inspect, Linkage};
use crate::macho_fixtures::{
    executable, executable_for, executable_with_modern_weak_link,
    executable_with_non_utf8_dylib_name, executable_with_unreadable_dylib_name,
    executable_with_unreadable_run_path, universal, FOREIGN_CPU_TYPE, HOST_CPU_TYPE, SYSTEM_DYLIBS,
    WHISPER_DYLIBS,
};
use std::path::{Path, PathBuf};

fn write_image(directory: &Path, bytes: &[u8]) -> PathBuf {
    let path = directory.join("whisper-cli");
    std::fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn a_binary_whose_run_path_was_deleted_names_every_library_it_cannot_find() {
    let app_data = tempfile::tempdir().unwrap();
    let deleted = app_data.path().join("build/whisper.cpp-1.9.1/build/bin");
    let image = write_image(
        app_data.path(),
        &executable(WHISPER_DYLIBS, &[], &[&deleted.to_string_lossy()]),
    );

    let Linkage::Unresolved(missing) = inspect(&image) else {
        panic!("a binary linked against a deleted build tree must not read as resolved");
    };

    assert_eq!(missing, WHISPER_DYLIBS);
}

#[test]
fn a_binary_whose_run_path_still_holds_its_libraries_resolves() {
    let app_data = tempfile::tempdir().unwrap();
    let libraries = app_data.path().join("lib");
    std::fs::create_dir_all(&libraries).unwrap();
    for name in WHISPER_DYLIBS {
        let file = name.strip_prefix("@rpath/").unwrap();
        std::fs::write(libraries.join(file), b"stand-in").unwrap();
    }
    let image = write_image(
        app_data.path(),
        &executable(WHISPER_DYLIBS, &[], &[&libraries.to_string_lossy()]),
    );

    assert_eq!(inspect(&image), Linkage::Resolved);
}

/// The trap that makes a naive existence check useless: dyld serves these from
/// the shared cache and none of them exists as a file on macOS 11 or later, so
/// looking them up on disk would condemn every healthy binary on the machine.
#[test]
fn libraries_the_shared_cache_serves_are_not_looked_for_on_disk() {
    let app_data = tempfile::tempdir().unwrap();
    let system = [
        "/usr/lib/libSystem.B.dylib",
        "/usr/lib/libc++.1.dylib",
        "/usr/lib/libobjc.A.dylib",
        "/System/Library/Frameworks/Metal.framework/Versions/A/Metal",
        "/System/Library/Frameworks/Accelerate.framework/Versions/A/Accelerate",
    ];
    for path in system {
        assert!(
            !Path::new(path).exists(),
            "{path} exists on disk, so this test no longer proves anything"
        );
    }
    let image = write_image(app_data.path(), &executable(&system, &[], &[]));

    assert_eq!(inspect(&image), Linkage::Resolved);
}

/// This is the linkage the fix produces: the real statically linked `whisper-cli`
/// declares only shared-cache libraries and carries no `LC_RPATH` at all.
#[test]
fn a_statically_linked_binary_needs_no_run_paths() {
    let app_data = tempfile::tempdir().unwrap();
    let image = write_image(app_data.path(), &executable(SYSTEM_DYLIBS, &[], &[]));

    assert_eq!(inspect(&image), Linkage::Resolved);
}

/// The fail-open case that matters most. A dependency whose name cannot be read
/// must not simply vanish from the list being checked, because an empty list of
/// unresolved names is what `Resolved` is made of.
#[test]
fn a_dependency_whose_name_cannot_be_read_is_never_reported_as_resolved() {
    let app_data = tempfile::tempdir().unwrap();

    for (label, bytes) in [
        (
            "an out-of-range name offset",
            executable_with_unreadable_dylib_name(),
        ),
        ("a non-UTF-8 name", executable_with_non_utf8_dylib_name()),
    ] {
        let image = write_image(app_data.path(), &bytes);

        assert!(
            matches!(inspect(&image), Linkage::Undetermined(_)),
            "{label} must be undetermined, got {:?}",
            inspect(&image)
        );
    }
}

/// Dropping an unreadable *run path* is the opposite hazard: it would hide the
/// libraries that path would have found and report them missing.
#[test]
fn a_run_path_that_cannot_be_read_is_never_reported_as_unresolved() {
    let app_data = tempfile::tempdir().unwrap();
    let image = write_image(app_data.path(), &executable_with_unreadable_run_path());

    assert!(
        matches!(inspect(&image), Linkage::Undetermined(_)),
        "got {:?}",
        inspect(&image)
    );
}

/// Since the macOS 15 SDK a weak link can be encoded as flags on an ordinary
/// `LC_LOAD_DYLIB`. Reading only `LC_LOAD_WEAK_DYLIB` would call a binary that
/// launches perfectly well broken — and, because the same verdict drives repair,
/// would then overwrite it.
#[test]
fn a_weak_link_in_the_modern_encoding_is_still_optional() {
    let app_data = tempfile::tempdir().unwrap();
    let image = write_image(
        app_data.path(),
        &executable_with_modern_weak_link("/opt/homebrew/lib/libabsent.dylib"),
    );

    assert_eq!(inspect(&image), Linkage::Resolved);
}

/// `@loader_path` is a token, not a prefix. Expanding `@loader_pathology` would
/// invent a path dyld never looks at, and clear the binary if a file happened to
/// be sitting there.
#[test]
fn a_token_that_merely_starts_like_loader_path_is_not_expanded() {
    let app_data = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(app_data.path().join("ology")).unwrap();
    std::fs::write(app_data.path().join("ology/libpresent.dylib"), b"stand-in").unwrap();
    let image = write_image(
        app_data.path(),
        &executable(&["@loader_pathology/libpresent.dylib"], &[], &[]),
    );

    assert_eq!(
        inspect(&image),
        Linkage::Unresolved(vec!["@loader_pathology/libpresent.dylib".into()])
    );
}

/// `@rpath//lib.dylib` leaves a leading slash. Joining that onto the run path
/// would make the right-hand side absolute, silently throwing the run path away
/// and looking in the filesystem root instead.
#[test]
fn a_doubled_slash_after_rpath_still_resolves_against_the_run_path() {
    let app_data = tempfile::tempdir().unwrap();
    let libraries = app_data.path().join("lib");
    std::fs::create_dir_all(&libraries).unwrap();
    std::fs::write(libraries.join("libwhisper.1.dylib"), b"stand-in").unwrap();
    let image = write_image(
        app_data.path(),
        &executable(
            &["@rpath//libwhisper.1.dylib"],
            &[],
            &[&libraries.to_string_lossy()],
        ),
    );

    assert_eq!(inspect(&image), Linkage::Resolved);
}

/// dyld nulls a weak library's symbols and starts the process anyway, so a
/// missing weak dependency is not a launch failure and must not be reported.
#[test]
fn a_missing_weak_library_is_not_a_launch_failure() {
    let app_data = tempfile::tempdir().unwrap();
    let image = write_image(
        app_data.path(),
        &executable(&[], &["/opt/homebrew/lib/libabsent.dylib"], &[]),
    );

    assert_eq!(inspect(&image), Linkage::Resolved);
}

#[test]
fn loader_path_and_executable_path_resolve_against_the_binarys_own_directory() {
    let app_data = tempfile::tempdir().unwrap();
    let alongside = app_data.path().join("vendor");
    std::fs::create_dir_all(&alongside).unwrap();
    std::fs::write(alongside.join("libpresent.dylib"), b"stand-in").unwrap();
    let present = write_image(
        app_data.path(),
        &executable(
            &[
                "@loader_path/vendor/libpresent.dylib",
                "@executable_path/vendor/libpresent.dylib",
            ],
            &[],
            &[],
        ),
    );

    assert_eq!(inspect(&present), Linkage::Resolved);

    let missing_directory = tempfile::tempdir().unwrap();
    let missing = write_image(
        missing_directory.path(),
        &executable(&["@loader_path/vendor/libabsent.dylib"], &[], &[]),
    );

    assert_eq!(
        inspect(&missing),
        Linkage::Unresolved(vec!["@loader_path/vendor/libabsent.dylib".into()])
    );
}

/// An `@rpath` reference with nothing to expand it against can never resolve.
#[test]
fn an_rpath_reference_without_any_run_path_is_unresolved() {
    let app_data = tempfile::tempdir().unwrap();
    let image = write_image(
        app_data.path(),
        &executable(&["@rpath/libwhisper.1.dylib"], &[], &[]),
    );

    assert_eq!(
        inspect(&image),
        Linkage::Unresolved(vec!["@rpath/libwhisper.1.dylib".into()])
    );
}

/// A Homebrew-style absolute path is neither a system library nor an `@rpath`
/// reference, so it is judged by whether the file is actually there.
#[test]
fn an_absolute_non_system_library_is_judged_by_its_presence() {
    let app_data = tempfile::tempdir().unwrap();
    let vendored = app_data.path().join("libwhisper.dylib");
    std::fs::write(&vendored, b"stand-in").unwrap();

    let present = write_image(
        app_data.path(),
        &executable(&[&vendored.to_string_lossy()], &[], &[]),
    );
    assert_eq!(inspect(&present), Linkage::Resolved);

    std::fs::remove_file(&vendored).unwrap();
    assert!(matches!(inspect(&present), Linkage::Unresolved(_)));
}

/// A library reached through a symbolic link loads; one whose link dangles does
/// not. Checking the link itself rather than its target would clear a binary
/// that cannot start.
#[cfg(unix)]
#[test]
fn a_library_behind_a_symlink_is_judged_by_what_the_link_points_at() {
    use std::os::unix::fs::symlink;

    let app_data = tempfile::tempdir().unwrap();
    let real = app_data.path().join("libreal.dylib");
    std::fs::write(&real, b"stand-in").unwrap();
    symlink(&real, app_data.path().join("liblive.dylib")).unwrap();
    symlink(
        app_data.path().join("libgone.dylib"),
        app_data.path().join("libdangling.dylib"),
    )
    .unwrap();

    let live = write_image(
        app_data.path(),
        &executable(&["@loader_path/liblive.dylib"], &[], &[]),
    );
    assert_eq!(inspect(&live), Linkage::Resolved);

    let dangling = tempfile::tempdir().unwrap();
    symlink(
        dangling.path().join("libgone.dylib"),
        dangling.path().join("libdangling.dylib"),
    )
    .unwrap();
    let broken = write_image(
        dangling.path(),
        &executable(&["@loader_path/libdangling.dylib"], &[], &[]),
    );
    assert_eq!(
        inspect(&broken),
        Linkage::Unresolved(vec!["@loader_path/libdangling.dylib".into()])
    );
}

/// `/usr/local/lib` is a Homebrew prefix, not a shared-cache path, and must not
/// be waved through by a sloppy `/usr/` prefix match.
#[test]
fn a_usr_local_library_is_not_mistaken_for_a_system_one() {
    let app_data = tempfile::tempdir().unwrap();
    let image = write_image(
        app_data.path(),
        &executable(&["/usr/local/lib/libabsent.dylib"], &[], &[]),
    );

    assert_eq!(
        inspect(&image),
        Linkage::Unresolved(vec!["/usr/local/lib/libabsent.dylib".into()])
    );
}

/// A path still relative after expansion would be resolved against whatever
/// working directory the app was launched from. Answering from there is a coin
/// toss, so it is reported as not found — including when a file of that name
/// happens to sit in the test process's own working directory.
#[test]
fn a_relative_library_path_is_not_looked_up_in_the_working_directory() {
    let app_data = tempfile::tempdir().unwrap();
    let decoy = std::env::current_dir().unwrap().join("libdecoy.dylib");
    std::fs::write(&decoy, b"stand-in").unwrap();

    let by_bare_name = write_image(app_data.path(), &executable(&["libdecoy.dylib"], &[], &[]));
    let by_relative_run_path = write_image(
        &{
            let nested = app_data.path().join("nested");
            std::fs::create_dir_all(&nested).unwrap();
            nested
        },
        &executable(&["@rpath/libdecoy.dylib"], &[], &["relative/lib"]),
    );

    let verdicts = [inspect(&by_bare_name), inspect(&by_relative_run_path)];
    std::fs::remove_file(&decoy).unwrap();

    assert_eq!(
        verdicts,
        [
            Linkage::Unresolved(vec!["libdecoy.dylib".into()]),
            Linkage::Unresolved(vec!["@rpath/libdecoy.dylib".into()]),
        ]
    );
}

/// A hand-installed `whisper-cli` can be a universal binary, and only the slice
/// this machine would actually execute decides whether it runs. Judging the
/// wrong slice would condemn a working binary — or clear a broken one.
#[test]
fn a_universal_binary_is_judged_by_the_slice_this_machine_would_run() {
    let app_data = tempfile::tempdir().unwrap();
    let sound = executable_for(HOST_CPU_TYPE, &["/usr/lib/libSystem.B.dylib"], &[], &[]);
    let broken = executable_for(FOREIGN_CPU_TYPE, &["@rpath/libwhisper.1.dylib"], &[], &[]);

    let host_slice_is_sound = write_image(
        app_data.path(),
        &universal(&[(FOREIGN_CPU_TYPE, broken), (HOST_CPU_TYPE, sound)]),
    );
    assert_eq!(inspect(&host_slice_is_sound), Linkage::Resolved);

    let elsewhere = tempfile::tempdir().unwrap();
    let host_slice_is_broken = write_image(
        elsewhere.path(),
        &universal(&[
            (
                FOREIGN_CPU_TYPE,
                executable_for(FOREIGN_CPU_TYPE, &["/usr/lib/libSystem.B.dylib"], &[], &[]),
            ),
            (
                HOST_CPU_TYPE,
                executable_for(HOST_CPU_TYPE, &["@rpath/libwhisper.1.dylib"], &[], &[]),
            ),
        ]),
    );
    assert_eq!(
        inspect(&host_slice_is_broken),
        Linkage::Unresolved(vec!["@rpath/libwhisper.1.dylib".into()])
    );
}

/// Architecture is not a launch verdict: Rosetta 2 runs an x86_64 image on Apple
/// Silicon, and the thin path applies no architecture rule either. Condemning a
/// universal binary for lacking a native slice would contradict that — and under
/// the repair rules a condemned binary is not merely hidden, it is overwritten.
#[test]
fn a_universal_binary_with_no_native_slice_is_still_judged_on_its_libraries() {
    let app_data = tempfile::tempdir().unwrap();
    let sound = write_image(
        app_data.path(),
        &universal(&[(
            FOREIGN_CPU_TYPE,
            executable_for(FOREIGN_CPU_TYPE, SYSTEM_DYLIBS, &[], &[]),
        )]),
    );
    assert_eq!(inspect(&sound), Linkage::Resolved);

    let elsewhere = tempfile::tempdir().unwrap();
    let broken = write_image(
        elsewhere.path(),
        &universal(&[(
            FOREIGN_CPU_TYPE,
            executable_for(FOREIGN_CPU_TYPE, &["@rpath/libwhisper.1.dylib"], &[], &[]),
        )]),
    );
    assert_eq!(
        inspect(&broken),
        Linkage::Unresolved(vec!["@rpath/libwhisper.1.dylib".into()])
    );
}

/// Nothing here may panic or claim a clean bill of health on a file it cannot
/// read. Every one of these is something a user could put in `bin/` by hand.
#[test]
fn malformed_and_foreign_files_are_undetermined_never_resolved() {
    let app_data = tempfile::tempdir().unwrap();
    let sound = executable(&["/usr/lib/libSystem.B.dylib"], &[], &[]);
    let mut absurd_command_count = sound.clone();
    absurd_command_count[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
    let mut string_runs_off_the_end = sound.clone();
    let last = string_runs_off_the_end.len();
    string_runs_off_the_end.truncate(last - 8);

    for (label, bytes) in [
        ("empty", Vec::new()),
        ("not a Mach-O", b"fixture".to_vec()),
        (
            "a shell script",
            b"#!/bin/sh\nexec whisper \"$@\"\n".to_vec(),
        ),
        ("a truncated header", sound[..12].to_vec()),
        ("an absurd command count", absurd_command_count),
        ("a string past the end", string_runs_off_the_end),
    ] {
        let image = write_image(app_data.path(), &bytes);
        assert!(
            matches!(inspect(&image), Linkage::Undetermined(_)),
            "{label} must be undetermined, got {:?}",
            inspect(&image)
        );
    }
}

/// A foreign *executable* format parses far enough to be identified, and has to
/// be reported as unjudgeable rather than waved through for lack of Mach-O
/// dependencies to complain about.
#[test]
fn an_executable_in_another_format_is_undetermined() {
    let app_data = tempfile::tempdir().unwrap();
    let mut elf = b"\x7fELF\x02\x01\x01\x00".to_vec();
    elf.resize(128, 0);
    let image = write_image(app_data.path(), &elf);

    assert!(
        matches!(inspect(&image), Linkage::Undetermined(_)),
        "got {:?}",
        inspect(&image)
    );
}

/// `object` reads a universal binary's selected slice whole and a fat header
/// carries an attacker-chosen 64-bit size, so an unbounded read is an
/// out-of-memory abort waiting to happen. The ceiling is checked before any
/// parse. The fixture is sparse, so it costs no disk.
#[test]
fn a_file_beyond_the_size_ceiling_is_refused_before_it_is_parsed() {
    let app_data = tempfile::tempdir().unwrap();
    let path = app_data.path().join("whisper-cli");
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(super::MAX_INSPECTED_BYTES + 1).unwrap();
    drop(file);

    let Linkage::Undetermined(reason) = inspect(&path) else {
        panic!("an oversized file must not be judged");
    };
    assert!(reason.contains("too large"), "got {reason}");
}

/// A path with no parent has no directory to expand `@loader_path` against.
#[test]
fn a_path_with_no_parent_directory_is_undetermined() {
    assert!(matches!(inspect(Path::new("/")), Linkage::Undetermined(_)));
}

#[test]
fn a_file_that_is_not_there_is_undetermined() {
    let app_data = tempfile::tempdir().unwrap();

    assert!(matches!(
        inspect(&app_data.path().join("whisper-cli")),
        Linkage::Undetermined(_)
    ));
}
