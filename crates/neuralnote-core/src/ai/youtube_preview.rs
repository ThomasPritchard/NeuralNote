//! The preview card for the video a distil run is working on right now.

use crate::ai::events::ChatEvent;
use crate::ai::youtube::YoutubeIo;
use crate::capture::{thumbnail_data_uri, CaptureError, VideoId, VideoMetadata};

/// Compose the preview for a video whose metadata has already been read and
/// validated against the playlist the user picked.
///
/// **It carries no playlist position, and that is the point.** The position is
/// owned by the [`ChatEvent::PlanningRound`] beacon alone, so the head and the
/// card read one number from one emitter and can never disagree about which
/// video is in flight. The consumer retires a preview when a beacon names a
/// different item, which places an ordering requirement on the caller: send this
/// AFTER the beacon that announced its item, never before, or the beacon that
/// announced the video would retire the card describing it.
///
/// The call site satisfies that by construction — the beacon opens a round and
/// this runs inside a tool dispatched during that round — rather than by anyone
/// remembering to.
/// `video_id` is the single source for both the id on the wire and the image
/// fetched for it. Reading the id from `metadata` while fetching the picture for
/// a separately-passed `VideoId` would let a caller put one video's thumbnail on
/// another video's card — the two agree at today's only call site, and nothing
/// about the signature required them to.
pub(super) async fn video_preview(
    io: &dyn YoutubeIo,
    metadata: &VideoMetadata,
    video_id: &VideoId,
) -> ChatEvent {
    ChatEvent::VideoPreview {
        video_id: video_id.as_ref().to_string(),
        title: metadata.title.clone(),
        duration_secs: metadata.duration_seconds,
        channel: metadata.channel.clone(),
        thumbnail_data_uri: thumbnail_or_none(io, video_id).await,
    }
}

/// The bounded, always-degrading thumbnail fetch.
///
/// **Every** failure yields `None` — a timeout, an oversized body, a rejected
/// image, a host that answered with nonsense, all of them. This is the one place
/// in this codebase where a fallback is the correct answer rather than a hidden
/// bug: the image hangs off a lookup that has already succeeded, and losing a
/// distil run over a decorative picture would be the worse failure by far. Note
/// that playlist selection deliberately does the opposite with the same seam —
/// there the image is what the user is choosing from, so a fetch that fails in an
/// unexpected way ends the call.
///
/// It is degraded, not silent: the reason is logged, because "failures are
/// explicit" still applies to everything a maintainer has to diagnose later.
///
/// Two bounds keep a hostile or huge image from wedging a run or bloating the
/// event channel, and the seam this reuses already owns both:
///
/// * **Bytes** — `MAX_THUMBNAIL_BYTES`, 256 KiB, checked before any decode is
///   attempted and enforced again by the host while streaming, so an untrusted
///   response is never fully buffered. The pinned `mqdefault.jpg` runs to tens of
///   kilobytes, so this is headroom rather than a working limit.
/// * **Time** — the host's thumbnail client, five seconds to connect and thirty
///   in total. The request URL is derived entirely from a validated `VideoId`,
///   so no model or user argument reaches it.
///
/// [`thumbnail_data_uri`] then decodes the image and bounds its dimensions, so
/// what crosses the wire is a picture rather than a payload wearing an image
/// header. That decode is what carries the safety here, because the thumbnail
/// client still follows redirects — unlike the catalogue client, which sets
/// `redirect::Policy::none()` — so the bytes are not guaranteed to have come
/// from the host the URL names.
async fn thumbnail_or_none(io: &dyn YoutubeIo, video_id: &VideoId) -> Option<String> {
    match fetch_thumbnail_uri(io, video_id).await {
        Ok(uri) => Some(uri),
        Err(error) => {
            log::warn!(
                "video preview for '{}' has no thumbnail ({}): {}",
                video_id.as_ref(),
                error.code(),
                error.detail()
            );
            None
        }
    }
}

async fn fetch_thumbnail_uri(
    io: &dyn YoutubeIo,
    video_id: &VideoId,
) -> Result<String, CaptureError> {
    let payload = io.fetch_thumbnail(video_id).await?;
    thumbnail_data_uri(&payload.media_type, &payload.bytes)
}
