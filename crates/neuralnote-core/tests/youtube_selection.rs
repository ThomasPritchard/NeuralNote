#[path = "youtube_support/selection.rs"]
mod selection_support;
mod support;
mod youtube_support;

use neuralnote_core::ai::tools::{ToolOutcome, TOOL_SELECT_PLAYLIST_VIDEOS};
use neuralnote_core::ai::{
    KeywordRetriever, PlaylistPayload, ThumbnailPayload, WriteSession, YoutubeToolSession,
    YoutubeUrl,
};
use neuralnote_core::capture::{CaptureError, PricingInput};
use selection_support::*;
use std::sync::atomic::Ordering;
use youtube_support::{
    call, call_configured, call_with_writes, MemoryProfileIo, PlaylistIo, ScriptedPrompt,
};

#[test]
fn playlist_picker_keeps_options_out_of_model_context() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let prompt = ScriptedPrompt::with_answers([vec!["UF8uR6Z6KLc".into()]]);
    let profile = MemoryProfileIo::default();
    let result = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-safe_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&result.content).unwrap(),
        serde_json::json!({
            "selected_video_ids":["UF8uR6Z6KLc"],
            "annotations": [],
        })
    );
    assert!(!result.content.contains("First"));
    assert!(!result.content.contains("data:image"));

    let seen = prompt.seen.lock().unwrap();
    assert!(seen[0].question.contains("2 videos total"));
    assert_eq!(seen.len(), 1);
    assert!(seen[0].multi_select);
    assert_eq!(seen[0].options.len(), 2);
    assert_eq!(seen[0].options[1].id, "UF8uR6Z6KLc");
    assert!(seen[0].options[0]
        .image_data_uri
        .as_deref()
        .unwrap()
        .starts_with("data:image/jpeg;base64,"));
}

#[test]
fn nested_playlist_selection_is_rejected_before_io_and_keeps_the_original_run() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let first_prompt = ScriptedPrompt::with_answers([vec!["S0000000000".into()]]);
    let first_io = ScriptedPlaylistIo::new([Ok(playlist_payload(entries(2, true)))]);
    let mut session = YoutubeToolSession::default();

    let first = call(
        vault.path(),
        &retriever,
        &first_io,
        &mut session,
        &profile,
        &first_prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-original_123"}"#,
    );
    assert_eq!(first.outcome, ToolOutcome::Action);

    let nested_io = ScriptedPlaylistIo::new(std::iter::empty());
    let nested = call(
        vault.path(),
        &retriever,
        &nested_io,
        &mut session,
        &profile,
        &ScriptedPrompt::default(),
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-replacement_123"}"#,
    );

    assert_eq!(nested.outcome, ToolOutcome::Rejected);
    assert!(nested.content.contains("playlist_invalid"));
    assert_eq!(nested_io.enumeration_calls.load(Ordering::SeqCst), 0);
    assert!(session
        .validate_playlist_capture_url(&YoutubeUrl::new("https://youtu.be/S0000000000").unwrap())
        .is_ok());
    assert!(session
        .validate_playlist_capture_url(&YoutubeUrl::new("https://youtu.be/S0000000001").unwrap())
        .is_err());
}

#[test]
fn playlist_picker_preserves_source_order_not_answer_or_set_order() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let prompt = ScriptedPrompt::with_answers([vec!["UF8uR6Z6KLc".into(), "iG9CE55wbtY".into()]]);
    let profile = MemoryProfileIo::default();
    let mut writes = WriteSession::new(1).unwrap();
    let result = call_with_writes(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-safe_123"}"#,
        &mut writes,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&result.content).unwrap(),
        serde_json::json!({
            "selected_video_ids": ["iG9CE55wbtY", "UF8uR6Z6KLc"],
            "annotations": [],
        })
    );
    assert_eq!(writes.budget().work_item_count(), 2);
    assert_eq!(writes.budget().total_cap(), 16);
}

#[test]
fn playlist_picker_skips_unavailable_entries_and_exposes_the_reason() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::with_answers([vec!["S0000000000".into()]]);
    let io = ScriptedPlaylistIo::new([Ok(playlist_payload(vec![
        serde_json::Value::Null,
        serde_json::json!({
            "id": "S0000000000",
            "title": "Available",
            "duration": 10,
        }),
        serde_json::Value::Null,
    ]))]);

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&result.content).unwrap(),
        serde_json::json!({
            "selected_video_ids": ["S0000000000"],
            "annotations": [
                "skipped 2 unavailable playlist entries returned by yt-dlp"
            ],
        })
    );
    let seen = prompt.seen.lock().unwrap();
    assert_eq!(seen[0].options.len(), 1);
}

#[test]
fn playlist_picker_rejects_when_every_playlist_entry_is_unavailable() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();
    let io = ScriptedPlaylistIo::new([Ok(playlist_payload(vec![
        serde_json::Value::Null,
        serde_json::Value::Null,
    ]))]);

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result
        .content
        .contains("playlist contains no available entries"));
    assert!(result
        .content
        .contains("skipped 2 unavailable playlist entries"));
    assert!(prompt.seen.lock().unwrap().is_empty());
}

#[test]
fn playlist_picker_formats_durations_across_the_one_hour_boundary() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();
    let io = ScriptedPlaylistIo::new([Ok(playlist_payload(vec![
        serde_json::json!({"id":"S0000000000","title":"Short","duration":3599}),
        serde_json::json!({"id":"S0000000001","title":"Hour","duration":3600}),
        serde_json::json!({"id":"S0000000002","title":"Long","duration":3661}),
    ]))]);

    let _ = call(
        vault.path(),
        &retriever,
        &io,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );

    let seen = prompt.seen.lock().unwrap();
    let descriptions = seen[0]
        .options
        .iter()
        .map(|option| option.description.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(
        descriptions,
        [Some("59:59"), Some("1:00:00"), Some("1:01:01")]
    );
}

#[test]
fn playlist_picker_degrades_a_truncated_thumbnail_header_to_no_image() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let prompt = ScriptedPrompt::with_answers([vec!["UF8uR6Z6KLc".into()]]);
    let profile = MemoryProfileIo::default();
    let io = PlaylistIo {
        thumbnail: vec![0xff, 0xd8, 0xff],
        ..PlaylistIo::default()
    };

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-safe_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert!(result.content.contains("thumbnail_rejected"));
    let seen = prompt.seen.lock().unwrap();
    assert!(seen[0]
        .options
        .iter()
        .all(|option| option.image_data_uri.is_none()));
}

#[test]
fn playlist_picker_fetches_only_the_current_thumbnail_page_before_prompting() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let io = PagedPlaylistIo::default();
    let prompt = ScriptedPrompt::default();
    let profile = MemoryProfileIo::default();

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-paged_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert_eq!(io.thumbnail_calls.load(Ordering::SeqCst), 50);
    let seen = prompt.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].options.len(), 50);
}

#[test]
fn high_usage_confirmation_states_local_cost_tokens_and_estimation_method() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let io = PagedPlaylistIo::default();
    let selected = (0..21)
        .map(|index| format!("V{index:010}"))
        .collect::<Vec<_>>();
    let prompt = ScriptedPrompt::with_answers([selected, Vec::new(), vec!["continue".into()]]);
    let profile = MemoryProfileIo::default();

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-paged_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let seen = prompt.seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    let warning = &seen[2].question;
    assert!(warning.contains("free — runs locally"), "{warning}");
    assert!(warning.contains("tokens"), "{warning}");
    assert!(warning.contains("150 spoken words/minute"), "{warning}");
}

#[test]
fn playlist_picker_rejects_malformed_arguments_and_non_youtube_urls() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();

    let malformed = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":1}"#,
    );
    assert_eq!(malformed.outcome, ToolOutcome::Rejected);
    assert!(malformed
        .content
        .contains("invalid select_playlist_videos arguments"));

    let invalid_url = call(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://example.com/playlist"}"#,
    );
    assert_eq!(invalid_url.outcome, ToolOutcome::Rejected);
    assert!(invalid_url.content.contains("invalid_source"));
}

#[test]
fn playlist_picker_requires_a_wired_session() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();
    let pricing = PricingInput::Local;
    let mut writes = WriteSession::new(1).unwrap();
    let mut session = YoutubeToolSession::default();

    let result = call_configured(
        vault.path(),
        &retriever,
        &PlaylistIo::default(),
        &mut session,
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-safe_123"}"#,
        &mut writes,
        Some(&pricing),
        false,
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("requirement_missing"));
}

#[test]
fn playlist_enumeration_surfaces_errors_and_stops_after_a_block() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();
    let io = ScriptedPlaylistIo::new([Err(CaptureError::YoutubeBlocked(
        "YouTube blocked the playlist".into(),
    ))]);
    let mut session = YoutubeToolSession::default();

    let first = call(
        vault.path(),
        &retriever,
        &io,
        &mut session,
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );
    assert_eq!(first.outcome, ToolOutcome::Rejected);
    assert!(first.content.contains("youtube_blocked"));
    assert!(session.terminal_error().is_some());

    let second = call(
        vault.path(),
        &retriever,
        &io,
        &mut session,
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );
    assert_eq!(second.outcome, ToolOutcome::Rejected);
    assert_eq!(io.enumeration_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn stale_playlist_enumeration_updates_once_and_retries_after_update_failure() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::with_answers([vec!["S0000000000".into()]]);
    let io = ScriptedPlaylistIo::new([
        Err(CaptureError::ExtractorStale(
            "extractor signature changed".into(),
        )),
        Ok(playlist_payload(entries(1, true))),
    ])
    .with_update(Err(CaptureError::MetadataUnavailable(
        "update service unavailable".into(),
    )));
    let mut session = YoutubeToolSession::default();

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut session,
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(io.enumeration_calls.load(Ordering::SeqCst), 2);
    assert_eq!(io.update_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        session.annotations(),
        ["yt-dlp update failed (metadata_unavailable); continued with the current binary"]
    );
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(
        value["annotations"],
        serde_json::json!(session.annotations())
    );
}

#[test]
fn playlist_parse_rejection_preserves_the_extractor_update_annotation() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();
    let io = ScriptedPlaylistIo::new([
        Err(CaptureError::ExtractorStale(
            "extractor signature changed".into(),
        )),
        Ok(PlaylistPayload {
            json: b"not json".to_vec(),
        }),
    ])
    .with_update(Err(CaptureError::MetadataUnavailable(
        "update service unavailable".into(),
    )));
    let mut session = YoutubeToolSession::default();

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut session,
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["error"]["kind"], "playlist_invalid");
    assert_eq!(
        value["annotations"],
        serde_json::json!([
            "yt-dlp update failed (metadata_unavailable); continued with the current binary"
        ])
    );
}

#[test]
fn playlist_picker_surfaces_invalid_inventory() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();
    let invalid = ScriptedPlaylistIo::new([Ok(PlaylistPayload {
        json: b"not json".to_vec(),
    })]);

    let invalid_result = call(
        vault.path(),
        &retriever,
        &invalid,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );
    assert_eq!(invalid_result.outcome, ToolOutcome::Rejected);
    assert!(invalid_result.content.contains("playlist_invalid"));
}

#[test]
fn playlist_picker_degrades_a_rejected_thumbnail_fetch_to_no_image() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::with_answers([vec!["S0000000000".into()]]);
    let thumbnail_failure = ScriptedPlaylistIo::new([Ok(playlist_payload(entries(1, true)))])
        .with_thumbnail(Err(CaptureError::ThumbnailRejected(
            "thumbnail request returned 404".into(),
        )));
    let thumbnail_result = call(
        vault.path(),
        &retriever,
        &thumbnail_failure,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );
    assert_eq!(thumbnail_result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&thumbnail_result.content).unwrap();
    assert_eq!(
        value["annotations"],
        serde_json::json!([
            "thumbnail unavailable for video 'S0000000000' (thumbnail_rejected); continued without an image"
        ])
    );
    let seen = prompt.seen.lock().unwrap();
    assert_eq!(seen[0].options[0].image_data_uri, None);
}

#[test]
fn playlist_picker_keeps_a_blocked_thumbnail_fetch_terminal() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::default();
    let io = ScriptedPlaylistIo::new([Ok(playlist_payload(entries(1, true)))]).with_thumbnail(Err(
        CaptureError::YoutubeBlocked("YouTube blocked the thumbnail request".into()),
    ));
    let mut session = YoutubeToolSession::default();

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut session,
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["error"]["kind"], "youtube_blocked");
    assert_eq!(value["error"]["next_action"], "terminal");
    assert!(session.terminal_error().is_some());
    assert!(prompt.seen.lock().unwrap().is_empty());
}

#[test]
fn playlist_picker_degrades_an_oversized_mqdefault_thumbnail_to_no_image() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::with_answers([vec!["S0000000000".into()]]);
    let mut bytes = vec![0; 256 * 1_024 + 1];
    bytes[..3].copy_from_slice(&[0xff, 0xd8, 0xff]);
    let end = bytes.len();
    bytes[end - 2..].copy_from_slice(&[0xff, 0xd9]);
    let io = ScriptedPlaylistIo::new([Ok(playlist_payload(entries(1, true)))]).with_thumbnail(Ok(
        ThumbnailPayload {
            media_type: "image/jpeg".into(),
            bytes,
        },
    ));

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert!(result.content.contains("thumbnail_rejected"));
    let seen = prompt.seen.lock().unwrap();
    assert_eq!(seen[0].options[0].image_data_uri, None);
}

#[test]
fn playlist_picker_accepts_bounded_png_and_webp_thumbnails() {
    let cases = [
        ("image/png", valid_png_bytes()),
        ("image/webp", valid_webp_bytes()),
    ];
    for (media_type, thumbnail) in cases {
        let vault = tempfile::tempdir().unwrap();
        let retriever = KeywordRetriever::new(vault.path());
        let profile = MemoryProfileIo::default();
        let prompt = ScriptedPrompt::with_answers([vec!["UF8uR6Z6KLc".into()]]);
        let io = PlaylistIo {
            media_type: media_type.into(),
            thumbnail,
        };

        let result = call(
            vault.path(),
            &retriever,
            &io,
            &mut YoutubeToolSession::default(),
            &profile,
            &prompt,
            TOOL_SELECT_PLAYLIST_VIDEOS,
            r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-safe_123"}"#,
        );

        assert_eq!(result.outcome, ToolOutcome::Action, "{media_type}");
        let seen = prompt.seen.lock().unwrap();
        assert!(seen[0].options[0]
            .image_data_uri
            .as_deref()
            .unwrap()
            .starts_with(&format!("data:{media_type};base64,")));
    }
}

#[test]
fn playlist_picker_rejects_a_webp_riff_length_that_cannot_match_the_payload() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::with_answers([vec!["S0000000000".into()]]);
    let mut bytes = valid_webp_bytes();
    bytes[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    let io = ScriptedPlaylistIo::new([Ok(playlist_payload(entries(1, true)))]).with_thumbnail(Ok(
        ThumbnailPayload {
            media_type: "image/webp".into(),
            bytes,
        },
    ));

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert!(result.content.contains("thumbnail_rejected"));
    let seen = prompt.seen.lock().unwrap();
    assert_eq!(seen[0].options[0].image_data_uri, None);
}

#[test]
fn playlist_picker_degrades_an_unrecognised_thumbnail_type_to_no_image() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let prompt = ScriptedPrompt::with_answers([vec!["UF8uR6Z6KLc".into()]]);
    let io = PlaylistIo {
        media_type: "image/gif".into(),
        thumbnail: b"GIF89a".to_vec(),
    };

    let result = call(
        vault.path(),
        &retriever,
        &io,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-safe_123"}"#,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert!(result.content.contains("thumbnail_rejected"));
    let seen = prompt.seen.lock().unwrap();
    assert!(seen[0]
        .options
        .iter()
        .all(|option| option.image_data_uri.is_none()));
}

#[test]
fn high_usage_selection_requires_pricing_and_estimates_unknown_durations_conservatively() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let profile = MemoryProfileIo::default();
    let selected = (0..21)
        .map(|index| format!("V{index:010}"))
        .collect::<Vec<_>>();
    let prompt = ScriptedPrompt::with_answers([selected, Vec::new()]);
    let mut writes = WriteSession::new(1).unwrap();
    let mut session = YoutubeToolSession::default();
    let missing_pricing = call_configured(
        vault.path(),
        &retriever,
        &PagedPlaylistIo::default(),
        &mut session,
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-paged_123"}"#,
        &mut writes,
        None,
        true,
    );
    assert_eq!(missing_pricing.outcome, ToolOutcome::Rejected);
    assert!(missing_pricing.content.contains("requirement_missing"));

    let selected = (0..21)
        .map(|index| format!("S{index:010}"))
        .collect::<Vec<_>>();
    let prompt = ScriptedPrompt::with_answers([selected, vec!["continue".into()]]);
    let missing_duration = ScriptedPlaylistIo::new([Ok(playlist_payload(entries(21, false)))]);
    let result = call(
        vault.path(),
        &retriever,
        &missing_duration,
        &mut YoutubeToolSession::default(),
        &profile,
        &prompt,
        TOOL_SELECT_PLAYLIST_VIDEOS,
        r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-scripted_123"}"#,
    );
    assert_eq!(result.outcome, ToolOutcome::Action);
    let seen = prompt.seen.lock().unwrap();
    let warning = &seen[1].question;
    assert!(
        warning.contains("21 videos have unknown durations"),
        "{warning}"
    );
    assert!(warning.contains("60 minutes each"), "{warning}");
    assert!(
        warning.contains("conservative duration assumption"),
        "{warning}"
    );
    assert!(
        !warning.contains("Rough estimate: 0 input tokens"),
        "{warning}"
    );
}

#[test]
fn high_usage_confirmation_surfaces_cancel_and_no_response() {
    let selected = (0..21)
        .map(|index| format!("V{index:010}"))
        .collect::<Vec<_>>();
    for (confirmation, expected) in [
        (Some(vec!["cancel".into()]), "cancelled"),
        (None, "playlist confirmation failed"),
    ] {
        let vault = tempfile::tempdir().unwrap();
        let retriever = KeywordRetriever::new(vault.path());
        let profile = MemoryProfileIo::default();
        let mut answers = vec![selected.clone(), Vec::new()];
        if let Some(confirmation) = confirmation {
            answers.push(confirmation);
        }
        let prompt = ScriptedPrompt::with_answers(answers);

        let result = call(
            vault.path(),
            &retriever,
            &PagedPlaylistIo::default(),
            &mut YoutubeToolSession::default(),
            &profile,
            &prompt,
            TOOL_SELECT_PLAYLIST_VIDEOS,
            r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-paged_123"}"#,
        );

        assert_eq!(result.outcome, ToolOutcome::Rejected);
        assert!(result.content.contains(expected), "{}", result.content);
    }
}
