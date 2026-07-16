use futures::executor::block_on;
use neuralnote_core::ai::{
    CaptionRequest, CaptureCancellation, ExtractorUpdateSession, PotMode, UnavailableYoutubeIo,
    VideoId, YoutubeIo, YoutubeToolSession, YoutubeUrl, WHISPER_MODEL_NAME,
};
use neuralnote_core::capture::{CaptionSource, CaptureAction, CaptureError};

#[test]
fn cancellation_is_cloneable_shared_and_monotonic() {
    let token = CaptureCancellation::default();
    let clone = token.clone();

    assert!(!token.is_cancelled());
    clone.cancel();
    assert!(token.is_cancelled());
    assert!(clone.is_cancelled());
}

#[test]
fn explicitly_shared_update_session_consumes_one_allowance_across_tool_sessions() {
    let updates = ExtractorUpdateSession::default();
    let mut first = YoutubeToolSession::new_with_update_session(
        CaptureCancellation::default(),
        updates.clone(),
    );
    let mut second =
        YoutubeToolSession::new_with_update_session(CaptureCancellation::default(), updates);
    let stale = CaptureError::ExtractorStale("stale".into());

    assert_eq!(first.decide(&stale), CaptureAction::UpdateExtractorAndRetry);
    assert_eq!(second.decide(&stale), CaptureAction::Surface);
    assert!(second.update_attempted());
}

#[test]
fn unavailable_host_seam_surfaces_every_operation() {
    let io = UnavailableYoutubeIo;
    let request = CaptionRequest {
        url: YoutubeUrl::new("https://www.youtube.com/watch?v=iG9CE55wbtY").unwrap(),
        language: "en".into(),
        source: CaptionSource::Human,
        pot: PotMode::Prefer,
    };
    let cancellation = CaptureCancellation::default();

    assert!(matches!(
        block_on(io.inspect_metadata(&request.url)),
        Err(CaptureError::RequirementMissing(_))
    ));
    assert!(matches!(
        block_on(io.fetch_caption_vtt(&request)),
        Err(CaptureError::RequirementMissing(_))
    ));
    assert!(matches!(
        block_on(io.enumerate_playlist(&request.url)),
        Err(CaptureError::RequirementMissing(_))
    ));
    assert!(matches!(
        block_on(io.fetch_thumbnail(&VideoId::new("iG9CE55wbtY").unwrap())),
        Err(CaptureError::RequirementMissing(_))
    ));
    assert!(matches!(
        block_on(io.transcribe_audio(&request.url, WHISPER_MODEL_NAME, &cancellation)),
        Err(CaptureError::RequirementMissing(_))
    ));
    assert!(matches!(
        block_on(io.update_extractor()),
        Err(CaptureError::RequirementMissing(_))
    ));
}
