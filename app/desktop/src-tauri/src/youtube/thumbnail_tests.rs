use super::thumbnail::{
    collect_thumbnail_stream, collect_thumbnail_stream_with_raw, mqdefault_url,
    thumbnail_status_error, MAX_THUMBNAIL_DOWNLOAD_BYTES,
};
use futures_util::stream;
use image::{DynamicImage, ImageFormat};
use neuralnote_core::ai::{CaptureCancellation, VideoId};
use neuralnote_core::capture::CaptureError;
use std::io::Cursor;

fn valid_jpeg() -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(2, 2)
        .write_to(&mut bytes, ImageFormat::Jpeg)
        .unwrap();
    bytes.into_inner()
}

#[test]
fn mqdefault_url_uses_the_validated_id_even_when_it_begins_with_a_hyphen() {
    let id = VideoId::new("-abcdefghij").unwrap();

    assert_eq!(
        mqdefault_url(&id),
        "https://i.ytimg.com/vi/-abcdefghij/mqdefault.jpg"
    );
}

#[test]
fn every_thumbnail_http_failure_is_non_terminal_for_playlist_selection() {
    for status in [403, 404, 429, 500] {
        assert!(matches!(
            thumbnail_status_error(reqwest::StatusCode::from_u16(status).unwrap()),
            Some(CaptureError::ThumbnailRejected(_))
        ));
    }
    assert!(thumbnail_status_error(reqwest::StatusCode::OK).is_none());
}

#[tokio::test]
async fn thumbnail_stream_is_bounded_and_keeps_the_declared_media_type() {
    let bytes = valid_jpeg();
    let chunks = stream::iter([Ok::<_, std::io::Error>(bytes.clone())]);

    let payload = collect_thumbnail_stream(
        Some(bytes.len() as u64),
        Some("image/jpeg"),
        chunks,
        &CaptureCancellation::default(),
    )
    .await
    .unwrap();

    assert_eq!(payload.media_type, "image/jpeg");
    assert_eq!(payload.bytes, bytes);
}

#[tokio::test]
async fn declared_and_streamed_oversize_thumbnails_are_rejected() {
    let never_read = stream::iter([Ok::<_, std::io::Error>(Vec::<u8>::new())]);
    let declared = collect_thumbnail_stream(
        Some((MAX_THUMBNAIL_DOWNLOAD_BYTES + 1) as u64),
        Some("image/jpeg"),
        never_read,
        &CaptureCancellation::default(),
    )
    .await;
    assert!(matches!(declared, Err(CaptureError::ThumbnailRejected(_))));

    let chunks = stream::iter([
        Ok::<_, std::io::Error>(vec![0; MAX_THUMBNAIL_DOWNLOAD_BYTES]),
        Ok(vec![0]),
    ]);
    let streamed = collect_thumbnail_stream(
        None,
        Some("image/jpeg"),
        chunks,
        &CaptureCancellation::default(),
    )
    .await;
    assert!(matches!(streamed, Err(CaptureError::ThumbnailRejected(_))));
}

#[tokio::test]
async fn unsupported_media_type_stream_error_and_cancellation_are_explicit() {
    let unsupported = collect_thumbnail_stream(
        Some(1),
        Some("text/html"),
        stream::iter([Ok::<_, std::io::Error>(vec![b'x'])]),
        &CaptureCancellation::default(),
    )
    .await;
    assert!(matches!(
        unsupported,
        Err(CaptureError::ThumbnailRejected(_))
    ));

    let stream_error = collect_thumbnail_stream(
        None,
        Some("image/jpeg"),
        stream::iter([Err::<Vec<u8>, _>(std::io::Error::other("cut"))]),
        &CaptureCancellation::default(),
    )
    .await;
    assert!(
        matches!(stream_error, Err(CaptureError::ThumbnailRejected(detail)) if detail.contains("cut"))
    );

    let cancellation = CaptureCancellation::default();
    cancellation.cancel();
    let cancelled = collect_thumbnail_stream(
        None,
        Some("image/jpeg"),
        stream::iter([Ok::<_, std::io::Error>(vec![1])]),
        &cancellation,
    )
    .await;
    assert!(matches!(cancelled, Err(CaptureError::Cancelled(_))));
}

#[tokio::test]
async fn a_stream_failure_returns_the_partial_bytes_for_failure_retention() {
    let partial = vec![0xff, 0xd8, 0xff];
    let failure = collect_thumbnail_stream_with_raw(
        None,
        Some("image/jpeg"),
        stream::iter([
            Ok::<_, std::io::Error>(partial.clone()),
            Err(std::io::Error::other("cut")),
        ]),
        &CaptureCancellation::default(),
    )
    .await
    .unwrap_err();

    assert!(matches!(failure.error, CaptureError::ThumbnailRejected(_)));
    assert_eq!(failure.raw, partial);
}
