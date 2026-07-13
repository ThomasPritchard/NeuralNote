use super::*;
use neuralnote_core::ai::{PullEvent, RequirementBinary, RequirementInstallKind};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[derive(Default)]
struct RecordingSink {
    events: Vec<PullEvent>,
}

#[test]
fn locally_built_executable_publishes_atomically_with_executable_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("built-whisper");
    std::fs::write(&source, b"local build").unwrap();

    publish_built_executable(dir.path(), "whisper-cli", &source).unwrap();

    let installed = dir.path().join("bin/whisper-cli");
    assert_eq!(std::fs::read(&installed).unwrap(), b"local build");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_ne!(
            installed.metadata().unwrap().permissions().mode() & 0o111,
            0
        );
    }
    assert!(!dir.path().join("bin/whisper-cli.part").exists());
}

impl neuralnote_core::ai::PullSink for RecordingSink {
    fn send(&mut self, event: PullEvent) {
        self.events.push(event);
    }
}

fn fixture_requirement(
    name: &'static str,
    checksum: &'static str,
    install_kind: RequirementInstallKind,
) -> RequirementBinary {
    RequirementBinary {
        name,
        url: "https://example.invalid/fixture-tool",
        sha256: checksum,
        install_kind,
    }
}

fn fixture_binary(checksum: &'static str) -> RequirementBinary {
    fixture_requirement("fixture-tool", checksum, RequirementInstallKind::Executable)
}

#[test]
fn installer_streams_progress_and_publishes_an_executable() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let mut sink = RecordingSink::default();
    let requirement =
        fixture_binary("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    let mut installer = RequirementInstaller::begin(
        dir.path(),
        requirement.name,
        requirement.install_kind,
        Some(3),
    )
    .unwrap();

    installer.write_chunk(b"abc", &cancel, &mut sink).unwrap();
    installer.finish(&requirement).unwrap();

    let installed = dir.path().join("bin/fixture-tool");
    assert_eq!(std::fs::read(&installed).unwrap(), b"abc");
    assert!(!dir.path().join("bin/fixture-tool.part").exists());
    assert!(matches!(
        sink.events.as_slice(),
        [PullEvent::Progress {
            completed: Some(3),
            total: Some(3),
            percent: Some(100),
            ..
        }]
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(installed).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}

#[test]
fn installer_publishes_an_asset_in_assets_without_executable_bits() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let mut sink = RecordingSink::default();
    let requirement = fixture_requirement(
        "fixture-asset",
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        RequirementInstallKind::Asset,
    );
    let mut installer = RequirementInstaller::begin(
        dir.path(),
        requirement.name,
        requirement.install_kind,
        Some(3),
    )
    .unwrap();

    installer.write_chunk(b"abc", &cancel, &mut sink).unwrap();
    installer.finish(&requirement).unwrap();

    let installed = dir.path().join("assets/fixture-asset");
    assert_eq!(std::fs::read(&installed).unwrap(), b"abc");
    assert!(!dir.path().join("assets/fixture-asset.part").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(installed).unwrap().permissions().mode() & 0o111,
            0
        );
    }
}

#[test]
fn checksum_mismatch_removes_the_partial_and_refuses_the_final_file() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let mut sink = RecordingSink::default();
    let requirement =
        fixture_binary("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    let mut installer =
        RequirementInstaller::begin(dir.path(), requirement.name, requirement.install_kind, None)
            .unwrap();
    installer.write_chunk(b"abc", &cancel, &mut sink).unwrap();

    let result = installer.finish(&requirement);

    assert!(matches!(
        result,
        Err(CoreError::Io(message)) if message == "checksum mismatch"
    ));
    assert!(!dir.path().join("bin/fixture-tool.part").exists());
    assert!(!dir.path().join("bin/fixture-tool").exists());
}

#[test]
fn cancellation_is_checked_before_each_chunk_and_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(true);
    let mut sink = RecordingSink::default();
    let mut installer = RequirementInstaller::begin(
        dir.path(),
        "fixture-tool",
        RequirementInstallKind::Executable,
        None,
    )
    .unwrap();

    let result = installer.write_chunk(b"ignored", &cancel, &mut sink);
    drop(installer);

    assert!(matches!(
        result,
        Err(CoreError::Io(message)) if message == "Download cancelled."
    ));
    assert!(sink.events.is_empty());
    assert!(!dir.path().join("bin/fixture-tool.part").exists());
}

#[test]
fn beginning_a_retry_replaces_only_a_stale_partial() {
    let dir = tempfile::tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    std::fs::write(bin_dir.join("fixture-tool.part"), b"stale").unwrap();
    std::fs::write(bin_dir.join("fixture-tool"), b"installed").unwrap();

    let installer = RequirementInstaller::begin(
        dir.path(),
        "fixture-tool",
        RequirementInstallKind::Executable,
        None,
    )
    .unwrap();

    assert_eq!(
        std::fs::read(bin_dir.join("fixture-tool")).unwrap(),
        b"installed"
    );
    assert_eq!(
        std::fs::read(bin_dir.join("fixture-tool.part")).unwrap(),
        b""
    );
    drop(installer);
    assert!(!bin_dir.join("fixture-tool.part").exists());
}

#[test]
fn advisory_lock_blocks_a_second_installer_and_is_retained_for_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let first = RequirementInstaller::begin(
        dir.path(),
        "fixture-tool",
        RequirementInstallKind::Executable,
        None,
    )
    .unwrap();

    let second = RequirementInstaller::begin(
        dir.path(),
        "fixture-tool",
        RequirementInstallKind::Executable,
        None,
    );

    assert!(matches!(second, Err(CoreError::Conflict(_))));
    assert!(dir.path().join("bin/fixture-tool.part").exists());
    drop(first);

    let retry = RequirementInstaller::begin(
        dir.path(),
        "fixture-tool",
        RequirementInstallKind::Executable,
        None,
    )
    .unwrap();
    drop(retry);
    assert!(dir.path().join("bin/fixture-tool.lock").exists());
}

#[test]
fn asset_and_executable_downloads_have_distinct_documented_ceilings() {
    assert_eq!(MAX_REQUIREMENT_EXECUTABLE_BYTES, 512 * 1024 * 1024);
    assert_eq!(MAX_REQUIREMENT_ASSET_BYTES, 1024 * 1024 * 1024);

    let dir = tempfile::tempdir().unwrap();
    let above_executable_limit = MAX_REQUIREMENT_EXECUTABLE_BYTES + 1;
    let executable = RequirementInstaller::begin(
        dir.path(),
        "fixture-executable",
        RequirementInstallKind::Executable,
        Some(above_executable_limit),
    );
    assert!(matches!(executable, Err(CoreError::Io(_))));

    let asset = RequirementInstaller::begin(
        dir.path(),
        "fixture-asset",
        RequirementInstallKind::Asset,
        Some(above_executable_limit),
    );
    assert!(asset.is_ok());
}

#[test]
fn streamed_bytes_cannot_cross_the_kind_specific_limit() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let mut sink = RecordingSink::default();
    let mut installer = RequirementInstaller::begin(
        dir.path(),
        "fixture-asset",
        RequirementInstallKind::Asset,
        None,
    )
    .unwrap();
    installer.completed = MAX_REQUIREMENT_ASSET_BYTES;

    let result = installer.write_chunk(b"x", &cancel, &mut sink);

    assert!(matches!(
        result,
        Err(CoreError::Io(message)) if message.contains("safety limit")
    ));
    assert!(!dir.path().join("assets/fixture-asset.part").exists());
}

#[tokio::test]
async fn stream_installer_consumes_all_chunks_without_emitting_a_terminal_event() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let mut sink = RecordingSink::default();
    let requirement =
        fixture_binary("bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721");
    let chunks = futures_util::stream::iter([
        Ok::<_, std::io::Error>(b"abc".to_vec()),
        Ok(b"def".to_vec()),
    ]);

    install_requirement_stream(
        dir.path(),
        &requirement,
        Some(6),
        chunks,
        &mut sink,
        &cancel,
    )
    .await
    .unwrap();

    assert_eq!(
        std::fs::read(dir.path().join("bin/fixture-tool")).unwrap(),
        b"abcdef"
    );
    assert_eq!(sink.events.len(), 2);
    assert!(sink
        .events
        .iter()
        .all(|event| matches!(event, PullEvent::Progress { .. })));
}

#[tokio::test]
async fn stream_error_is_explicit_and_removes_the_partial() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let mut sink = RecordingSink::default();
    let requirement =
        fixture_binary("0000000000000000000000000000000000000000000000000000000000000000");
    let chunks = futures_util::stream::iter([
        Ok::<_, std::io::Error>(b"partial".to_vec()),
        Err(std::io::Error::other("connection cut")),
    ]);

    let result =
        install_requirement_stream(dir.path(), &requirement, None, chunks, &mut sink, &cancel)
            .await;

    assert!(matches!(
        result,
        Err(CoreError::Io(message))
            if message.contains("stream failed") && message.contains("connection cut")
    ));
    assert!(!dir.path().join("bin/fixture-tool.part").exists());
    assert!(!dir.path().join("bin/fixture-tool").exists());
}

#[tokio::test]
async fn stalled_stream_observes_in_flight_cancellation_and_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let trigger = Arc::clone(&cancel);
    let mut sink = RecordingSink::default();
    let requirement =
        fixture_binary("0000000000000000000000000000000000000000000000000000000000000000");
    let stream = futures_util::stream::pending::<Result<Vec<u8>, std::io::Error>>();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        trigger.store(true, Ordering::SeqCst);
    });

    let result = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        install_requirement_stream(
            dir.path(),
            &requirement,
            None,
            stream,
            &mut sink,
            cancel.as_ref(),
        ),
    )
    .await
    .expect("stalled stream should stop promptly after cancellation");

    assert!(matches!(
        result,
        Err(CoreError::Io(message)) if message == "Download cancelled."
    ));
    assert!(!dir.path().join("bin/fixture-tool.part").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn asset_publication_strips_quarantine() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let dir = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let mut sink = RecordingSink::default();
    let requirement = fixture_requirement(
        "fixture-asset",
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        RequirementInstallKind::Asset,
    );
    let mut installer = RequirementInstaller::begin(
        dir.path(),
        requirement.name,
        requirement.install_kind,
        Some(3),
    )
    .unwrap();
    installer.write_chunk(b"abc", &cancel, &mut sink).unwrap();
    let part_path = CString::new(installer.part_path.as_os_str().as_bytes()).unwrap();
    let name = c"com.apple.quarantine";
    let value = b"0083;fixture;NeuralNote;";
    // SAFETY: pointers and lengths refer to live byte buffers for this call only.
    assert_eq!(
        unsafe {
            libc::setxattr(
                part_path.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        },
        0
    );

    installer.finish(&requirement).unwrap();

    let installed = dir.path().join("assets/fixture-asset");
    let installed = CString::new(installed.as_os_str().as_bytes()).unwrap();
    assert_eq!(
        unsafe {
            libc::getxattr(
                installed.as_ptr(),
                name.as_ptr(),
                std::ptr::null_mut(),
                0,
                0,
                0,
            )
        },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ENOATTR)
    );
}
