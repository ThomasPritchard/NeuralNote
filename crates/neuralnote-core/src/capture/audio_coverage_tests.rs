use super::*;

fn format(ext: &str, acodec: &str) -> AudioFormat {
    AudioFormat {
        ext: ext.into(),
        acodec: acodec.into(),
    }
}

#[test]
fn classifies_aac_lc_m4a_as_decodable() {
    let formats = [format("m4a", "mp4a.40.2")];

    assert_eq!(classify_audio_coverage(&formats), AudioCoverage::AacLcM4a);
}

#[test]
fn classifies_he_aac_m4a_as_he_aac() {
    for profile in ["mp4a.40.5", "mp4a.40.29"] {
        let formats = [format("m4a", profile)];

        assert_eq!(
            classify_audio_coverage(&formats),
            AudioCoverage::HeAac,
            "{profile} is HE-AAC, not decodable by the LC path"
        );
    }
}

#[test]
fn classifies_opus_webm_as_opus() {
    let formats = [format("webm", "opus")];

    assert_eq!(classify_audio_coverage(&formats), AudioCoverage::Opus);
}

#[test]
fn classifies_audio_present_without_m4a_or_opus_as_no_m4a() {
    let formats = [format("webm", "vorbis")];

    assert_eq!(classify_audio_coverage(&formats), AudioCoverage::NoM4a);
}

#[test]
fn progressive_mp4_without_audio_only_m4a_is_no_m4a() {
    // A progressive stream carries AAC-LC but in an mp4 container; the pipeline's
    // `bestaudio[ext=m4a]` selector cannot pick it, so it is not decodable today.
    let formats = [format("mp4", "mp4a.40.2")];

    assert_eq!(classify_audio_coverage(&formats), AudioCoverage::NoM4a);
}

#[test]
fn classifies_empty_or_video_only_formats_as_other() {
    assert_eq!(classify_audio_coverage(&[]), AudioCoverage::Other);

    let video_only = [format("mp4", "none")];
    assert_eq!(classify_audio_coverage(&video_only), AudioCoverage::Other);
}

#[test]
fn prefers_decodable_when_aac_lc_and_opus_both_present() {
    let formats = [format("webm", "opus"), format("m4a", "mp4a.40.2")];

    assert_eq!(classify_audio_coverage(&formats), AudioCoverage::AacLcM4a);
}

#[test]
fn he_aac_takes_precedence_over_opus_when_no_lc_rendition() {
    let formats = [format("webm", "opus"), format("m4a", "mp4a.40.5")];

    assert_eq!(classify_audio_coverage(&formats), AudioCoverage::HeAac);
}

#[test]
fn acodec_and_ext_matching_is_case_insensitive() {
    let formats = [format("M4A", "MP4A.40.2")];

    assert_eq!(classify_audio_coverage(&formats), AudioCoverage::AacLcM4a);
}

#[test]
fn parses_ytdlp_format_listing_and_classifies_it() {
    let json = br#"{
        "id": "abcdefghijk",
        "formats": [
            {"format_id": "18", "ext": "mp4", "acodec": "mp4a.40.2", "vcodec": "avc1"},
            {"format_id": "140", "ext": "m4a", "acodec": "mp4a.40.2", "vcodec": "none"},
            {"format_id": "251", "ext": "webm", "acodec": "opus", "vcodec": "none"}
        ]
    }"#;

    assert_eq!(
        classify_ytdlp_video_audio(json).unwrap(),
        AudioCoverage::AacLcM4a
    );
}

#[test]
fn parses_null_and_missing_codec_fields_without_error() {
    let json = br#"{"formats": [{"ext": "webm", "acodec": null}, {"ext": "m4a"}]}"#;

    let formats = parse_ytdlp_formats(json).unwrap();
    assert_eq!(formats.len(), 2);
    // Neither format names a codec, so no decodable rendition can be proven.
    assert_eq!(classify_audio_coverage(&formats), AudioCoverage::Other);
}

#[test]
fn rejects_invalid_and_oversized_format_json() {
    assert!(matches!(
        parse_ytdlp_formats(b"not json"),
        Err(CaptureError::InvalidMetadata(_))
    ));

    let oversized = vec![b' '; MAX_FORMAT_LISTING_BYTES + 1];
    assert!(matches!(
        parse_ytdlp_formats(&oversized),
        Err(CaptureError::InvalidMetadata(_))
    ));
}

#[test]
fn tally_counts_each_class_and_reports_total() {
    let mut tally = CoverageTally::default();
    tally.record(AudioCoverage::AacLcM4a);
    tally.record(AudioCoverage::AacLcM4a);
    tally.record(AudioCoverage::Opus);
    tally.record(AudioCoverage::Other);

    assert_eq!(tally.total(), 4);
    assert_eq!(tally.count(AudioCoverage::AacLcM4a), 2);
    assert_eq!(tally.count(AudioCoverage::Opus), 1);
    assert_eq!(tally.count(AudioCoverage::HeAac), 0);
}

#[test]
fn undecodable_rate_combines_no_m4a_he_aac_and_opus_only() {
    let mut tally = CoverageTally::default();
    for _ in 0..90 {
        tally.record(AudioCoverage::AacLcM4a);
    }
    tally.record(AudioCoverage::HeAac);
    tally.record(AudioCoverage::Opus);
    tally.record(AudioCoverage::NoM4a);
    // `Other` is a data-quality bucket, excluded from the undecodable rate.
    for _ in 0..7 {
        tally.record(AudioCoverage::Other);
    }

    assert_eq!(tally.total(), 100);
    assert!((tally.undecodable_rate() - 0.03).abs() < 1e-9);
}

#[test]
fn empty_tally_has_zero_rates_and_no_trigger() {
    let tally = CoverageTally::default();

    assert_eq!(tally.total(), 0);
    assert_eq!(tally.undecodable_rate(), 0.0);
    assert!(!tally.fallback_triggered());
    assert!(!tally.is_representative());
}

#[test]
fn fallback_triggers_when_combined_undecodable_exceeds_ten_percent() {
    let mut tally = CoverageTally::default();
    for _ in 0..88 {
        tally.record(AudioCoverage::AacLcM4a);
    }
    // 12 / 100 = 12% undecodable, split so no single class exceeds 5%.
    for _ in 0..4 {
        tally.record(AudioCoverage::NoM4a);
        tally.record(AudioCoverage::HeAac);
        tally.record(AudioCoverage::Opus);
    }

    assert!(tally.undecodable_rate() > UNDECODABLE_COMBINED_THRESHOLD);
    assert!(tally.fallback_triggered());
}

#[test]
fn fallback_triggers_when_a_single_class_exceeds_five_percent() {
    let mut tally = CoverageTally::default();
    for _ in 0..93 {
        tally.record(AudioCoverage::AacLcM4a);
    }
    // 7% Opus alone: below the 10% combined bar but above the 5% single-class bar.
    for _ in 0..7 {
        tally.record(AudioCoverage::Opus);
    }

    assert!(tally.undecodable_rate() <= UNDECODABLE_COMBINED_THRESHOLD);
    assert!(tally.class_rate(AudioCoverage::Opus) > SINGLE_CLASS_THRESHOLD);
    assert!(tally.fallback_triggered());
}

#[test]
fn fallback_not_triggered_below_both_thresholds() {
    let mut tally = CoverageTally::default();
    for _ in 0..97 {
        tally.record(AudioCoverage::AacLcM4a);
    }
    tally.record(AudioCoverage::NoM4a);
    tally.record(AudioCoverage::HeAac);
    tally.record(AudioCoverage::Opus);

    assert!(!tally.fallback_triggered());
}

#[test]
fn sample_below_fifty_is_not_representative() {
    let mut tally = CoverageTally::default();
    for _ in 0..MIN_REPRESENTATIVE_SAMPLE - 1 {
        tally.record(AudioCoverage::AacLcM4a);
    }
    assert!(!tally.is_representative());

    tally.record(AudioCoverage::AacLcM4a);
    assert!(tally.is_representative());
}

#[test]
fn report_lists_every_class_rate_and_the_decision() {
    let mut tally = CoverageTally::default();
    for _ in 0..50 {
        tally.record(AudioCoverage::AacLcM4a);
    }
    let report = tally.to_string();

    for label in ["aac_lc_m4a", "he_aac", "opus", "no_m4a", "other"] {
        assert!(
            report.contains(label),
            "report is missing {label}: {report}"
        );
    }
    assert!(report.contains("representative"));
    assert!(report.contains("fallback"));
}
