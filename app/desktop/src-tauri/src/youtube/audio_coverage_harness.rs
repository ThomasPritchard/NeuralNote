//! Runnable YouTube audio-coverage harness for the ffmpeg-fallback spike (#38).
//!
//! Lists the audio formats yt-dlp offers for each URL in a sample, classifies each
//! video with the pure core classifier ([`neuralnote_core::capture::classify_ytdlp_video_audio`]),
//! and prints an aggregate report plus the written threshold decision. It never
//! runs in the default suite: it is `#[ignore]`-gated and additionally skips unless
//! yt-dlp is proven runnable AND a non-empty URL sample is supplied.
//!
//! Invoke it opt-in:
//!   NN_AUDIO_COVERAGE_URLS="https://youtu.be/…  https://youtu.be/…" \
//!   NEURALNOTE_YTDLP_BIN=/path/to/yt-dlp \
//!   cargo test -p desktop --  --ignored --nocapture youtube_audio_coverage_report

use super::live_eval::{
    configured_ytdlp, prepare_app_data, prove_runnable, sanitized_environment, skip_or_fail,
    ENABLE_HINT,
};
use super::process::{EnvironmentPolicy, ProcessRunner, ProcessSpec, TokioProcessRunner};
use neuralnote_core::ai::{CaptureCancellation, YoutubeUrl};
use neuralnote_core::capture::{
    classify_ytdlp_video_audio, AudioCoverage, CoverageTally, MAX_FORMAT_LISTING_BYTES,
};
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

const CASE: &str = "youtube audio coverage";
const URLS_ENV: &str = "NN_AUDIO_COVERAGE_URLS";
const SEED_URLS: &str = include_str!("audio_coverage_urls.sample.txt");
const LISTING_TIMEOUT: Duration = Duration::from_secs(90);

/// Candidate URL strings from the env override, falling back to the checked-in seed.
fn coverage_url_lines() -> Vec<String> {
    let source = std::env::var(URLS_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| SEED_URLS.to_string());
    source
        .split([' ', '\t', '\r', '\n', ','])
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

fn listing_spec(app_data: &Path, url: &YoutubeUrl) -> Result<ProcessSpec, String> {
    let runtime = app_data.join("coverage-runtime");
    Ok(ProcessSpec {
        program: app_data.join("bin").join("yt-dlp"),
        args: vec![
            OsString::from("--ignore-config"),
            OsString::from("--no-plugin-dirs"),
            OsString::from("--dump-single-json"),
            OsString::from("--skip-download"),
            OsString::from("--no-playlist"),
            OsString::from(url.as_ref()),
        ],
        cwd: Some(runtime.clone()),
        environment: EnvironmentPolicy::ClearAndSet(sanitized_environment(&runtime)?),
        timeout: LISTING_TIMEOUT,
        stdout_limit: MAX_FORMAT_LISTING_BYTES,
        stderr_limit: 256 * 1024,
    })
}

/// List and classify one video, or `None` if the live listing was unavailable.
async fn classify_one(app_data: &Path, url: &YoutubeUrl) -> Option<AudioCoverage> {
    let spec = match listing_spec(app_data, url) {
        Ok(spec) => spec,
        Err(reason) => {
            eprintln!("  skip {}: {reason}", url.as_ref());
            return None;
        }
    };
    let output = match TokioProcessRunner
        .run(&spec, &CaptureCancellation::default())
        .await
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            eprintln!("  skip {}: yt-dlp exited {}", url.as_ref(), output.status);
            return None;
        }
        Err(error) => {
            eprintln!("  skip {}: yt-dlp failed: {error}", url.as_ref());
            return None;
        }
    };
    match classify_ytdlp_video_audio(&output.stdout) {
        Ok(coverage) => {
            eprintln!("  {} -> {}", url.as_ref(), coverage.label());
            Some(coverage)
        }
        Err(error) => {
            eprintln!("  skip {}: could not parse formats: {error}", url.as_ref());
            None
        }
    }
}

#[tokio::test]
#[ignore = "live YouTube audio-coverage measurement; opt-in with NEURALNOTE_YTDLP_BIN + NN_AUDIO_COVERAGE_URLS and --ignored"]
async fn youtube_audio_coverage_report() {
    let candidates = coverage_url_lines();
    if candidates.is_empty() {
        skip_or_fail(
            CASE,
            &format!("no URLs supplied; set {URLS_ENV} to a whitespace-separated sample"),
        );
        return;
    }
    let configured = match configured_ytdlp() {
        Ok(path) => path,
        Err(reason) => {
            skip_or_fail(CASE, &reason);
            return;
        }
    };
    let app_data = match prepare_app_data(&configured) {
        Ok(app_data) => app_data,
        Err(reason) => {
            skip_or_fail(CASE, &reason);
            return;
        }
    };
    if let Err(reason) = prove_runnable(app_data.path()).await {
        skip_or_fail(CASE, &reason);
        return;
    }

    let mut tally = CoverageTally::default();
    let mut skipped = 0usize;
    for line in &candidates {
        let Ok(url) = YoutubeUrl::new(line) else {
            eprintln!("  skip {line}: not a valid YouTube URL");
            skipped += 1;
            continue;
        };
        match classify_one(app_data.path(), &url).await {
            Some(coverage) => tally.record(coverage),
            None => skipped += 1,
        }
    }

    eprintln!("\n{tally}\n  skipped/unavailable: {skipped}");
    if tally.total() == 0 {
        skip_or_fail(
            CASE,
            &format!("every candidate was unavailable; enable it by: {ENABLE_HINT}"),
        );
    }
}
