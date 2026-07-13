//! Implementation-authored playlist selection and high-usage confirmation.

use crate::ai::elicitation::{elicit_user, ElicitationOutcome};
use crate::ai::events::{ElicitOption, Elicitation};
use crate::ai::llm::UserPrompt;
use crate::ai::tools::{action, reject, ToolContext, ToolResult};
use crate::ai::youtube::{PlaylistPayload, VideoId, YoutubeIo, YoutubeToolSession, YoutubeUrl};
use crate::ai::youtube_tool_errors::{capture_reject, session_capture_reject};
use crate::ai::youtube_tools::{update_extractor, validate_youtube_url};
use crate::capture::{
    estimate_transcript_cost, parse_playlist, validate_thumbnail, CaptureAction, CaptureError,
    CostEstimate, PricingInput,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeSet;

const PLAYLIST_PAGE_SIZE: usize = 50;
const UNKNOWN_DURATION_ASSUMPTION_SECONDS: u64 = 60 * 60;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaylistArgs {
    playlist_url: String,
}

pub(super) async fn dispatch_select_playlist_videos(
    call_id: &str,
    args_json: &str,
    user_prompt: &dyn UserPrompt,
    context: &mut ToolContext<'_>,
) -> ToolResult {
    let args: PlaylistArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid select_playlist_videos arguments: {error}")),
    };
    let url = match validate_youtube_url(&args.playlist_url) {
        Ok(url) => url,
        Err(error) => return capture_reject(error),
    };
    let io = context.youtube_io;
    let Some(session) = context.youtube_session.as_deref_mut() else {
        return capture_reject(CaptureError::RequirementMissing(
            "YouTube per-run state is not wired".into(),
        ));
    };
    if let Some(error) = session.terminal_error().cloned() {
        return session_capture_reject(session, error);
    }
    if let Err(error) = session.ensure_playlist_uninitialized() {
        return session_capture_reject(session, error);
    }
    let playlist = match load_playlist(io, session, &url).await {
        Ok(playlist) => playlist,
        Err(error) => return session_capture_reject(session, error),
    };
    let selected =
        match elicit_playlist_selection(call_id, &playlist, io, session, user_prompt, context.sink)
            .await
        {
            Ok(selected) => selected,
            Err(result) => return result,
        };
    if let Err(result) = confirm_high_usage(
        call_id,
        &playlist.entries,
        &selected,
        context.pricing,
        user_prompt,
        context.sink,
    )
    .await
    {
        return result;
    }
    let selected_video_ids = selected_ids_in_source_order(&playlist.entries, &selected);
    if let Err(error) = configure_playlist_run(context.writes, session, &selected_video_ids) {
        return session_capture_reject(session, error);
    }
    action(
        json!({
            "selected_video_ids": selected_video_ids,
            "annotations": session.annotations(),
        })
        .to_string(),
    )
}

async fn load_playlist(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    url: &YoutubeUrl,
) -> Result<crate::capture::Playlist, CaptureError> {
    let payload = enumerate_with_retry(io, session, url).await?;
    let playlist = parse_playlist(&payload.json)?;
    if playlist.unavailable_entries_skipped > 0 {
        let entry = if playlist.unavailable_entries_skipped == 1 {
            "entry"
        } else {
            "entries"
        };
        session.annotate(format!(
            "skipped {} unavailable playlist {entry} returned by yt-dlp",
            playlist.unavailable_entries_skipped
        ));
    }
    Ok(playlist)
}

async fn elicit_playlist_selection(
    call_id: &str,
    playlist: &crate::capture::Playlist,
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    user_prompt: &dyn UserPrompt,
    sink: &mut dyn crate::ai::events::EventSink,
) -> Result<BTreeSet<String>, ToolResult> {
    let page_count = playlist.entries.len().div_ceil(PLAYLIST_PAGE_SIZE);
    let mut selected = BTreeSet::new();
    for (page_index, entries) in playlist.entries.chunks(PLAYLIST_PAGE_SIZE).enumerate() {
        let options = build_page_options(entries, io, session).await?;
        let elicitation = Elicitation {
            id: format!("{call_id}:playlist:{}", page_index + 1),
            question: format!(
                "Choose videos from '{}' (page {} of {page_count}; {} videos total).",
                playlist.title,
                page_index + 1,
                playlist.entries.len()
            ),
            options,
            multi_select: true,
        };
        match elicit_user(user_prompt, sink, elicitation).await {
            ElicitationOutcome::Answered { chosen_ids } => selected.extend(chosen_ids),
            ElicitationOutcome::Rejected { error } => {
                return Err(reject(format!("playlist selection failed: {error}")))
            }
        };
    }
    Ok(selected)
}

async fn build_page_options(
    entries: &[crate::capture::PlaylistEntry],
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
) -> Result<Vec<ElicitOption>, ToolResult> {
    let mut options = Vec::with_capacity(entries.len());
    for entry in entries {
        let video_id = VideoId::new(&entry.video_id)
            .map_err(|error| session_capture_reject(session, error))?;
        let image_data_uri = thumbnail_for_entry(io, session, &video_id, &entry.video_id).await?;
        options.push(ElicitOption {
            id: entry.video_id.clone(),
            label: entry.title.clone(),
            description: entry.duration_seconds.map(format_duration),
            image_data_uri,
        });
    }
    Ok(options)
}

async fn thumbnail_for_entry(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    video_id: &VideoId,
    raw_id: &str,
) -> Result<Option<String>, ToolResult> {
    match io.fetch_thumbnail(video_id).await {
        Ok(thumbnail) => match thumbnail_data_uri(&thumbnail.media_type, &thumbnail.bytes) {
            Ok(uri) => Ok(Some(uri)),
            Err(error @ CaptureError::ThumbnailRejected(_)) => {
                annotate_thumbnail_unavailable(session, raw_id, &error);
                Ok(None)
            }
            Err(error) => Err(session_capture_reject(session, error)),
        },
        Err(error @ CaptureError::ThumbnailRejected(_)) => {
            annotate_thumbnail_unavailable(session, raw_id, &error);
            Ok(None)
        }
        Err(error) => Err(session_capture_reject(session, error)),
    }
}

async fn confirm_high_usage(
    call_id: &str,
    entries: &[crate::capture::PlaylistEntry],
    selected: &BTreeSet<String>,
    pricing: Option<&PricingInput>,
    user_prompt: &dyn UserPrompt,
    sink: &mut dyn crate::ai::events::EventSink,
) -> Result<(), ToolResult> {
    if selected.len() <= 20 {
        return Ok(());
    }
    let pricing = pricing.ok_or_else(|| {
        capture_reject(CaptureError::RequirementMissing(
            "provider pricing is not wired for the required high-usage estimate".into(),
        ))
    })?;
    let estimated =
        estimate_playlist_selection_cost(entries, selected, pricing).map_err(capture_reject)?;
    let confirmation = high_usage_confirmation(call_id, selected.len(), &estimated);
    match elicit_user(user_prompt, sink, confirmation).await {
        ElicitationOutcome::Answered { chosen_ids } if chosen_ids.as_slice() == ["continue"] => {
            Ok(())
        }
        ElicitationOutcome::Answered { .. } => Err(capture_reject(CaptureError::Cancelled(
            "playlist distillation was cancelled at the high-usage warning".into(),
        ))),
        ElicitationOutcome::Rejected { error } => {
            Err(reject(format!("playlist confirmation failed: {error}")))
        }
    }
}

fn high_usage_confirmation(
    call_id: &str,
    selected_count: usize,
    estimated: &PlaylistCostEstimate,
) -> Elicitation {
    let unknown_duration_note = unknown_duration_note(estimated.unknown_duration_count);
    Elicitation {
        id: format!("{call_id}:high-usage"),
        question: format!(
            "You selected {selected_count} videos. Are you sure? This can incur high usage. Rough estimate: {} input tokens, {}. Method: selected duration × 150 spoken words/minute; {}{}",
            estimated.cost.estimated_tokens,
            estimated.cost.display,
            estimated.cost.method,
            unknown_duration_note
        ),
        options: vec![
            ElicitOption {
                id: "continue".into(),
                label: "Continue".into(),
                description: Some("Process the selected videos sequentially.".into()),
                image_data_uri: None,
            },
            ElicitOption {
                id: "cancel".into(),
                label: "Cancel".into(),
                description: None,
                image_data_uri: None,
            },
        ],
        multi_select: false,
    }
}

fn unknown_duration_note(count: usize) -> String {
    if count == 0 {
        return String::new();
    }
    let noun = if count == 1 {
        "video has"
    } else {
        "videos have"
    };
    format!(
        " {count} {noun} unknown durations; the estimate uses a conservative duration assumption of 60 minutes each."
    )
}

fn selected_ids_in_source_order(
    entries: &[crate::capture::PlaylistEntry],
    selected: &BTreeSet<String>,
) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| selected.contains(&entry.video_id))
        .map(|entry| entry.video_id.clone())
        .collect()
}

fn configure_playlist_run(
    writes: &mut crate::ai::write_policy::WriteSession,
    session: &mut YoutubeToolSession,
    selected_video_ids: &[String],
) -> Result<(), CaptureError> {
    writes
        .ensure_work_items(selected_video_ids.len())
        .map_err(|error| {
            CaptureError::PlaylistInvalid(format!(
                "could not configure the per-video write budget: {error}"
            ))
        })?;
    session.begin_playlist(selected_video_ids.to_vec())
}

fn format_duration(seconds: u64) -> String {
    if seconds >= 60 * 60 {
        format!(
            "{}:{:02}:{:02}",
            seconds / (60 * 60),
            (seconds / 60) % 60,
            seconds % 60
        )
    } else {
        format!("{}:{:02}", seconds / 60, seconds % 60)
    }
}

fn annotate_thumbnail_unavailable(
    session: &mut YoutubeToolSession,
    video_id: &str,
    error: &CaptureError,
) {
    debug_assert!(matches!(error, CaptureError::ThumbnailRejected(_)));
    session.annotate(format!(
        "thumbnail unavailable for video '{video_id}' ({}); continued without an image",
        error.code()
    ));
}

struct PlaylistCostEstimate {
    cost: CostEstimate,
    unknown_duration_count: usize,
}

fn estimate_playlist_selection_cost(
    entries: &[crate::capture::PlaylistEntry],
    selected: &BTreeSet<String>,
    pricing: &PricingInput,
) -> Result<PlaylistCostEstimate, CaptureError> {
    let mut total_seconds = 0u64;
    let mut unknown_duration_count = 0usize;
    for entry in entries
        .iter()
        .filter(|entry| selected.contains(&entry.video_id))
    {
        let duration = entry.duration_seconds.unwrap_or_else(|| {
            unknown_duration_count += 1;
            UNKNOWN_DURATION_ASSUMPTION_SECONDS
        });
        total_seconds = total_seconds
            .checked_add(duration)
            .ok_or_else(|| CaptureError::InvalidMetadata("playlist duration overflowed".into()))?;
    }
    let estimated_words = total_seconds
        .checked_mul(5)
        .and_then(|value| value.checked_add(1))
        .map(|value| value / 2)
        .ok_or_else(|| CaptureError::InvalidMetadata("playlist word estimate overflowed".into()))?;
    Ok(PlaylistCostEstimate {
        cost: estimate_transcript_cost(estimated_words, pricing.clone())?,
        unknown_duration_count,
    })
}

async fn enumerate_with_retry(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    url: &YoutubeUrl,
) -> Result<PlaylistPayload, CaptureError> {
    match io.enumerate_playlist(url).await {
        Err(error) => match session.decide(&error) {
            CaptureAction::UpdateExtractorAndRetry => {
                update_extractor(io, session).await;
                io.enumerate_playlist(url).await
            }
            _ => Err(error),
        },
        success => success,
    }
}

fn thumbnail_data_uri(media_type: &str, bytes: &[u8]) -> Result<String, CaptureError> {
    validate_thumbnail(media_type, bytes)?;
    Ok(format!(
        "data:{media_type};base64,{}",
        STANDARD.encode(bytes)
    ))
}
