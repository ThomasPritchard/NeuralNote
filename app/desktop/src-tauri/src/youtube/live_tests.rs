use super::live_eval::{configured_ytdlp, prepare_app_data, prove_runnable, skip_or_fail};
use super::process::TokioProcessRunner;
use super::service::ShellYoutubeIo;
use neuralnote_core::ai::{CaptionRequest, CaptureCancellation, PotMode, YoutubeIo, YoutubeUrl};
use neuralnote_core::capture::{parse_vtt, CaptionSource, CaptureError};
use std::sync::Arc;

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
