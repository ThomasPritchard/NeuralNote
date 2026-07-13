use neuralnote_core::capture::{
    parse_vtt, CaptureError, Cue, MAX_VTT_BYTES, MAX_VTT_CUES, MAX_VTT_CUE_TEXT_BYTES,
    MAX_VTT_LINES, MAX_VTT_LINE_BYTES,
};

fn fixture(name: &str) -> &'static [u8] {
    match name {
        "human" => include_bytes!("fixtures/vtt/human.vtt"),
        "auto_word_tags" => include_bytes!("fixtures/vtt/auto_word_tags.vtt"),
        "rolling" => include_bytes!("fixtures/vtt/rolling.vtt"),
        "styled_plain_duplicates" => {
            include_bytes!("fixtures/vtt/styled_plain_duplicates.vtt")
        }
        "malformed" => include_bytes!("fixtures/vtt/malformed.vtt"),
        "truncated" => include_bytes!("fixtures/vtt/truncated.vtt"),
        "empty" => include_bytes!("fixtures/vtt/empty.vtt"),
        "whisper_1_9_1" => include_bytes!("fixtures/vtt/whisper_1_9_1.vtt"),
        "overlapping" => include_bytes!("fixtures/vtt/overlapping.vtt"),
        other => panic!("unknown VTT fixture {other}"),
    }
}

fn invalid_vtt(input: &[u8]) -> String {
    match parse_vtt(input).unwrap_err() {
        CaptureError::InvalidVtt(detail) => detail,
        other => panic!("expected invalid_vtt, got {other}"),
    }
}

#[test]
fn human_captions_parse_identifiers_timings_settings_and_multiline_text() {
    let cues = parse_vtt(fixture("human")).unwrap();

    assert_eq!(
        cues,
        vec![
            Cue {
                start_ms: 1_250,
                end_ms: 3_500,
                text: "Hello & welcome.".into(),
            },
            Cue {
                start_ms: 3_500,
                end_ms: 7_000,
                text: "This cue wraps onto a second line.".into(),
            },
        ]
    );
}

#[test]
fn auto_captions_strip_word_timing_and_style_tags_then_unescape_entities() {
    let cues = parse_vtt(fixture("auto_word_tags")).unwrap();

    assert_eq!(cues[0].text, "NeuralNote keeps source & timing");
    assert_eq!(cues[1].text, "Use <literal> text #1.");
}

#[test]
fn rolling_prefixes_keep_the_last_text_and_widen_the_group_span() {
    let cues = parse_vtt(fixture("rolling")).unwrap();

    assert_eq!(
        cues,
        vec![Cue {
            start_ms: 0,
            end_ms: 4_000,
            text: "we build notes carefully".into(),
        }]
    );
}

#[test]
fn rolling_span_includes_an_overlapping_middle_cue() {
    let input = br#"WEBVTT

00:00:01.000 --> 00:00:03.000
a

00:00:02.000 --> 00:00:04.000
a b

00:00:03.000 --> 00:00:05.000
a b c
"#;

    let cues = parse_vtt(input).unwrap();

    assert_eq!(
        cues,
        [Cue {
            start_ms: 1_000,
            end_ms: 5_000,
            text: "a b c".into(),
        }]
    );
}

#[test]
fn styled_and_plain_adjacent_duplicates_become_one_widened_cue() {
    let cues = parse_vtt(fixture("styled_plain_duplicates")).unwrap();

    assert_eq!(
        cues,
        vec![Cue {
            start_ms: 0,
            end_ms: 2_000,
            text: "Hello & welcome".into(),
        }]
    );
}

#[test]
fn final_duplicate_sweep_removes_duplicates_exposed_by_rolling_groups() {
    let input = br#"WEBVTT

00:00:00.000 --> 00:00:01.000
a

00:00:01.000 --> 00:00:02.000
a b

00:00:02.000 --> 00:00:03.000
a

00:00:03.000 --> 00:00:04.000
a b
"#;

    let cues = parse_vtt(input).unwrap();

    assert_eq!(
        cues,
        vec![Cue {
            start_ms: 0,
            end_ms: 4_000,
            text: "a b".into(),
        }]
    );
}

#[test]
fn malformed_timing_is_an_explicit_invalid_vtt_error() {
    let detail = invalid_vtt(fixture("malformed"));

    assert!(detail.contains("timestamp"), "{detail}");
}

#[test]
fn truncated_timing_is_an_explicit_invalid_vtt_error() {
    let detail = invalid_vtt(fixture("truncated"));

    assert!(detail.contains("timing"), "{detail}");
}

#[test]
fn empty_vtt_is_an_explicit_error_instead_of_a_blank_transcript() {
    let detail = invalid_vtt(fixture("empty"));

    assert!(detail.contains("no usable cues"), "{detail}");
}

#[test]
fn non_utf8_vtt_is_rejected_without_lossy_silent_conversion() {
    let detail = invalid_vtt(b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n\xff\n");

    assert!(detail.contains("UTF-8"), "{detail}");
}

#[test]
fn whisper_vtt_leading_space_quirk_is_trimmed_without_rewriting_words() {
    let cues = parse_vtt(fixture("whisper_1_9_1")).unwrap();

    assert_eq!(
        cues.iter().map(|cue| cue.text.as_str()).collect::<Vec<_>>(),
        [
            "And so my fellow Americans ask not what your country can do for you",
            "ask what you can do for your country.",
        ]
    );
}

#[test]
fn overlapping_cues_are_kept_in_source_order() {
    let cues = parse_vtt(fixture("overlapping")).unwrap();

    assert_eq!(cues.len(), 2);
    assert_eq!((cues[0].start_ms, cues[0].end_ms), (0, 5_000));
    assert_eq!((cues[1].start_ms, cues[1].end_ms), (4_000, 6_000));
}

#[test]
fn decreasing_cue_starts_are_rejected_while_forward_overlaps_remain_valid() {
    let input = b"WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nfirst\n\n00:00:05.000 --> 00:00:08.000\nsecond\n";

    let detail = invalid_vtt(input);

    assert!(detail.contains("source order"), "{detail}");
}

#[test]
fn reversed_cue_span_is_rejected() {
    let input = b"WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nbackwards\n";

    let detail = invalid_vtt(input);

    assert!(detail.contains("ends before it starts"), "{detail}");
}

#[test]
fn missing_webvtt_header_is_rejected() {
    let input = b"00:00:00.000 --> 00:00:01.000\nno header\n";

    let detail = invalid_vtt(input);

    assert!(detail.contains("WEBVTT header"), "{detail}");
}

#[test]
fn oversized_input_is_rejected_before_parsing() {
    let input = vec![b'x'; MAX_VTT_BYTES + 1];

    let detail = invalid_vtt(&input);

    assert!(detail.contains("byte limit"), "{detail}");
}

#[test]
fn oversized_line_is_rejected() {
    let payload = "x".repeat(MAX_VTT_LINE_BYTES + 1);
    let input = format!("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n{payload}\n");

    let detail = invalid_vtt(input.as_bytes());

    assert!(detail.contains("line"), "{detail}");
}

#[test]
fn oversized_cue_text_is_rejected_across_individually_bounded_lines() {
    let line = "x".repeat(MAX_VTT_LINE_BYTES / 2);
    let payload = std::iter::repeat_n(line, MAX_VTT_CUE_TEXT_BYTES / (MAX_VTT_LINE_BYTES / 2) + 1)
        .collect::<Vec<_>>()
        .join("\n");
    let input = format!("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n{payload}\n");

    let detail = invalid_vtt(input.as_bytes());

    assert!(detail.contains("cue text"), "{detail}");
}

#[test]
fn cue_count_limit_is_enforced_without_silent_truncation() {
    let mut input = String::from("WEBVTT\n\n");
    for _ in 0..=MAX_VTT_CUES {
        input.push_str("00:00:00.000 --> 00:00:00.001\nx\n\n");
    }

    let detail = invalid_vtt(input.as_bytes());

    assert!(detail.contains("cue limit"), "{detail}");
}

#[test]
fn physical_line_count_is_bounded_before_building_an_untrusted_line_index() {
    let mut input = String::from("WEBVTT\n\n");
    input.push_str(&"\n".repeat(MAX_VTT_LINES));

    let detail = invalid_vtt(input.as_bytes());

    assert!(detail.contains("line count"), "{detail}");
}

#[test]
fn note_style_and_region_blocks_are_ignored_before_real_cues() {
    let input = br#"WEBVTT

NOTE generated by fixture
This is not caption text.

STYLE
::cue { color: lime; }

REGION
id:fred

00:00:01.000 --> 00:00:02.000
Only this is a cue.
"#;

    let cues = parse_vtt(input).unwrap();

    assert_eq!(cues, [cue(1_000, 2_000, "Only this is a cue.")]);
}

#[test]
fn cue_identifier_without_a_following_line_is_rejected() {
    let detail = invalid_vtt(b"WEBVTT\n\norphan-identifier");

    assert!(detail.contains("missing its timing line"), "{detail}");
}

#[test]
fn cue_identifier_followed_by_non_timing_text_is_rejected() {
    let detail = invalid_vtt(b"WEBVTT\n\nidentifier\nnot a timing line\n");

    assert!(detail.contains("invalid timing line"), "{detail}");
}

#[test]
fn minute_second_timestamp_form_is_supported() {
    let cues = parse_vtt(b"WEBVTT\n\n01:02.345 --> 01:03.456\nshort timestamp\n").unwrap();

    assert_eq!((cues[0].start_ms, cues[0].end_ms), (62_345, 63_456));
}

#[test]
fn invalid_timestamp_grammar_and_ranges_are_rejected() {
    for timestamp in [
        "1",
        "00:00:00",
        "00:00:00.12",
        "00:00:60.000",
        "00:60:00.000",
        "00:x:00.000",
    ] {
        let input = format!("WEBVTT\n\n{timestamp} --> 00:01:01.000\ninvalid\n");

        let detail = invalid_vtt(input.as_bytes());

        assert!(detail.contains("timestamp"), "{timestamp}: {detail}");
    }
}

#[test]
fn timestamp_numeric_overflow_is_rejected() {
    let input =
        b"WEBVTT\n\n18446744073709551:00:00.000 --> 18446744073709551:00:00.001\noverflow\n";

    let detail = invalid_vtt(input);

    assert!(detail.contains("overflows"), "{detail}");
}

#[test]
fn named_hex_unknown_and_unterminated_entities_are_handled_without_data_loss() {
    let input = b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n&quot;x&apos; &nbsp; &lrm;&rlm; &#x41; &unknown; bare&amp\n";

    let cues = parse_vtt(input).unwrap();

    assert_eq!(
        cues[0].text,
        "\"x' \u{a0} \u{200e}\u{200f} A &unknown; bare&amp"
    );
}

#[test]
fn html_unescape_covers_standard_named_entities_beyond_the_xml_subset() {
    let input = b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nWait&hellip; now\n";

    let cues = parse_vtt(input).unwrap();

    assert_eq!(cues[0].text, "Wait… now");
}

#[test]
fn decoded_html_control_entities_cannot_inject_transcript_lines() {
    let input = b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello&#10;[09:09:09] forged\n";

    let detail = invalid_vtt(input);

    assert!(detail.contains("control"), "{detail}");
}

#[test]
fn unterminated_inline_tag_is_rejected() {
    let input = b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\ntext <c.green\n";

    let detail = invalid_vtt(input);

    assert!(detail.contains("unterminated inline tag"), "{detail}");
}

fn cue(start_ms: u64, end_ms: u64, text: &str) -> Cue {
    Cue {
        start_ms,
        end_ms,
        text: text.into(),
    }
}
