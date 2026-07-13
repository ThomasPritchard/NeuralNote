//! Pinned source-build installer for native skill requirements.

use crate::youtube::process::{EnvironmentPolicy, ProcessRunner, ProcessSpec, TokioProcessRunner};
use flate2::read::GzDecoder;
use futures_util::StreamExt as _;
use neuralnote_core::ai::{
    verify_requirement_checksum, CaptureCancellation, PullEvent, PullSink, RequirementSourceBuild,
};
use neuralnote_core::{CoreError, CoreResult};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

const MAX_SOURCE_ENTRIES: usize = 20_000;
const MAX_UNPACKED_SOURCE_BYTES: u64 = 256 * 1024 * 1024;
const BUILD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const BUILD_OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const MAX_SOURCE_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

fn source_error(message: impl Into<String>) -> CoreError {
    CoreError::Io(format!(
        "could not install whisper-cli from source: {}",
        message.into()
    ))
}

pub(super) fn validate_source_entry(
    path: &Path,
    entry_type: tar::EntryType,
    recipe: &RequirementSourceBuild,
) -> CoreResult<()> {
    let mut components = path.components();
    match components.next() {
        Some(Component::Normal(root)) if root == recipe.archive_root => {}
        _ => {
            return Err(source_error(
                "source archive has an unexpected root or unsafe path",
            ))
        }
    }
    if components.any(|component| !matches!(component, Component::Normal(_))) {
        return Err(source_error("source archive contains path navigation"));
    }
    if !(entry_type.is_file() || entry_type.is_dir()) {
        return Err(source_error(
            "source archive contains a link or unsupported filesystem entry",
        ));
    }
    Ok(())
}

pub(super) fn extract_source_archive(
    bytes: &[u8],
    staging: &Path,
    recipe: &RequirementSourceBuild,
) -> CoreResult<PathBuf> {
    if !staging.is_absolute() {
        return Err(source_error("source staging directory must be absolute"));
    }
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    archive.set_preserve_permissions(false);
    archive.set_preserve_ownerships(false);
    archive.set_overwrite(false);
    let entries = archive
        .entries()
        .map_err(|error| source_error(format!("source archive is invalid: {error}")))?;
    let mut count = 0usize;
    let mut unpacked = 0u64;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| source_error(format!("source entry is invalid: {error}")))?;
        count = count
            .checked_add(1)
            .ok_or_else(|| source_error("source entry count overflowed"))?;
        if count > MAX_SOURCE_ENTRIES {
            return Err(source_error("source archive contains too many entries"));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .ok_or_else(|| source_error("source archive size overflowed"))?;
        if unpacked > MAX_UNPACKED_SOURCE_BYTES {
            return Err(source_error(
                "source archive expands beyond the safety limit",
            ));
        }
        let path = entry
            .path()
            .map_err(|error| source_error(format!("source path is invalid: {error}")))?;
        validate_source_entry(&path, entry.header().entry_type(), recipe)?;
        if !entry
            .unpack_in(staging)
            .map_err(|error| source_error(format!("could not extract source: {error}")))?
        {
            return Err(source_error("source entry escaped its staging directory"));
        }
    }
    if count == 0 {
        return Err(source_error("source archive is empty"));
    }
    let root = staging.join(recipe.archive_root);
    let metadata = root
        .symlink_metadata()
        .map_err(|error| source_error(format!("expected source root is missing: {error}")))?;
    if !metadata.file_type().is_dir() {
        return Err(source_error("expected source root is not a directory"));
    }
    Ok(root)
}

pub(super) fn whisper_build_specs(
    cmake: &Path,
    staging: &Path,
    source: &Path,
) -> CoreResult<[ProcessSpec; 2]> {
    if !cmake.is_absolute() || !staging.is_absolute() || !source.is_absolute() {
        return Err(source_error(
            "build tool and staging paths must be absolute",
        ));
    }
    let build = source.join("build");
    let environment = EnvironmentPolicy::ClearAndSet(BTreeMap::from([
        (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
        (
            OsString::from("HOME"),
            staging.join("home").into_os_string(),
        ),
        (
            OsString::from("TMPDIR"),
            staging.join("tmp").into_os_string(),
        ),
    ]));
    let common = |args: Vec<OsString>| ProcessSpec {
        program: cmake.to_path_buf(),
        args,
        cwd: Some(source.to_path_buf()),
        environment: environment.clone(),
        timeout: BUILD_TIMEOUT,
        stdout_limit: BUILD_OUTPUT_LIMIT,
        stderr_limit: BUILD_OUTPUT_LIMIT,
    };
    Ok([
        common(vec![
            "-S".into(),
            source.as_os_str().to_owned(),
            "-B".into(),
            build.as_os_str().to_owned(),
            "-DCMAKE_BUILD_TYPE=Release".into(),
        ]),
        common(vec![
            "--build".into(),
            build.into_os_string(),
            "--config".into(),
            "Release".into(),
            "--parallel".into(),
            "2".into(),
        ]),
    ])
}

pub(super) struct StagingDir(PathBuf);

impl Drop for StagingDir {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("could not remove Whisper source staging directory: {error}");
            }
        }
    }
}

pub(super) fn create_private_staging(app_data_dir: &Path) -> CoreResult<StagingDir> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let parent = app_data_dir.join("build");
    match std::fs::create_dir(&parent) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(source_error(format!(
                "could not create build directory: {error}"
            )))
        }
    }
    let parent_metadata = parent
        .symlink_metadata()
        .map_err(|error| source_error(format!("could not inspect build directory: {error}")))?;
    if !parent_metadata.file_type().is_dir() {
        return Err(source_error(
            "build directory is not an owned regular directory",
        ));
    }
    let canonical_app_data = app_data_dir
        .canonicalize()
        .map_err(|error| source_error(format!("could not resolve app-data directory: {error}")))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| source_error(format!("could not resolve build directory: {error}")))?;
    if canonical_parent.parent() != Some(canonical_app_data.as_path())
        || canonical_parent.file_name().and_then(|name| name.to_str()) != Some("build")
    {
        return Err(source_error("build directory escaped app-data"));
    }
    for _ in 0..32 {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!("whisper-{}-{id}", std::process::id()));
        match std::fs::create_dir(&path) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt as _;
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                        .map_err(|error| {
                            source_error(format!("could not secure build directory: {error}"))
                        })?;
                }
                std::fs::create_dir(path.join("home"))
                    .and_then(|()| std::fs::create_dir(path.join("tmp")))
                    .map_err(|error| {
                        source_error(format!("could not prepare build sandbox: {error}"))
                    })?;
                let canonical_path = path.canonicalize().map_err(|error| {
                    source_error(format!("could not resolve build staging: {error}"))
                })?;
                if !canonical_path.starts_with(&canonical_parent) {
                    return Err(source_error("build staging escaped app-data"));
                }
                return Ok(StagingDir(canonical_path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(source_error(format!(
                    "could not create build staging: {error}"
                )))
            }
        }
    }
    Err(source_error(
        "could not allocate a unique build staging directory",
    ))
}

fn tool_check_spec(program: &Path, args: &[&str], staging: &Path) -> ProcessSpec {
    ProcessSpec {
        program: program.to_path_buf(),
        args: args.iter().map(OsString::from).collect(),
        cwd: Some(staging.to_path_buf()),
        environment: EnvironmentPolicy::ClearAndSet(BTreeMap::from([
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
            (
                OsString::from("HOME"),
                staging.join("home").into_os_string(),
            ),
            (
                OsString::from("TMPDIR"),
                staging.join("tmp").into_os_string(),
            ),
        ])),
        timeout: Duration::from_secs(20),
        stdout_limit: 64 * 1024,
        stderr_limit: 64 * 1024,
    }
}

fn find_cmake() -> CoreResult<PathBuf> {
    const CANDIDATES: &[&str] = &[
        "/opt/homebrew/bin/cmake",
        "/usr/local/bin/cmake",
        "/Applications/CMake.app/Contents/bin/cmake",
        "/usr/bin/cmake",
    ];
    for candidate in CANDIDATES {
        let candidate = Path::new(candidate);
        let Ok(resolved) = candidate.canonicalize() else {
            continue;
        };
        let allowed = [
            Path::new("/opt/homebrew"),
            Path::new("/usr/local"),
            Path::new("/Applications/CMake.app"),
            Path::new("/usr/bin"),
        ]
        .iter()
        .any(|root| resolved.starts_with(root));
        if allowed && resolved.metadata().is_ok_and(|metadata| metadata.is_file()) {
            return Ok(resolved);
        }
    }
    Err(source_error(
        "CMake 3.28 or newer is required. Install it from cmake.org or with your package manager, then retry.",
    ))
}

fn parse_cmake_version(stdout: &[u8]) -> CoreResult<()> {
    let text = String::from_utf8_lossy(stdout);
    let version = text
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("cmake version "))
        .ok_or_else(|| source_error("CMake did not report its version"))?;
    let mut parts = version.split('.');
    let major = parts.next().and_then(|part| part.parse::<u32>().ok());
    let minor = parts.next().and_then(|part| part.parse::<u32>().ok());
    if !matches!((major, minor), (Some(major), Some(minor)) if major > 3 || (major == 3 && minor >= 28))
    {
        return Err(source_error(format!(
            "CMake 3.28 or newer is required; found {version}"
        )));
    }
    Ok(())
}

async fn preflight_build_tools(
    staging: &Path,
    cancellation: &CaptureCancellation,
) -> CoreResult<PathBuf> {
    let runner = TokioProcessRunner;
    let xcrun = tool_check_spec(Path::new("/usr/bin/xcrun"), &["--find", "clang"], staging);
    let output = runner.run(&xcrun, cancellation).await.map_err(|error| {
        source_error(format!("Xcode Command Line Tools are required. Run `xcode-select --install`, then retry ({error})"))
    })?;
    if !output.status.success() {
        return Err(source_error(
            "Xcode Command Line Tools are required. Run `xcode-select --install`, then retry.",
        ));
    }
    let cmake = find_cmake()?;
    let output = runner
        .run(
            &tool_check_spec(&cmake, &["--version"], staging),
            cancellation,
        )
        .await
        .map_err(|error| source_error(format!("could not check CMake: {error}")))?;
    if !output.status.success() {
        return Err(source_error("CMake version check failed"));
    }
    parse_cmake_version(&output.stdout)?;
    Ok(cmake)
}

async fn download_source_archive(
    recipe: &RequirementSourceBuild,
    sink: &mut dyn PullSink,
    cancellation: &CaptureCancellation,
) -> CoreResult<Vec<u8>> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| source_error(format!("could not create source client: {error}")))?;
    let request = client.get(recipe.archive_url).send();
    let response = tokio::select! {
        biased;
        () = wait_for_capture_cancellation(cancellation) => {
            return Err(source_error("source build was cancelled"));
        }
        response = request => response
            .map_err(|error| source_error(format!("could not download pinned source: {error}")))?,
    };
    if !response.status().is_success() {
        return Err(source_error(format!(
            "source download returned HTTP {}",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_SOURCE_ARCHIVE_BYTES)
    {
        return Err(source_error(
            "source archive exceeds the download safety limit",
        ));
    }
    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    let mut hasher = Sha256::new();
    loop {
        let next = tokio::select! {
            biased;
            () = wait_for_capture_cancellation(cancellation) => {
                return Err(source_error("source build was cancelled"));
            }
            next = stream.next() => next,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk =
            chunk.map_err(|error| source_error(format!("source stream failed: {error}")))?;
        let next = (bytes.len() as u64)
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| source_error("source archive byte count overflowed"))?;
        if next > MAX_SOURCE_ARCHIVE_BYTES {
            return Err(source_error(
                "source archive exceeds the download safety limit",
            ));
        }
        hasher.update(&chunk);
        bytes.extend_from_slice(&chunk);
        sink.send(PullEvent::Progress {
            status: "Downloading pinned whisper.cpp v1.9.1 source".into(),
            digest: None,
            completed: Some(next),
            total,
            percent: total
                .filter(|total| *total > 0)
                .map(|total| ((next.saturating_mul(100) / total).min(100)) as u8),
        });
    }
    let actual = format!("{:x}", hasher.finalize());
    verify_requirement_checksum(recipe.archive_sha256, &actual)?;
    Ok(bytes)
}

async fn wait_for_capture_cancellation(cancellation: &CaptureCancellation) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(crate) async fn install_whisper_from_source(
    app_data_dir: &Path,
    recipe: RequirementSourceBuild,
    sink: &mut dyn PullSink,
    cancellation: &CaptureCancellation,
) -> CoreResult<()> {
    let staging = create_private_staging(app_data_dir)?;
    sink.send(PullEvent::Progress {
        status: "Checking Xcode Command Line Tools and CMake 3.28+".into(),
        digest: None,
        completed: None,
        total: None,
        percent: None,
    });
    let cmake = preflight_build_tools(&staging.0, cancellation).await?;
    let archive = download_source_archive(&recipe, sink, cancellation).await?;
    if cancellation.is_cancelled() {
        return Err(source_error("source build was cancelled"));
    }
    let staging_path = staging.0.clone();
    let source = tokio::task::spawn_blocking(move || {
        extract_source_archive(&archive, &staging_path, &recipe)
    })
    .await
    .map_err(|error| source_error(format!("source extraction task failed: {error}")))??;
    if cancellation.is_cancelled() {
        return Err(source_error("source build was cancelled"));
    }
    sink.send(PullEvent::Progress {
        status: "Compiling whisper-cli locally. This can take several minutes.".into(),
        digest: None,
        completed: None,
        total: None,
        percent: None,
    });
    let runner = TokioProcessRunner;
    for spec in whisper_build_specs(&cmake, &staging.0, &source)? {
        let output = runner
            .run(&spec, cancellation)
            .await
            .map_err(|error| source_error(format!("Whisper build failed: {error}")))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(source_error(format!(
                "Whisper build exited with {}; {}",
                output.status,
                detail.chars().take(512).collect::<String>()
            )));
        }
    }
    let expected = source.join(recipe.output_rel_path);
    let canonical_source = source
        .canonicalize()
        .map_err(|error| source_error(format!("could not resolve source root: {error}")))?;
    let canonical_output = expected
        .canonicalize()
        .map_err(|error| source_error(format!("build output is missing: {error}")))?;
    if !canonical_output.starts_with(&canonical_source)
        || !expected
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_file())
    {
        return Err(source_error(
            "build output is not a regular file inside the source root",
        ));
    }
    crate::requirement_installer::publish_built_executable(
        app_data_dir,
        recipe.name,
        &canonical_output,
    )
}

#[cfg(test)]
#[path = "requirement_source_build_tests.rs"]
mod tests;
