use super::workspace::{append_error_context, OperationWorkspace};
use futures_util::{Stream, StreamExt};
use neuralnote_core::ai::{CaptureCancellation, ThumbnailPayload, VideoId};
use neuralnote_core::capture::{validate_thumbnail, CaptureError};
use std::time::Duration;

/// Matches core's `mqdefault.jpg` data-URI ceiling. The HTTP layer enforces it
/// before and during streaming so an untrusted response is never fully buffered.
pub(super) const MAX_THUMBNAIL_DOWNLOAD_BYTES: usize = 256 * 1_024;

#[derive(Debug)]
pub(super) struct ThumbnailFetchFailure {
    pub(super) error: CaptureError,
    pub(super) raw: Vec<u8>,
}

pub(super) fn mqdefault_url(video_id: &VideoId) -> String {
    format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", video_id.as_ref())
}

pub(super) async fn fetch_thumbnail(
    client: &reqwest::Client,
    video_id: &VideoId,
    cancellation: &CaptureCancellation,
) -> Result<ThumbnailPayload, ThumbnailFetchFailure> {
    if cancellation.is_cancelled() {
        return Err(failure(cancelled(), Vec::new()));
    }
    let request = client.get(mqdefault_url(video_id)).send();
    tokio::pin!(request);
    let response = tokio::select! {
        biased;
        response = &mut request => response.map_err(|error| {
            failure(
                CaptureError::ThumbnailRejected(format!("thumbnail request failed: {error}")),
                Vec::new(),
            )
        })?,
        () = wait_for_cancellation(cancellation) => {
            return Err(failure(cancelled(), Vec::new()));
        },
    };
    let status = response.status();
    if let Some(error) = thumbnail_status_error(status) {
        return Err(failure(error, Vec::new()));
    }
    let media_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    collect_thumbnail_stream_with_raw(
        response.content_length(),
        media_type.as_deref(),
        response.bytes_stream(),
        cancellation,
    )
    .await
}

pub(super) fn thumbnail_status_error(status: reqwest::StatusCode) -> Option<CaptureError> {
    (!status.is_success()).then(|| {
        CaptureError::ThumbnailRejected(format!("mqdefault thumbnail returned HTTP {status}"))
    })
}

#[cfg(test)]
pub(super) async fn collect_thumbnail_stream<S, B, E>(
    content_length: Option<u64>,
    media_type: Option<&str>,
    stream: S,
    cancellation: &CaptureCancellation,
) -> Result<ThumbnailPayload, CaptureError>
where
    S: Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    collect_thumbnail_stream_with_raw(content_length, media_type, stream, cancellation)
        .await
        .map_err(|failure| failure.error)
}

pub(super) async fn collect_thumbnail_stream_with_raw<S, B, E>(
    content_length: Option<u64>,
    media_type: Option<&str>,
    stream: S,
    cancellation: &CaptureCancellation,
) -> Result<ThumbnailPayload, ThumbnailFetchFailure>
where
    S: Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    if cancellation.is_cancelled() {
        return Err(failure(cancelled(), Vec::new()));
    }
    if content_length.is_some_and(|length| {
        length > u64::try_from(MAX_THUMBNAIL_DOWNLOAD_BYTES).expect("constant fits u64")
    }) {
        return Err(failure(
            rejected("thumbnail exceeds the byte limit"),
            Vec::new(),
        ));
    }
    let media_type = media_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| matches!(*value, "image/jpeg" | "image/png" | "image/webp"))
        .ok_or_else(|| {
            failure(
                rejected("thumbnail has an unsupported or missing media type"),
                Vec::new(),
            )
        })?;

    let mut bytes = Vec::with_capacity(
        content_length
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0),
    );
    futures_util::pin_mut!(stream);
    loop {
        let next = tokio::select! {
            biased;
            next = stream.next() => next,
            () = wait_for_cancellation(cancellation) => {
                return Err(failure(cancelled(), bytes));
            },
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                return Err(failure(
                    rejected(format!("thumbnail response stream failed: {error}")),
                    bytes,
                ));
            }
        };
        let chunk = chunk.as_ref();
        let Some(next_len) = bytes.len().checked_add(chunk.len()) else {
            return Err(failure(rejected("thumbnail byte count overflowed"), bytes));
        };
        if next_len > MAX_THUMBNAIL_DOWNLOAD_BYTES {
            let remaining = MAX_THUMBNAIL_DOWNLOAD_BYTES.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
            return Err(failure(rejected("thumbnail exceeds the byte limit"), bytes));
        }
        bytes.extend_from_slice(chunk);
    }
    if bytes.is_empty() {
        return Err(failure(rejected("thumbnail response was empty"), bytes));
    }
    Ok(ThumbnailPayload {
        media_type: media_type.to_string(),
        bytes,
    })
}

fn failure(error: CaptureError, raw: Vec<u8>) -> ThumbnailFetchFailure {
    ThumbnailFetchFailure { error, raw }
}

pub(super) async fn finalize_thumbnail(
    operation: OperationWorkspace,
    result: Result<ThumbnailPayload, ThumbnailFetchFailure>,
) -> Result<ThumbnailPayload, CaptureError> {
    match result {
        Ok(payload) => {
            if let Err(error) = validate_thumbnail(&payload.media_type, &payload.bytes) {
                return Err(retain_thumbnail_failure(operation, error, &payload.bytes).await);
            }
            operation.complete().await?;
            Ok(payload)
        }
        Err(failure) => Err(retain_thumbnail_failure(operation, failure.error, &failure.raw).await),
    }
}

async fn retain_thumbnail_failure(
    operation: OperationWorkspace,
    error: CaptureError,
    raw: &[u8],
) -> CaptureError {
    let error = if raw.is_empty() {
        error
    } else {
        match operation.write_raw("thumbnail.raw", raw).await {
            Ok(()) => error,
            Err(retention) => append_error_context(
                error,
                format!(
                    "could not retain fetched thumbnail bytes: {}",
                    retention.detail()
                ),
            ),
        }
    };
    operation.preserve_failure(error).await
}

async fn wait_for_cancellation(cancellation: &CaptureCancellation) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn cancelled() -> CaptureError {
    CaptureError::Cancelled("thumbnail fetch was cancelled".into())
}

fn rejected(detail: impl Into<String>) -> CaptureError {
    CaptureError::ThumbnailRejected(detail.into())
}
