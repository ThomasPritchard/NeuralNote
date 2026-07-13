//! Crash-safe installation policy for compiled-in skill requirement files.
//!
//! Transport supplies an authorised byte stream. This module owns destination
//! selection, byte ceilings, integrity verification, publication, permissions,
//! quarantine removal, and the cross-process lock around each stable `.part` file.

use super::requirement_install_lock::AdvisoryInstallLock;
use neuralnote_core::ai::{
    validate_requirement_binary_name, verify_requirement_checksum, PullEvent, PullSink,
    RequirementBinary, RequirementInstallKind,
};
use neuralnote_core::{CoreError, CoreResult};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Executable helpers are capped at 512 MiB. Current binaries are much smaller;
/// this leaves headroom for standalone release formats while bounding bad streams.
const MAX_REQUIREMENT_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;
/// Inert assets are capped separately at 1 GiB so the pinned ~466 MiB Whisper
/// model fits without granting executable downloads the same larger allowance.
const MAX_REQUIREMENT_ASSET_BYTES: u64 = 1024 * 1024 * 1024;
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Resolve when a requirement download is cancelled. The bounded poll converts
/// the shared atomic token into an async branch that can interrupt stalled I/O.
pub(crate) async fn wait_for_requirement_cancellation(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(CANCELLATION_POLL_INTERVAL).await;
    }
}

/// Consume an already-authorised response body. Kept separate from reqwest so
/// cancellation, chunk errors, progress, checksum publication, and `.part`
/// cleanup are exercised without a network server or a Tauri runtime.
pub(crate) async fn install_requirement_stream<S, B, E>(
    app_data_dir: &Path,
    requirement: &RequirementBinary,
    total: Option<u64>,
    stream: S,
    sink: &mut dyn PullSink,
    cancel: &AtomicBool,
) -> CoreResult<()>
where
    S: futures_util::Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    use futures_util::StreamExt;

    let mut installer = RequirementInstaller::begin(
        app_data_dir,
        requirement.name,
        requirement.install_kind,
        total,
    )?;
    futures_util::pin_mut!(stream);
    loop {
        let next = tokio::select! {
            biased;
            () = wait_for_requirement_cancellation(cancel) => {
                return Err(installer.fail_and_cleanup("Download cancelled.".into()));
            }
            next = stream.next() => next,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                return Err(installer
                    .fail_and_cleanup(format!("requirement download stream failed: {error}")))
            }
        };
        installer.write_chunk(chunk.as_ref(), cancel, sink)?;
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(installer.fail_and_cleanup("Download cancelled.".into()));
    }
    installer.finish(requirement)
}

/// One in-progress requirement file. Until `finish` verifies and publishes it,
/// Drop removes the `.part` file so every early error leaves no install-looking
/// partial behind. The retained lock handle prevents a second app process from
/// unlinking that stable `.part` name while this installer owns it.
struct RequirementInstaller {
    name: String,
    install_kind: RequirementInstallKind,
    max_bytes: u64,
    part_path: PathBuf,
    final_path: PathBuf,
    _install_lock: AdvisoryInstallLock,
    file: Option<File>,
    hasher: Sha256,
    completed: u64,
    total: Option<u64>,
    published: bool,
}

impl RequirementInstaller {
    fn begin(
        app_data_dir: &Path,
        name: &str,
        install_kind: RequirementInstallKind,
        total: Option<u64>,
    ) -> CoreResult<Self> {
        validate_requirement_binary_name(name)?;
        let max_bytes = max_requirement_bytes(install_kind);
        if total.is_some_and(|bytes| bytes > max_bytes) {
            return Err(requirement_size_limit_error(install_kind));
        }
        let install_dir = app_data_dir.join(install_directory_name(install_kind));
        std::fs::create_dir_all(&install_dir).map_err(|error| {
            CoreError::Io(format!(
                "could not create skill requirement directory '{}': {error}",
                install_dir.display()
            ))
        })?;
        let install_lock = AdvisoryInstallLock::acquire(&install_dir, name)?;
        let part_path = install_dir.join(format!("{name}.part"));
        let final_path = install_dir.join(name);
        remove_if_exists(&part_path).map_err(|error| {
            CoreError::Io(format!(
                "could not remove stale requirement download '{}': {error}",
                part_path.display()
            ))
        })?;

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(&part_path).map_err(|error| {
            CoreError::Io(format!(
                "could not create requirement download '{}': {error}",
                part_path.display()
            ))
        })?;

        Ok(Self {
            name: name.to_string(),
            install_kind,
            max_bytes,
            part_path,
            final_path,
            _install_lock: install_lock,
            file: Some(file),
            hasher: Sha256::new(),
            completed: 0,
            total,
            published: false,
        })
    }

    fn write_chunk(
        &mut self,
        chunk: &[u8],
        cancel: &AtomicBool,
        sink: &mut dyn PullSink,
    ) -> CoreResult<()> {
        if cancel.load(Ordering::SeqCst) {
            return Err(self.fail_and_cleanup("Download cancelled.".into()));
        }
        let next_completed = match self.completed.checked_add(chunk.len() as u64) {
            Some(bytes) if bytes <= self.max_bytes => bytes,
            Some(_) => {
                let error = requirement_size_limit_error(self.install_kind);
                return Err(self.fail_and_cleanup(crate::ai::error_detail(error)));
            }
            None => {
                return Err(
                    self.fail_and_cleanup("requirement download byte count overflowed".into())
                )
            }
        };
        let Some(file) = self.file.as_mut() else {
            return Err(CoreError::Io(
                "requirement download is no longer writable".into(),
            ));
        };
        if let Err(error) = file.write_all(chunk) {
            return Err(
                self.fail_and_cleanup(format!("requirement download write failed: {error}"))
            );
        }
        self.hasher.update(chunk);
        self.completed = next_completed;
        let percent = self.total.and_then(|total| {
            (total > 0).then(|| ((self.completed.saturating_mul(100)) / total).min(100) as u8)
        });
        sink.send(PullEvent::Progress {
            status: format!("Downloading {}", self.name),
            digest: None,
            completed: Some(self.completed),
            total: self.total,
            percent,
        });
        Ok(())
    }

    fn finish(mut self, requirement: &RequirementBinary) -> CoreResult<()> {
        if let Some(file) = self.file.as_mut() {
            if let Err(error) = file.sync_all() {
                return Err(
                    self.fail_and_cleanup(format!("requirement download sync failed: {error}"))
                );
            }
        }
        let actual_sha256 = format!("{:x}", std::mem::take(&mut self.hasher).finalize());
        if let Err(error) = verify_requirement_checksum(requirement.sha256, &actual_sha256) {
            return Err(self.fail_and_cleanup(crate::ai::error_detail(error)));
        }
        self.file.take();
        if self.install_kind == RequirementInstallKind::Executable {
            if let Err(error) = make_executable(&self.part_path) {
                return Err(self.fail_and_cleanup(error.to_string()));
            }
        }
        if let Err(error) = remove_macos_quarantine(&self.part_path) {
            return Err(self.fail_and_cleanup(error.to_string()));
        }
        if let Err(error) = std::fs::rename(&self.part_path, &self.final_path) {
            return Err(self.fail_and_cleanup(format!(
                "could not publish requirement file '{}': {error}",
                self.final_path.display()
            )));
        }
        self.published = true;
        Ok(())
    }

    fn fail_and_cleanup(&mut self, message: String) -> CoreError {
        self.file.take();
        match remove_if_exists(&self.part_path) {
            Ok(()) => CoreError::Io(message),
            Err(cleanup) => CoreError::Io(format!(
                "{message}; could not remove partial '{}': {cleanup}",
                self.part_path.display()
            )),
        }
    }

    fn cleanup_partial(&mut self) {
        self.file.take();
        if let Err(error) = remove_if_exists(&self.part_path) {
            log::warn!(
                "could not remove partial requirement download '{}': {error}",
                self.part_path.display()
            );
        }
    }
}

impl Drop for RequirementInstaller {
    fn drop(&mut self) {
        if !self.published {
            self.cleanup_partial();
        }
    }
}

fn install_directory_name(install_kind: RequirementInstallKind) -> &'static str {
    match install_kind {
        RequirementInstallKind::Executable => "bin",
        RequirementInstallKind::Asset => "assets",
    }
}

fn max_requirement_bytes(install_kind: RequirementInstallKind) -> u64 {
    match install_kind {
        RequirementInstallKind::Executable => MAX_REQUIREMENT_EXECUTABLE_BYTES,
        RequirementInstallKind::Asset => MAX_REQUIREMENT_ASSET_BYTES,
    }
}

fn requirement_size_limit_error(install_kind: RequirementInstallKind) -> CoreError {
    let kind = match install_kind {
        RequirementInstallKind::Executable => "executable",
        RequirementInstallKind::Asset => "asset",
    };
    CoreError::Io(format!(
        "requirement {kind} download exceeds the {}-byte safety limit",
        max_requirement_bytes(install_kind)
    ))
}

/// Publish a locally compiled executable through the same locked `.part` and
/// quarantine-removal discipline as downloaded executables. The caller must
/// validate that `source` is the expected output beneath its private build root.
pub(crate) fn publish_built_executable(
    app_data_dir: &Path,
    name: &str,
    source: &Path,
) -> CoreResult<()> {
    validate_requirement_binary_name(name)?;
    let metadata = source
        .symlink_metadata()
        .map_err(|error| CoreError::Io(format!("locally built executable is missing: {error}")))?;
    if !metadata.file_type().is_file() {
        return Err(CoreError::Io(
            "locally built executable is not a regular file".into(),
        ));
    }
    let install_dir = app_data_dir.join("bin");
    std::fs::create_dir_all(&install_dir).map_err(|error| {
        CoreError::Io(format!(
            "could not create requirement bin directory: {error}"
        ))
    })?;
    let _lock = AdvisoryInstallLock::acquire(&install_dir, name)?;
    let final_path = install_dir.join(name);
    if final_path.symlink_metadata().is_ok() {
        return Err(CoreError::Conflict(format!(
            "requirement executable '{name}' is already installed"
        )));
    }
    let part_path = install_dir.join(format!("{name}.part"));
    remove_if_exists(&part_path).map_err(|error| {
        CoreError::Io(format!("could not clear stale built executable: {error}"))
    })?;
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut target = options.open(&part_path).map_err(|error| {
            CoreError::Io(format!("could not stage locally built executable: {error}"))
        })?;
        let mut input = File::open(source).map_err(|error| {
            CoreError::Io(format!("could not read locally built executable: {error}"))
        })?;
        std::io::copy(&mut input, &mut target).map_err(|error| {
            CoreError::Io(format!("could not copy locally built executable: {error}"))
        })?;
        target.sync_all().map_err(|error| {
            CoreError::Io(format!("could not sync locally built executable: {error}"))
        })?;
        drop(target);
        make_executable(&part_path)?;
        remove_macos_quarantine(&part_path)?;
        std::fs::rename(&part_path, &final_path).map_err(|error| {
            CoreError::Io(format!(
                "could not publish locally built executable: {error}"
            ))
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = remove_if_exists(&part_path);
    }
    result
}

fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn make_executable(path: &Path) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|error| {
        CoreError::Io(format!(
            "could not make requirement file '{}' executable: {error}",
            path.display()
        ))
    })
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> CoreResult<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn remove_macos_quarantine(path: &Path) -> CoreResult<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| CoreError::Io("requirement file path contains a NUL byte".into()))?;
    let name = c"com.apple.quarantine";
    // SAFETY: both arguments are live NUL-terminated strings. `removexattr` does
    // not retain them after this call.
    if unsafe { libc::removexattr(path.as_ptr(), name.as_ptr(), 0) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOATTR) {
        Ok(())
    } else {
        Err(CoreError::Io(format!(
            "could not remove quarantine from requirement file: {error}"
        )))
    }
}

#[cfg(not(target_os = "macos"))]
fn remove_macos_quarantine(_path: &Path) -> CoreResult<()> {
    Ok(())
}

#[cfg(test)]
#[path = "requirement_installer_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "requirement_installer_lock_tests.rs"]
mod lock_tests;
