use async_trait::async_trait;
use image::{DynamicImage, ImageFormat};
use neuralnote_core::ai::{
    CaptionPayload, CaptionRequest, CaptureCancellation, MetadataPayload, PlaylistPayload,
    ThumbnailPayload, VideoId, YoutubeIo, YoutubeUrl,
};
use neuralnote_core::capture::CaptureError;
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

#[derive(Default)]
pub struct PagedPlaylistIo {
    pub thumbnail_calls: AtomicUsize,
}

#[async_trait]
impl YoutubeIo for PagedPlaylistIo {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        Err(CaptureError::MetadataUnavailable("unused".into()))
    }

    async fn fetch_caption_vtt(
        &self,
        _request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(CaptureError::CaptionsAbsent("unused".into()))
    }

    async fn enumerate_playlist(&self, _url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        let entries = (0..51)
            .map(|index| {
                serde_json::json!({
                    "id": format!("V{index:010}"),
                    "title": format!("Video {index}"),
                    "duration": 10
                })
            })
            .collect::<Vec<_>>();
        Ok(PlaylistPayload {
            json: serde_json::to_vec(&serde_json::json!({
                "_type": "playlist",
                "id": "PL-paged_123",
                "title": "Paged talks",
                "entries": entries
            }))
            .unwrap(),
        })
    }

    async fn fetch_thumbnail(&self, _video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        self.thumbnail_calls.fetch_add(1, Ordering::SeqCst);
        Ok(valid_jpeg_thumbnail())
    }

    async fn transcribe_audio(
        &self,
        _url: &YoutubeUrl,
        _model: &str,
        _cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(CaptureError::TranscriptionFailed("unused".into()))
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        Ok(())
    }
}

pub struct ScriptedPlaylistIo {
    enumerations: Mutex<VecDeque<Result<PlaylistPayload, CaptureError>>>,
    thumbnail: Result<ThumbnailPayload, CaptureError>,
    update: Result<(), CaptureError>,
    pub update_calls: AtomicUsize,
    pub enumeration_calls: AtomicUsize,
}

impl ScriptedPlaylistIo {
    pub fn new(
        enumerations: impl IntoIterator<Item = Result<PlaylistPayload, CaptureError>>,
    ) -> Self {
        Self {
            enumerations: Mutex::new(enumerations.into_iter().collect()),
            thumbnail: Ok(valid_jpeg_thumbnail()),
            update: Ok(()),
            update_calls: AtomicUsize::new(0),
            enumeration_calls: AtomicUsize::new(0),
        }
    }

    pub fn with_thumbnail(mut self, thumbnail: Result<ThumbnailPayload, CaptureError>) -> Self {
        self.thumbnail = thumbnail;
        self
    }

    pub fn with_update(mut self, update: Result<(), CaptureError>) -> Self {
        self.update = update;
        self
    }
}

#[async_trait]
impl YoutubeIo for ScriptedPlaylistIo {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        Err(CaptureError::MetadataUnavailable("unused".into()))
    }

    async fn fetch_caption_vtt(
        &self,
        _request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(CaptureError::CaptionsAbsent("unused".into()))
    }

    async fn enumerate_playlist(&self, _url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        self.enumeration_calls.fetch_add(1, Ordering::SeqCst);
        self.enumerations
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted playlist response")
    }

    async fn fetch_thumbnail(&self, _video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        self.thumbnail.clone()
    }

    async fn transcribe_audio(
        &self,
        _url: &YoutubeUrl,
        _model: &str,
        _cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(CaptureError::TranscriptionFailed("unused".into()))
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        self.update_calls.fetch_add(1, Ordering::SeqCst);
        self.update.clone()
    }
}

pub fn valid_jpeg_thumbnail() -> ThumbnailPayload {
    ThumbnailPayload {
        media_type: "image/jpeg".into(),
        bytes: encoded_thumbnail(ImageFormat::Jpeg),
    }
}

pub fn valid_png_bytes() -> Vec<u8> {
    encoded_thumbnail(ImageFormat::Png)
}

pub fn valid_webp_bytes() -> Vec<u8> {
    encoded_thumbnail(ImageFormat::WebP)
}

fn encoded_thumbnail(format: ImageFormat) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(2, 2)
        .write_to(&mut bytes, format)
        .unwrap();
    bytes.into_inner()
}

pub fn playlist_payload(entries: Vec<serde_json::Value>) -> PlaylistPayload {
    PlaylistPayload {
        json: serde_json::to_vec(&serde_json::json!({
            "_type": "playlist",
            "id": "PL-scripted_123",
            "title": "Scripted talks",
            "entries": entries,
        }))
        .unwrap(),
    }
}

pub fn entries(count: usize, include_duration: bool) -> Vec<serde_json::Value> {
    (0..count)
        .map(|index| {
            let mut entry = serde_json::json!({
                "id": format!("S{index:010}"),
                "title": format!("Scripted {index}"),
            });
            if include_duration {
                entry["duration"] = serde_json::json!(60);
            }
            entry
        })
        .collect()
}
