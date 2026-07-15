//! Shared opt-in gating for live YouTube evals.
//!
//! A live measurement needs the network and a real yt-dlp, so every eval here is
//! `#[ignore]` by default and only runs when `NEURALNOTE_YTDLP_BIN` points at a
//! yt-dlp the guard can *prove runnable* (a bounded `--version` probe), never on
//! mere presence. `NEURALNOTE_REQUIRE_EVAL=1` turns a skip into a hard failure for
//! CI/release. These helpers back both the caption live tests and the audio
//! coverage harness so the gating rules stay identical in one place.

use super::process::{EnvironmentPolicy, ProcessRunner, ProcessSpec, TokioProcessRunner};
use neuralnote_core::ai::CaptureCancellation;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(super) const YTDLP_ENV: &str = "NEURALNOTE_YTDLP_BIN";
pub(super) const ENABLE_HINT: &str =
    "set NEURALNOTE_YTDLP_BIN to a runnable yt-dlp executable; add NEURALNOTE_REQUIRE_EVAL=1 to make skips fail";

fn require_eval() -> bool {
    std::env::var("NEURALNOTE_REQUIRE_EVAL")
        .map(|value| value == "1")
        .unwrap_or(false)
}

/// Emit the standard skip notice, and panic instead when eval is required.
pub(super) fn skip_or_fail(case: &str, reason: &str) {
    let notice = format!(
        "\n================ NEURALNOTE YOUTUBE LIVE TEST SKIPPED ================\n\
         Case: {case}\n\
         Reason: {reason}\n\
         Enable it by: {ENABLE_HINT}\n\
         A SKIPPED run is NOT a pass. Set NEURALNOTE_REQUIRE_EVAL=1 to make a skip a hard failure (CI/release).\n\
         =======================================================================\n"
    );
    eprint!("{notice}");

    if require_eval() {
        panic!(
            "NEURALNOTE_REQUIRE_EVAL=1 but the {case} YouTube live test could not run: {reason} -- enable it by: {ENABLE_HINT}"
        );
    }
}

/// Resolve the configured yt-dlp path, proving it is a real, executable file.
pub(super) fn configured_ytdlp() -> Result<PathBuf, String> {
    let value = std::env::var_os(YTDLP_ENV)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{YTDLP_ENV} is missing or empty"))?;
    let path = PathBuf::from(value);
    validate_executable(&path, "configured yt-dlp")?;
    Ok(path)
}

fn validate_executable(path: &Path, label: &str) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect {label} '{}': {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("{label} '{}' is a symlink", path.display()));
    }
    if !metadata.file_type().is_file() {
        return Err(format!(
            "{label} '{}' is not a regular file",
            path.display()
        ));
    }
    if !has_execute_bit(&metadata) {
        return Err(format!("{label} '{}' is not executable", path.display()));
    }
    Ok(())
}

#[cfg(unix)]
fn has_execute_bit(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn has_execute_bit(_metadata: &std::fs::Metadata) -> bool {
    false
}

/// Copy the configured yt-dlp into an isolated app-data tree the eval owns.
pub(super) fn prepare_app_data(source: &Path) -> Result<tempfile::TempDir, String> {
    let app_data = tempfile::tempdir().map_err(|error| format!("create app-data: {error}"))?;
    let bin = app_data.path().join("bin");
    std::fs::create_dir_all(&bin).map_err(|error| format!("create app-data bin: {error}"))?;
    let installed = bin.join("yt-dlp");
    std::fs::copy(source, &installed).map_err(|error| {
        format!(
            "copy configured yt-dlp '{}' into app-data: {error}",
            source.display()
        )
    })?;
    validate_executable(&installed, "app-data yt-dlp")?;
    Ok(app_data)
}

fn probe_spec(app_data: &Path) -> Result<ProcessSpec, String> {
    let runtime = app_data.join("live-probe-runtime");
    let environment = sanitized_environment(&runtime)?;
    Ok(ProcessSpec {
        program: app_data.join("bin").join("yt-dlp"),
        args: vec![
            OsString::from("--ignore-config"),
            OsString::from("--no-plugin-dirs"),
            OsString::from("--version"),
        ],
        cwd: Some(runtime),
        environment: EnvironmentPolicy::ClearAndSet(environment),
        timeout: Duration::from_secs(30),
        stdout_limit: 64 * 1024,
        stderr_limit: 64 * 1024,
    })
}

/// A cleared, app-data-scoped environment for a yt-dlp child process.
pub(super) fn sanitized_environment(
    runtime: &Path,
) -> Result<BTreeMap<OsString, OsString>, String> {
    let home = runtime.join("home");
    let cache = runtime.join("cache");
    let tmp = runtime.join("tmp");
    for directory in [&home, &cache, &tmp] {
        std::fs::create_dir_all(directory)
            .map_err(|error| format!("prepare yt-dlp runtime: {error}"))?;
    }
    Ok(BTreeMap::from([
        (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
        (OsString::from("HOME"), home.into_os_string()),
        (OsString::from("XDG_CACHE_HOME"), cache.into_os_string()),
        (OsString::from("TMPDIR"), tmp.into_os_string()),
    ]))
}

/// Prove the installed yt-dlp actually runs before any networked eval trusts it.
pub(super) async fn prove_runnable(app_data: &Path) -> Result<(), String> {
    let output = TokioProcessRunner
        .run(&probe_spec(app_data)?, &CaptureCancellation::default())
        .await
        .map_err(|error| format!("bounded yt-dlp --version probe failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "yt-dlp --version exited with {}; stderr: {}",
            output.status,
            output_preview(&output.stderr)
        ));
    }
    if output.stdout.iter().all(u8::is_ascii_whitespace) {
        return Err("yt-dlp --version produced no version text".into());
    }
    Ok(())
}

/// A short, lossy preview of captured process output for skip/error messages.
pub(super) fn output_preview(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(512)])
        .trim()
        .to_string()
}
