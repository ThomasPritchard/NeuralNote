use super::process::{EnvironmentPolicy, ProcessRunner, ProcessSpec, TokioProcessRunner};
use super::service::ShellYoutubeIo;
use neuralnote_core::ai::{CaptionRequest, CaptureCancellation, PotMode, YoutubeIo, YoutubeUrl};
use neuralnote_core::capture::{parse_vtt, CaptionSource, CaptureError};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const YTDLP_ENV: &str = "NEURALNOTE_YTDLP_BIN";
const ENABLE_HINT: &str =
    "set NEURALNOTE_YTDLP_BIN to a runnable yt-dlp executable; add NEURALNOTE_REQUIRE_EVAL=1 to make skips fail";

fn require_eval() -> bool {
    std::env::var("NEURALNOTE_REQUIRE_EVAL")
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn skip_or_fail(case: &str, reason: &str) {
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

fn configured_ytdlp() -> Result<PathBuf, String> {
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

fn prepare_app_data(source: &Path) -> Result<tempfile::TempDir, String> {
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
    let home = runtime.join("home");
    let cache = runtime.join("cache");
    let tmp = runtime.join("tmp");
    for directory in [&home, &cache, &tmp] {
        std::fs::create_dir_all(directory)
            .map_err(|error| format!("prepare yt-dlp probe runtime: {error}"))?;
    }
    let environment = BTreeMap::from([
        (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
        (OsString::from("HOME"), home.into_os_string()),
        (OsString::from("XDG_CACHE_HOME"), cache.into_os_string()),
        (OsString::from("TMPDIR"), tmp.into_os_string()),
    ]);
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

async fn prove_runnable(app_data: &Path) -> Result<(), String> {
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

fn output_preview(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(512)])
        .trim()
        .to_string()
}

fn external_live_failure(error: &CaptureError) -> bool {
    matches!(
        error,
        CaptureError::MetadataUnavailable(_)
            | CaptureError::CaptionsAbsent(_)
            | CaptureError::YoutubeBlocked(_)
            | CaptureError::ExtractorStale(_)
    )
}

async fn run_caption_case(case: &str, video_id: &str, source: CaptionSource) {
    let configured = match configured_ytdlp() {
        Ok(path) => path,
        Err(reason) => {
            skip_or_fail(case, &reason);
            return;
        }
    };
    let app_data = match prepare_app_data(&configured) {
        Ok(app_data) => app_data,
        Err(reason) => {
            skip_or_fail(case, &reason);
            return;
        }
    };
    if let Err(reason) = prove_runnable(app_data.path()).await {
        skip_or_fail(case, &reason);
        return;
    }

    let io = match ShellYoutubeIo::with_runner(
        app_data.path().to_path_buf(),
        Arc::new(TokioProcessRunner),
        CaptureCancellation::default(),
        None,
    ) {
        Ok(io) => io,
        Err(error) => {
            skip_or_fail(
                case,
                &format!("could not construct shell YouTube I/O: {error}"),
            );
            return;
        }
    };
    let request = CaptionRequest {
        url: YoutubeUrl::new(&format!("https://www.youtube.com/watch?v={video_id}"))
            .expect("the pinned live-test URL is valid"),
        language: "en".into(),
        source,
        pot: PotMode::Disabled,
    };
    let payload = match io.fetch_caption_vtt(&request).await {
        Ok(payload) => payload,
        Err(error) if external_live_failure(&error) => {
            skip_or_fail(
                case,
                &format!("live YouTube extraction was unavailable: {error}"),
            );
            return;
        }
        Err(error) => panic!("{case} failed inside the shell YouTube boundary: {error}"),
    };
    let cues = parse_vtt(&payload.vtt)
        .unwrap_or_else(|error| panic!("{case} returned VTT that core rejected: {error}"));
    assert!(!cues.is_empty(), "{case} returned no parsed caption cues");
}

#[tokio::test]
#[ignore = "live YouTube eval; opt-in with NEURALNOTE_YTDLP_BIN and --ignored"]
async fn youtube_human_captions_live() {
    run_caption_case(
        "human captions (jNQXAC9IVRw)",
        "jNQXAC9IVRw",
        CaptionSource::Human,
    )
    .await;
}

#[tokio::test]
#[ignore = "live YouTube eval; opt-in with NEURALNOTE_YTDLP_BIN and --ignored"]
async fn youtube_automatic_captions_live() {
    run_caption_case(
        "automatic captions (UF8uR6Z6KLc)",
        "UF8uR6Z6KLc",
        CaptionSource::Automatic,
    )
    .await;
}
