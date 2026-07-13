use async_trait::async_trait;
use futures::executor::block_on;
use neuralnote_core::ai::{
    CaptionPayload, CaptionRequest, CaptureCancellation, ExtractorUpdateSession, MetadataPayload,
    PlaylistPayload, PotMode, ThumbnailPayload, UnavailableYoutubeIo, VideoId, YoutubeIo,
    YoutubeToolSession, YoutubeUrl, WHISPER_MODEL_NAME,
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

#[allow(dead_code)]
struct SignatureTripwire;

#[async_trait]
impl YoutubeIo for SignatureTripwire {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        Ok(MetadataPayload {
            json: Vec::new(),
            annotations: Vec::new(),
        })
    }

    async fn fetch_caption_vtt(
        &self,
        _request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        Ok(CaptionPayload {
            vtt: Vec::new(),
            annotations: Vec::new(),
        })
    }

    async fn enumerate_playlist(&self, _url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        Ok(PlaylistPayload { json: Vec::new() })
    }

    async fn fetch_thumbnail(&self, _video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        Ok(ThumbnailPayload {
            media_type: "image/jpeg".into(),
            bytes: Vec::new(),
        })
    }

    async fn transcribe_audio(
        &self,
        _url: &YoutubeUrl,
        _model: &str,
        _cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        Ok(CaptionPayload {
            vtt: Vec::new(),
            annotations: Vec::new(),
        })
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        Ok(())
    }
}
