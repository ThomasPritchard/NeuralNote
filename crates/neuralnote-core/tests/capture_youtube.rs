use neuralnote_core::capture::youtube::{
    classify_ytdlp_failure, parse_playlist, parse_video_metadata, validate_thumbnail,
    validate_youtube_timestamp_url, CaptionSource, VideoId, YoutubeUrl, MAX_METADATA_JSON_BYTES,
    MAX_PLAYLIST_ENTRIES, MAX_PLAYLIST_JSON_BYTES,
};
use neuralnote_core::capture::CaptureError;
use std::io::Cursor;

const VIDEO_ID: &str = "iG9CE55wbtY";

fn encoded_image(format: image::ImageFormat, width: u32, height: u32) -> Vec<u8> {
    let image = image::DynamicImage::new_rgb8(width, height);
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, format).unwrap();
    bytes.into_inner()
}

#[test]
fn youtube_timestamp_url_accepts_only_the_renderer_owned_shape() {
    assert_eq!(
        validate_youtube_timestamp_url("https://youtu.be/iG9CE55wbtY?t=872").unwrap(),
        "https://youtu.be/iG9CE55wbtY?t=872"
    );
    for value in [
        "http://youtu.be/iG9CE55wbtY?t=872",
        "https://user@youtu.be/iG9CE55wbtY?t=872",
        "https://youtu.be/iG9CE55wbtY?t=872&x=1",
        "https://youtu.be/iG9CE55wbtY?t=-1",
        "https://youtu.be/iG9CE55wbtY?t=99999999999",
        "https://youtu.be/iG9CE55wbtY?t=1#fragment",
        "https://youtu.be/iG9CE55wbtY/extra?t=1",
    ] {
        assert!(validate_youtube_timestamp_url(value).is_err(), "{value}");
    }
}

#[test]
fn thumbnail_validation_is_shared_at_the_untrusted_io_boundary() {
    let jpeg = encoded_image(image::ImageFormat::Jpeg, 2, 2);

    assert!(validate_thumbnail("image/jpeg", &jpeg).is_ok());
    assert!(matches!(
        validate_thumbnail("image/jpeg", b"not an image"),
        Err(CaptureError::ThumbnailRejected(_))
    ));
}

#[test]
fn thumbnail_validation_decodes_allowed_formats_and_rejects_header_spoofs() {
    for (media_type, format) in [
        ("image/jpeg", image::ImageFormat::Jpeg),
        ("image/png", image::ImageFormat::Png),
        ("image/webp", image::ImageFormat::WebP),
    ] {
        let bytes = encoded_image(format, 2, 2);
        assert!(
            validate_thumbnail(media_type, &bytes).is_ok(),
            "{media_type}"
        );
    }
    assert!(validate_thumbnail("image/jpeg", &[0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]).is_err());
    let jpeg = encoded_image(image::ImageFormat::Jpeg, 2, 2);
    assert!(validate_thumbnail("image/png", &jpeg).is_err());
}

#[test]
fn thumbnail_validation_rejects_excessive_dimensions_before_data_uri_projection() {
    let wide = encoded_image(image::ImageFormat::Png, 1_025, 1);
    assert!(wide.len() < neuralnote_core::capture::MAX_THUMBNAIL_BYTES);
    assert!(validate_thumbnail("image/png", &wide).is_err());
}

#[test]
fn video_id_newtype_accepts_exactly_the_url_safe_eleven_character_grammar() {
    for valid in [VIDEO_ID, "-abcdefghij", "_0123456789"] {
        let id = VideoId::new(valid).unwrap();
        assert_eq!(id.as_ref(), valid);
        assert_eq!(id.to_string(), valid);
    }
    for invalid in ["short", "abcdefghij!", "abcdefghijkl", "abcdefghij/"] {
        assert!(matches!(
            VideoId::new(invalid),
            Err(CaptureError::InvalidSource(_))
        ));
    }
}

#[test]
fn youtube_url_newtype_rejects_all_whitespace_and_shell_suffixes() {
    for invalid in [
        "https://www.youtube.com/watch?v=x $(rm -rf ~)",
        "https://www.youtube.com/watch?v=iG9CE55wbtY\t",
        "https://youtu.be/iG9CE55wbtY\n",
        "https://youtu.be/iG9CE55wbtY\u{00a0}",
    ] {
        assert!(matches!(
            YoutubeUrl::new(invalid),
            Err(CaptureError::InvalidSource(_))
        ));
    }

    let url = YoutubeUrl::new("https://youtu.be/iG9CE55wbtY").unwrap();
    assert_eq!(url.as_ref(), "https://youtu.be/iG9CE55wbtY");
    assert_eq!(url.to_string(), "https://youtu.be/iG9CE55wbtY");
}

fn metadata_json(subtitles: &str, automatic: &str) -> Vec<u8> {
    format!(
        r#"{{
            "id":"{VIDEO_ID}",
            "title":"Do schools kill creativity?",
            "uploader":"TED",
            "duration":123.0,
            "upload_date":"20070107",
            "webpage_url":"https://www.youtube.com/watch?v={VIDEO_ID}",
            "subtitles":{subtitles},
            "automatic_captions":{automatic},
            "formats":[{{"format_id":"140","ext":"m4a","acodec":"mp4a.40.2"}}],
            "future_yt_dlp_field":{{"ignored":true}}
        }}"#
    )
    .into_bytes()
}

#[test]
fn metadata_parser_returns_bounded_sanitized_fields() {
    let parsed = parse_video_metadata(&metadata_json(
        r#"{"en":[{"ext":"vtt","url":"https://captions.example/en"}]}"#,
        r#"{"fr":[{"ext":"vtt","url":"https://captions.example/fr"}]}"#,
    ))
    .unwrap();

    assert_eq!(parsed.video_id, VIDEO_ID);
    assert_eq!(parsed.title, "Do schools kill creativity?");
    assert_eq!(parsed.channel.as_deref(), Some("TED"));
    assert_eq!(parsed.duration_seconds, Some(123));
    assert_eq!(parsed.upload_date.as_deref(), Some("20070107"));
    assert_eq!(
        parsed.canonical_url,
        format!("https://www.youtube.com/watch?v={VIDEO_ID}")
    );
    assert_eq!(parsed.captions.human_languages(), ["en"]);
    assert_eq!(parsed.captions.automatic_languages(), ["fr"]);
}

#[test]
fn caption_selection_prefers_human_then_exact_then_base_variant() {
    let parsed = parse_video_metadata(&metadata_json(
        r#"{"en":[{"ext":"vtt"}],"en-GB":[{"ext":"vtt"}]}"#,
        r#"{"en-US":[{"ext":"vtt"}]}"#,
    ))
    .unwrap();

    let exact = parsed.captions.select("en-GB").unwrap();
    assert_eq!(exact.language, "en-GB");
    assert_eq!(exact.source, CaptionSource::Human);
    assert_eq!(exact.provenance(), "captions:en-GB");

    let base = parsed.captions.select("en-US").unwrap();
    assert_eq!(base.language, "en");
    assert_eq!(base.source, CaptionSource::Human);
}

#[test]
fn automatic_caption_provenance_is_explicit() {
    let parsed = parse_video_metadata(&metadata_json("{}", r#"{"en":[{"ext":"vtt"}]}"#)).unwrap();
    let selected = parsed.captions.select("en").unwrap();

    assert_eq!(selected.source, CaptionSource::Automatic);
    assert_eq!(selected.provenance(), "captions:en-auto");
}

#[test]
fn captions_are_absent_only_when_both_real_inventories_are_empty() {
    let empty = parse_video_metadata(&metadata_json("{}", "{}")).unwrap();
    assert!(empty.captions.is_genuinely_absent());

    let empty_tracks = parse_video_metadata(&metadata_json(r#"{"en":[]}"#, "{}")).unwrap();
    assert!(empty_tracks.captions.is_genuinely_absent());

    let other_language =
        parse_video_metadata(&metadata_json(r#"{"de":[{"ext":"vtt"}]}"#, "{}")).unwrap();
    assert!(!other_language.captions.is_genuinely_absent());
    assert_eq!(other_language.captions.select("en"), None);
}

#[test]
fn metadata_parser_rejects_each_missing_caption_inventory_as_unproven_absence() {
    for raw in [
        br#"{
            "id":"iG9CE55wbtY",
            "title":"Missing automatic inventory",
            "subtitles":{}
        }"#
        .as_slice(),
        br#"{
            "id":"iG9CE55wbtY",
            "title":"Missing human inventory",
            "automatic_captions":{}
        }"#
        .as_slice(),
    ] {
        assert_eq!(
            parse_video_metadata(raw),
            Err(CaptureError::InvalidMetadata(
                "caption inventories missing; absence not proven".into()
            ))
        );
    }
}

#[test]
fn metadata_parser_rejects_both_missing_caption_inventories_as_unproven_absence() {
    let raw = br#"{
        "id":"iG9CE55wbtY",
        "title":"No caption inventory fields"
    }"#;

    assert_eq!(
        parse_video_metadata(raw),
        Err(CaptureError::InvalidMetadata(
            "caption inventories missing; absence not proven".into()
        ))
    );
}

#[test]
fn metadata_parser_rejects_malformed_invalid_and_oversized_input() {
    for raw in [
        br#"{"title":"missing id"}"#.as_slice(),
        br#"{"id":"short","title":"bad id","subtitles":{},"automatic_captions":{}}"#.as_slice(),
        br#"{"id":"iG9CE55wbtY","title":"   ","subtitles":{},"automatic_captions":{}}"#.as_slice(),
        br#"{"id":"iG9CE55wbtY","title":"x","duration":-1,"subtitles":{},"automatic_captions":{}}"#.as_slice(),
        br#"{"id":"iG9CE55wbtY","title":"x","upload_date":"2026-01-01","subtitles":{},"automatic_captions":{}}"#.as_slice(),
        b"{not json".as_slice(),
    ] {
        assert!(matches!(
            parse_video_metadata(raw),
            Err(CaptureError::InvalidMetadata(_))
        ));
    }

    let oversized = vec![b' '; MAX_METADATA_JSON_BYTES + 1];
    assert!(matches!(
        parse_video_metadata(&oversized),
        Err(CaptureError::InvalidMetadata(message)) if message.contains("byte limit")
    ));
}

#[test]
fn metadata_parser_rejects_invalid_track_shapes_and_calendar_dates() {
    let invalid_track = metadata_json(r#"{"en":[null]}"#, "{}");
    let impossible_date = br#"{
        "id":"iG9CE55wbtY",
        "title":"Impossible date",
        "upload_date":"20261340",
        "subtitles":{},
        "automatic_captions":{}
    }"#;

    for raw in [invalid_track.as_slice(), impossible_date.as_slice()] {
        assert!(matches!(
            parse_video_metadata(raw),
            Err(CaptureError::InvalidMetadata(_))
        ));
    }
}

#[test]
fn spike_po_token_and_block_shapes_are_terminal_block_errors() {
    let spike = r#"WARNING: [youtube] iG9CE55wbtY: Some web client subtitles require a PO Token which was not provided.
WARNING: [youtube] iG9CE55wbtY: There are missing subtitles languages because a PO token was not provided.
WARNING: Only images are available for download. use --list-formats to see them
ERROR: [youtube] iG9CE55wbtY: Requested format is not available."#;

    for output in [
        spike,
        "ERROR: unable to download video data: HTTP Error 403: Forbidden",
        "ERROR: server returned 403 Forbidden while fetching captions",
        "ERROR: [youtube] Sign in to confirm you're not a bot",
    ] {
        assert!(matches!(
            classify_ytdlp_failure(output),
            CaptureError::YoutubeBlocked(_)
        ));
    }
}

#[test]
fn rate_limit_diagnostics_are_terminal_block_errors() {
    for output in [
        "ERROR: unable to download webpage: HTTP Error 429: Too Many Requests",
        "ERROR: server returned HTTP 429 while fetching captions",
        "ERROR: 429 Too Many Requests",
        "ERROR: YouTube request was rate-limited",
        "ERROR: YouTube rate limit exceeded",
    ] {
        assert!(matches!(
            classify_ytdlp_failure(output),
            CaptureError::YoutubeBlocked(_)
        ));
    }
}

#[test]
fn terminal_and_pot_markers_take_precedence_over_stale_extractor_markers() {
    assert!(matches!(
        classify_ytdlp_failure("PO token provider failed: timeout; ERROR: nsig extraction failed"),
        CaptureError::PotUnavailable(_)
    ));
    assert!(matches!(
        classify_ytdlp_failure(
            "ERROR: signature extraction failed after HTTP Error 429: Too Many Requests"
        ),
        CaptureError::YoutubeBlocked(_)
    ));
}

#[test]
fn terminal_block_at_the_end_of_long_diagnostics_is_not_hidden_by_the_scan_bound() {
    let output = format!(
        "{}\nERROR: [youtube] id: HTTP Error 403: Forbidden",
        "verbose extractor prelude\n".repeat(4_000)
    );

    assert!(matches!(
        classify_ytdlp_failure(&output),
        CaptureError::YoutubeBlocked(_)
    ));
}

#[test]
fn terminal_block_in_the_middle_of_long_diagnostics_is_still_terminal() {
    let output = format!(
        "{}HTTP Error 403: Forbidden{}",
        "x".repeat(40 * 1_024),
        "y".repeat(40 * 1_024)
    );

    assert!(matches!(
        classify_ytdlp_failure(&output),
        CaptureError::YoutubeBlocked(_)
    ));
}

#[test]
fn classifier_does_not_mistake_successful_pot_logging_for_a_pot_failure() {
    let output = r#"[youtube] [pot:bgutil:http] Generating a gvs PO Token for web client via bgutil HTTP server
ERROR: [youtube] Requested format is not available."#;

    assert!(matches!(
        classify_ytdlp_failure(output),
        CaptureError::MetadataUnavailable(_)
    ));
    assert!(matches!(
        classify_ytdlp_failure("ERROR: [Errno 2] No such file or directory: 'bgutil-pot'"),
        CaptureError::PotUnavailable(_)
    ));
}

#[test]
fn classifier_distinguishes_pot_extractor_and_generic_failures() {
    assert!(matches!(
        classify_ytdlp_failure(
            "ERROR rustypipe_botguard: http: error sending request for url (https://www.youtube.com/api/jnn/v1/Create)"
        ),
        CaptureError::PotUnavailable(_)
    ));
    assert!(matches!(
        classify_ytdlp_failure("ERROR: [youtube] nsig extraction failed: You may want to update"),
        CaptureError::ExtractorStale(_)
    ));
    assert!(matches!(
        classify_ytdlp_failure("ERROR: socket closed while reading metadata"),
        CaptureError::MetadataUnavailable(_)
    ));
    assert!(
        matches!(
            classify_ytdlp_failure("There are no subtitles for the requested languages"),
            CaptureError::MetadataUnavailable(_)
        ),
        "stderr alone cannot prove both inventories were empty"
    );
}

#[test]
fn classifier_bounds_untrusted_diagnostic_text() {
    let error = classify_ytdlp_failure(&"x".repeat(1024 * 1024));
    assert_eq!(
        error,
        CaptureError::MetadataUnavailable("yt-dlp could not inspect YouTube metadata".into())
    );
}

#[test]
fn bounded_non_terminal_scan_intentionally_degrades_when_marker_is_only_in_the_middle() {
    let output = format!(
        "{}nsig extraction failed{}",
        "h".repeat(40 * 1024),
        "t".repeat(40 * 1024)
    );

    assert!(matches!(
        classify_ytdlp_failure(&output),
        CaptureError::MetadataUnavailable(_)
    ));
}

fn playlist_json(entries: &str) -> Vec<u8> {
    format!(
        r#"{{"_type":"playlist","id":"PL-safe_123","title":"Useful talks","entries":{entries},"ignored":true}}"#
    )
    .into_bytes()
}

#[test]
fn playlist_parser_validates_and_deduplicates_in_source_order() {
    let parsed = parse_playlist(&playlist_json(
        r#"[
            {"_type":"url","id":"iG9CE55wbtY","title":"First","duration":10},
            {"_type":"url","id":"UF8uR6Z6KLc","title":"Second","duration":20.4},
            {"_type":"url","id":"iG9CE55wbtY","title":"Duplicate ignored","duration":10}
        ]"#,
    ))
    .unwrap();

    assert_eq!(parsed.playlist_id, "PL-safe_123");
    assert_eq!(parsed.title, "Useful talks");
    assert_eq!(parsed.entries.len(), 2);
    assert_eq!(parsed.unavailable_entries_skipped, 0);
    assert_eq!(parsed.entries[0].video_id, "iG9CE55wbtY");
    assert_eq!(parsed.entries[1].video_id, "UF8uR6Z6KLc");
    assert_eq!(
        parsed.entries[1].canonical_url,
        "https://www.youtube.com/watch?v=UF8uR6Z6KLc"
    );
    assert_eq!(parsed.entries[1].duration_seconds, Some(20));
}

#[test]
fn playlist_parser_skips_unavailable_entries_and_reports_the_count() {
    let parsed = parse_playlist(&playlist_json(
        r#"[
            null,
            {"_type":"url","id":"iG9CE55wbtY","title":"First","duration":10},
            null,
            {"_type":"url","id":"UF8uR6Z6KLc","title":"Second","duration":20}
        ]"#,
    ))
    .unwrap();

    assert_eq!(parsed.unavailable_entries_skipped, 2);
    assert_eq!(
        parsed
            .entries
            .iter()
            .map(|entry| entry.video_id.as_str())
            .collect::<Vec<_>>(),
        ["iG9CE55wbtY", "UF8uR6Z6KLc"]
    );
}

#[test]
fn playlist_parser_rejects_when_every_entry_is_unavailable() {
    assert_eq!(
        parse_playlist(&playlist_json("[null,null]")),
        Err(CaptureError::PlaylistInvalid(
            "playlist contains no available entries; skipped 2 unavailable playlist entries".into()
        ))
    );
}

#[test]
fn playlist_parser_rejects_empty_bad_entries_and_bounds() {
    for raw in [
        playlist_json("[]"),
        playlist_json(r#"[{"id":"short","title":"Bad"}]"#),
        playlist_json(r#"[{"id":"iG9CE55wbtY","title":" "}]"#),
        br#"{"_type":"video","id":"PLx","title":"Wrong","entries":[]}"#.to_vec(),
    ] {
        assert!(matches!(
            parse_playlist(&raw),
            Err(CaptureError::PlaylistInvalid(_))
        ));
    }

    let entry = r#"{"id":"iG9CE55wbtY","title":"Repeated"}"#;
    let too_many = playlist_json(&format!(
        "[{}]",
        vec![entry; MAX_PLAYLIST_ENTRIES + 1].join(",")
    ));
    assert!(matches!(
        parse_playlist(&too_many),
        Err(CaptureError::PlaylistInvalid(message)) if message.contains("entry limit")
    ));

    let oversized = vec![b' '; MAX_PLAYLIST_JSON_BYTES + 1];
    assert!(matches!(
        parse_playlist(&oversized),
        Err(CaptureError::PlaylistInvalid(message)) if message.contains("byte limit")
    ));
}
