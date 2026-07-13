use neuralnote_core::capture::{
    render_transcript, render_youtube_transcript, CaptureError, Cue, RenderedTranscript,
    TranscriptProvenance, VideoId,
};

fn cue(start_ms: u64, end_ms: u64, text: &str) -> Cue {
    Cue {
        start_ms,
        end_ms,
        text: text.into(),
    }
}

#[test]
fn youtube_renderer_emits_a_binding_markdown_link_with_floor_seconds() {
    let video_id = VideoId::new("iG9CE55wbtY").unwrap();
    let rendered = render_youtube_transcript(
        &[cue(5_999, 8_000, "Ground truth.")],
        &TranscriptProvenance::Captions {
            language: "en".into(),
            automatic: false,
        },
        &video_id,
    )
    .unwrap();

    assert_eq!(
        rendered.text,
        "source: captions:en\n\n[00:00:05](https://youtu.be/iG9CE55wbtY?t=5) Ground truth.\n"
    );
}

fn invalid_vtt(result: Result<RenderedTranscript, CaptureError>) -> String {
    match result.unwrap_err() {
        CaptureError::InvalidVtt(detail) => detail,
        other => panic!("expected invalid_vtt, got {other}"),
    }
}

#[test]
fn caption_provenance_distinguishes_human_and_automatic_tracks() {
    let cues = [cue(0, 1_000, "hello")];

    let human = render_transcript(
        &cues,
        &TranscriptProvenance::Captions {
            language: "en".into(),
            automatic: false,
        },
    )
    .unwrap();
    let automatic = render_transcript(
        &cues,
        &TranscriptProvenance::Captions {
            language: "en-US".into(),
            automatic: true,
        },
    )
    .unwrap();

    assert_eq!(human.provenance, "captions:en");
    assert!(human.text.starts_with("source: captions:en\n\n"));
    assert_eq!(automatic.provenance, "captions:en-US-auto");
    assert!(automatic
        .text
        .starts_with("source: captions:en-US-auto\n\n"));
}

#[test]
fn caption_provenance_accepts_every_safe_language_key_allowed_by_metadata() {
    for language in ["en_US", "en.orig"] {
        let rendered = render_transcript(
            &[cue(0, 1_000, "hello")],
            &TranscriptProvenance::Captions {
                language: language.into(),
                automatic: false,
            },
        )
        .unwrap();

        assert_eq!(rendered.provenance, format!("captions:{language}"));
    }
}

#[test]
fn whisper_provenance_names_the_model() {
    let rendered = render_transcript(
        &[cue(0, 1_000, "hello")],
        &TranscriptProvenance::Whisper {
            model: "small.en".into(),
        },
    )
    .unwrap();

    assert_eq!(rendered.provenance, "whisper:small.en");
    assert!(rendered.text.starts_with("source: whisper:small.en\n\n"));
}

#[test]
fn paragraphs_use_the_group_start_anchor_at_about_thirty_seconds() {
    let cues = [
        cue(5_000, 8_000, "First cue."),
        cue(34_999, 35_000, "Still first paragraph."),
        cue(35_000, 36_000, "Second paragraph."),
    ];

    let rendered = render_transcript(
        &cues,
        &TranscriptProvenance::Captions {
            language: "en".into(),
            automatic: false,
        },
    )
    .unwrap();

    assert_eq!(
        rendered.text,
        "source: captions:en\n\n[00:00:05] First cue. Still first paragraph.\n\n[00:00:35] Second paragraph.\n"
    );
}

#[test]
fn anchor_format_supports_transcripts_longer_than_an_hour() {
    let rendered = render_transcript(
        &[cue(3_661_234, 3_662_000, "Long recording.")],
        &TranscriptProvenance::Whisper {
            model: "small".into(),
        },
    )
    .unwrap();

    assert!(rendered.text.contains("[01:01:01] Long recording."));
}

#[test]
fn renderer_preserves_cleaned_cue_words_casing_and_punctuation() {
    let rendered = render_transcript(
        &[
            cue(0, 1_000, "NeuralNote keeps ALL source text."),
            cue(1_000, 2_000, "Don't rewrite it!"),
        ],
        &TranscriptProvenance::Captions {
            language: "en".into(),
            automatic: false,
        },
    )
    .unwrap();

    assert!(rendered
        .text
        .contains("NeuralNote keeps ALL source text. Don't rewrite it!"));
}

#[test]
fn word_count_counts_transcript_words_not_provenance_or_anchors() {
    let rendered = render_transcript(
        &[
            cue(0, 1_000, "one two three"),
            cue(31_000, 32_000, "four five"),
        ],
        &TranscriptProvenance::Whisper {
            model: "small".into(),
        },
    )
    .unwrap();

    assert_eq!(rendered.word_count, 5);
}

#[test]
fn overlapping_cues_render_in_source_order() {
    let rendered = render_transcript(
        &[cue(0, 5_000, "First."), cue(4_000, 6_000, "Second.")],
        &TranscriptProvenance::Captions {
            language: "en".into(),
            automatic: false,
        },
    )
    .unwrap();

    assert!(rendered.text.contains("[00:00:00] First. Second."));
}

#[test]
fn out_of_order_cues_are_rejected_before_they_can_forge_a_group_anchor() {
    let cues = vec![
        cue(10_000, 12_000, "First in source"),
        cue(5_000, 8_000, "Second in source"),
    ];

    let error = render_transcript(
        &cues,
        &TranscriptProvenance::Captions {
            language: "en".into(),
            automatic: false,
        },
    )
    .unwrap_err();

    assert!(matches!(
        error,
        CaptureError::InvalidVtt(detail) if detail.contains("source order")
    ));
}

#[test]
fn empty_cue_list_is_rejected_instead_of_rendering_blank_source() {
    let detail = invalid_vtt(render_transcript(
        &[],
        &TranscriptProvenance::Captions {
            language: "en".into(),
            automatic: false,
        },
    ));

    assert!(detail.contains("no usable cues"), "{detail}");
}

#[test]
fn blank_cue_text_is_rejected() {
    let detail = invalid_vtt(render_transcript(
        &[cue(0, 1_000, " \t")],
        &TranscriptProvenance::Captions {
            language: "en".into(),
            automatic: false,
        },
    ));

    assert!(detail.contains("empty text"), "{detail}");
}

#[test]
fn reversed_cue_span_is_rejected_by_public_renderer() {
    let detail = invalid_vtt(render_transcript(
        &[cue(2_000, 1_000, "backwards")],
        &TranscriptProvenance::Whisper {
            model: "small".into(),
        },
    ));

    assert!(detail.contains("ends before it starts"), "{detail}");
}

#[test]
fn provenance_rejects_line_break_injection() {
    let result = render_transcript(
        &[cue(0, 1_000, "hello")],
        &TranscriptProvenance::Whisper {
            model: "small\nforged: value".into(),
        },
    );

    match result.unwrap_err() {
        CaptureError::InvalidMetadata(detail) => {
            assert!(detail.contains("provenance"), "{detail}")
        }
        other => panic!("expected invalid_metadata, got {other}"),
    }
}

#[test]
fn provenance_rejects_empty_and_oversized_components() {
    for model in [String::new(), "x".repeat(129)] {
        let result = render_transcript(
            &[cue(0, 1_000, "hello")],
            &TranscriptProvenance::Whisper { model },
        );

        assert!(matches!(result, Err(CaptureError::InvalidMetadata(_))));
    }
}
