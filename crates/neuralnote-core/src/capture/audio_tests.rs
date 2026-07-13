use super::{
    codec_failure, decode_failure, decode_m4a_to_wav, decode_m4a_to_wav_cancellable,
    downmix_packet, encode_pcm_s16le_wav, reference_append_downmixed, require_audio_codec_params,
    require_decoded_audio, resample_to_16khz, validate_aac_codec, validate_audio_spec,
    validate_frame_budget, validate_input_len, validate_resample_capacity,
    validate_resample_counts, write_wav_header, youtube_audio_format_selector,
    StreamingWavResampler, MAX_AUDIO_DURATION_SECONDS, MAX_M4A_BYTES, MAX_RESAMPLED_SAMPLES,
};
use crate::capture::CaptureError;
use symphonia::core::codecs::audio::well_known::{CODEC_ID_AAC, CODEC_ID_PCM_S16LE};
use symphonia::core::codecs::audio::AudioCodecParameters;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::{Error as SymphoniaError, SeekErrorKind};

const AAC_LC_FRAGMENTED: &[u8] = include_bytes!("../../tests/fixtures/audio/aac-lc-fragmented.m4a");
const AAC_LC_TRUNCATED: &[u8] = include_bytes!("../../tests/fixtures/audio/aac-lc-truncated.m4a");

#[test]
fn selector_pins_youtube_aac_lc_m4a() {
    assert_eq!(
        youtube_audio_format_selector(),
        "bestaudio[ext=m4a][acodec^=mp4a.40.2]"
    );
}

#[test]
fn empty_audio_payload_is_unavailable() {
    let error = decode_m4a_to_wav(&[]).unwrap_err();
    assert!(matches!(error, CaptureError::AudioUnavailable(detail) if detail.contains("empty")));
}

#[test]
fn fragmented_aac_lc_decodes_to_whisper_wav() {
    let wav = decode_m4a_to_wav(AAC_LC_FRAGMENTED).unwrap();

    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1);
    assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
    assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
    assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
    assert_eq!(&wav[36..40], b"data");

    let data_len = u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize;
    assert_eq!(wav.len(), 44 + data_len);
    assert!((14_000..=20_000).contains(&data_len));
    assert!(wav[44..]
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
        .any(|sample| sample != 0));
}

#[test]
fn decoding_observes_cancellation_between_audio_packets() {
    let checks = std::cell::Cell::new(0);

    let error = decode_m4a_to_wav_cancellable(AAC_LC_FRAGMENTED, || {
        let next = checks.get() + 1;
        checks.set(next);
        next >= 2
    })
    .unwrap_err();

    assert!(matches!(error, CaptureError::Cancelled(_)));
    assert!(checks.get() >= 2);
}

#[test]
fn truncated_aac_lc_is_rejected_after_container_probe() {
    let error = decode_m4a_to_wav(AAC_LC_TRUNCATED).unwrap_err();

    assert!(
        matches!(
            &error,
            CaptureError::AudioDecodeFailed(detail)
                if detail.contains("decoded zero frames")
        ),
        "unexpected error: {error:?}"
    );
}

#[test]
fn downmix_rejects_zero_channels_without_panicking() {
    let error = downmix_packet(&[0.25], 0, 44_100, 0).unwrap_err();
    assert!(matches!(error, CaptureError::AudioDecodeFailed(_)));
}

#[test]
fn malformed_container_is_a_decode_failure() {
    let error = decode_m4a_to_wav(b"not an M4A container").unwrap_err();
    assert!(matches!(error, CaptureError::AudioDecodeFailed(_)));
}

#[test]
fn input_size_is_bounded_before_decode() {
    assert!(validate_input_len(MAX_M4A_BYTES).is_ok());
    assert!(matches!(
        validate_input_len(MAX_M4A_BYTES + 1),
        Err(CaptureError::AudioDecodeFailed(detail)) if detail.contains("safety limit")
    ));
}

#[test]
fn codec_policy_accepts_aac_and_rejects_other_audio() {
    assert!(validate_aac_codec(CODEC_ID_AAC).is_ok());
    assert!(matches!(
        validate_aac_codec(CODEC_ID_PCM_S16LE),
        Err(CaptureError::UnsupportedAudioCodec(_))
    ));
}

#[test]
fn audio_track_requires_audio_codec_parameters() {
    let params = CodecParameters::Audio(AudioCodecParameters::default());
    assert_eq!(
        require_audio_codec_params(Some(&params)).unwrap().codec,
        AudioCodecParameters::default().codec
    );
    assert!(matches!(
        require_audio_codec_params(None),
        Err(CaptureError::AudioDecodeFailed(detail)) if detail.contains("codec parameters")
    ));
}

#[test]
fn decoded_audio_requires_a_rate_and_at_least_one_frame() {
    assert_eq!(require_decoded_audio(Some(44_100), 1).unwrap(), 44_100);
    assert!(matches!(
        require_decoded_audio(None, 0),
        Err(CaptureError::AudioDecodeFailed(_))
    ));
    assert!(matches!(
        require_decoded_audio(Some(44_100), 0),
        Err(CaptureError::AudioDecodeFailed(_))
    ));
}

#[test]
fn decoded_frame_budget_rejects_overlong_or_overflowing_audio() {
    assert_eq!(
        validate_frame_budget(MAX_AUDIO_DURATION_SECONDS - 1, 1, 1).unwrap(),
        MAX_AUDIO_DURATION_SECONDS
    );
    assert!(matches!(
        validate_frame_budget(MAX_AUDIO_DURATION_SECONDS, 1, 1),
        Err(CaptureError::AudioDecodeFailed(detail)) if detail.contains("safety limit")
    ));
    assert!(matches!(
        validate_frame_budget(usize::MAX, 1, 44_100),
        Err(CaptureError::AudioDecodeFailed(detail)) if detail.contains("overflow")
    ));
}

#[test]
fn decoded_frame_budget_accepts_long_form_audio_beyond_one_hour() {
    let rate = 44_100;
    let one_hour = rate as usize * 60 * 60;

    assert!(validate_frame_budget(one_hour, 1, rate).is_ok());
}

#[test]
fn decoded_format_must_be_stable_mono_or_stereo() {
    assert!(validate_audio_spec(44_100, 1, None, None).is_ok());
    assert!(validate_audio_spec(48_000, 2, Some(48_000), Some(2)).is_ok());

    for result in [
        validate_audio_spec(0, 1, None, None),
        validate_audio_spec(44_100, 0, None, None),
        validate_audio_spec(44_100, 3, None, None),
        validate_audio_spec(48_000, 2, Some(44_100), Some(2)),
        validate_audio_spec(44_100, 1, Some(44_100), Some(2)),
    ] {
        assert!(matches!(result, Err(CaptureError::AudioDecodeFailed(_))));
    }
}

#[test]
fn stereo_downmix_averages_each_frame() {
    let mono = downmix_packet(&[1.0, -1.0, 0.5, 0.25], 2, 44_100, 0).unwrap();
    assert_eq!(mono, [0.0, 0.375]);
}

#[test]
fn downmix_packet_matches_reference_across_packet_boundaries() {
    let interleaved = [1.0, -1.0, 0.5, 0.25, -0.25, 0.75, 0.125, 0.375, 0.0, 1.0];
    let packets = [&interleaved[..4], &interleaved[4..8], &interleaved[8..]];
    let mut reference = Vec::new();
    let mut production = Vec::new();

    for packet in packets {
        reference_append_downmixed(packet, 2, 44_100, &mut reference).unwrap();
        let mono = downmix_packet(packet, 2, 44_100, production.len()).unwrap();
        production.extend(mono);
    }

    let reference = reference
        .into_iter()
        .map(|sample| sample as f32)
        .collect::<Vec<_>>();
    assert_eq!(production, reference);
}

#[test]
fn downmix_rejects_misaligned_or_non_finite_samples() {
    let misaligned = downmix_packet(&[0.1, 0.2, 0.3], 2, 44_100, 0);
    let non_finite = downmix_packet(&[f32::NAN], 1, 44_100, 0);

    assert!(matches!(
        misaligned,
        Err(CaptureError::AudioDecodeFailed(_))
    ));
    assert!(matches!(
        non_finite,
        Err(CaptureError::AudioDecodeFailed(_))
    ));
}

#[test]
fn unsupported_decoder_feature_maps_to_unsupported_codec() {
    // HE-AAC remains simulated because FFmpeg's native AAC encoder cannot emit
    // SBR, and this repository has no provenance-cleared libfdk-aac fixture.
    // This is the exact Unsupported detail Symphonia emits for HE-AAC input.
    let error = codec_failure(
        "could not create AAC-LC decoder",
        SymphoniaError::Unsupported("aac: aac too complex"),
    );
    assert!(matches!(
        error,
        CaptureError::UnsupportedAudioCodec(detail) if detail.contains("aac too complex")
    ));
}

#[test]
fn malformed_and_probe_unsupported_errors_remain_decode_failures() {
    for error in [
        codec_failure("decode", SymphoniaError::DecodeError("bad AAC packet")),
        decode_failure("probe", SymphoniaError::Unsupported("unknown container")),
        decode_failure("limit", SymphoniaError::LimitError("packet count")),
        decode_failure("reset", SymphoniaError::ResetRequired),
        decode_failure("seek", SymphoniaError::SeekError(SeekErrorKind::Unseekable)),
        decode_failure(
            "io",
            SymphoniaError::IoError(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "truncated",
            )),
        ),
    ] {
        assert!(matches!(error, CaptureError::AudioDecodeFailed(_)));
    }
}

#[test]
fn resampler_converts_source_frames_to_sixteen_kilohertz() {
    let output = resample_to_16khz(&vec![0.25; 441], 44_100).unwrap();
    assert_eq!(output.len(), 160);
    assert!(output.iter().all(|sample| sample.is_finite()));
}

#[test]
fn streaming_resampler_matches_batch_output_across_packet_boundaries() {
    let source = (0..44_100)
        .map(|index| ((index as f32 / 100.0).sin()) * 0.25)
        .collect::<Vec<_>>();
    let expected_samples = resample_to_16khz(
        &source
            .iter()
            .map(|sample| f64::from(*sample))
            .collect::<Vec<_>>(),
        44_100,
    )
    .unwrap();
    let expected = encode_pcm_s16le_wav(&expected_samples).unwrap();
    let mut streaming = StreamingWavResampler::new(44_100).unwrap();
    for packet in source.chunks(733) {
        streaming.push(packet).unwrap();
    }

    let actual = streaming.finish().unwrap();

    assert_eq!(actual, expected);
}

#[test]
fn invalid_source_rate_is_a_resampler_setup_failure() {
    let error = resample_to_16khz(&[0.25], 0).unwrap_err();
    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("resampler setup"))
    );
}

#[test]
fn streaming_resampler_rejects_an_invalid_source_rate() {
    let error = match StreamingWavResampler::new(0) {
        Ok(_) => panic!("zero-hertz source rate must be rejected"),
        Err(error) => error,
    };

    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("resampler setup"))
    );
}

#[test]
fn streaming_resampler_rejects_an_empty_stream() {
    let error = StreamingWavResampler::new(44_100)
        .unwrap()
        .finish()
        .unwrap_err();

    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("zero frames"))
    );
}

#[test]
fn streaming_resampler_rejects_a_partial_chunk_larger_than_pending_input() {
    let mut streaming = StreamingWavResampler::new(44_100).unwrap();
    let error = streaming.process_chunk(Some(1)).unwrap_err();

    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("unavailable input"))
    );
}

#[test]
fn streaming_resampler_finalises_an_exact_chunk_without_pending_input() {
    let mut streaming = StreamingWavResampler::new(16_000).unwrap();
    streaming.push(&vec![0.25; 1_024]).unwrap();

    let wav = streaming.finish().unwrap();

    assert_eq!(wav.len(), 44 + 1_024 * 2);
    assert_eq!(
        u32::from_le_bytes(wav[40..44].try_into().unwrap()),
        (1_024 * 2) as u32
    );
}

#[test]
fn resample_capacity_is_bounded_before_allocation() {
    assert!(validate_resample_capacity(MAX_RESAMPLED_SAMPLES).is_ok());
    assert!(matches!(
        validate_resample_capacity(MAX_RESAMPLED_SAMPLES + 1),
        Err(CaptureError::AudioDecodeFailed(detail)) if detail.contains("WAV safety limit")
    ));
}

#[test]
fn resample_counts_must_consume_input_and_produce_bounded_output() {
    assert!(validate_resample_counts(10, 4, 10, 8).is_ok());
    for result in [
        validate_resample_counts(9, 4, 10, 8),
        validate_resample_counts(10, 0, 10, 8),
        validate_resample_counts(10, 9, 10, 8),
    ] {
        assert!(matches!(result, Err(CaptureError::AudioDecodeFailed(_))));
    }
}

#[test]
fn wav_writer_clamps_samples_and_uses_little_endian_pcm() {
    let wav = encode_pcm_s16le_wav(&[-2.0, -1.0, 0.0, 1.0, 2.0]).unwrap();
    let samples = wav[44..]
        .chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
        .collect::<Vec<_>>();

    assert_eq!(samples, [i16::MIN + 1, i16::MIN + 1, 0, i16::MAX, i16::MAX]);
}

#[test]
fn wav_writer_rejects_non_finite_samples() {
    let error = encode_pcm_s16le_wav(&[f64::INFINITY]).unwrap_err();
    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("non-finite"))
    );
}

#[test]
fn wav_header_rejects_a_total_length_overflow_without_panicking() {
    let sample_count = usize::MAX / 2 - 10;
    let error = write_wav_header(&mut [0; 44], sample_count).unwrap_err();

    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("allocation length overflow"))
    );
}

#[test]
fn wav_header_rejects_a_buffer_that_does_not_match_its_sample_count() {
    let error = write_wav_header(&mut [0; 44], 1).unwrap_err();

    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("buffer length"))
    );
}

#[test]
fn wav_header_rejects_pcm_data_beyond_the_riff_size_limit() {
    let sample_count = u32::MAX as usize / 2 + 1;
    let error = write_wav_header(&mut [0; 44], sample_count).unwrap_err();

    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("RIFF size limit"))
    );
}

#[test]
fn wav_header_rejects_pcm_data_that_overflows_the_riff_chunk_length() {
    let sample_count = (u32::MAX as usize - 1) / 2;
    let error = write_wav_header(&mut [0; 44], sample_count).unwrap_err();

    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("RIFF length overflow"))
    );
}
