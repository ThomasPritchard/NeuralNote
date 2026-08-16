//! Guard-level tests for the streaming resampler that need the module's own
//! private state. The behavioural suite for this path lives in `audio_tests.rs`
//! (it reaches the `pub(super)` surface); what remains here are the two guards
//! that no caller-visible input can reach.

use super::*;

/// The very top of the sample-count range: `sample_count * 2` overflows before
/// the RIFF-size and buffer-length guards the sibling suite already covers get a
/// chance to run. A header writer that wrapped here would emit a `data` length
/// unrelated to the buffer it describes.
#[test]
fn wav_header_rejects_a_sample_count_whose_byte_length_overflows() {
    let error = write_wav_header(&mut [0; 44], usize::MAX).unwrap_err();

    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("data length overflow"))
    );
}

/// `finish` flushes until the resampler has emitted the sample count the input
/// implies. If a flush ever contributed nothing, that loop would spin forever on
/// a decode the user cannot cancel, so the guard turns it into an explicit
/// failure instead.
///
/// No sample rate can reach it: `rubato`'s FFT resampler reports an output delay
/// of exactly half a flush chunk at every rate measured from 8 kHz to 768 kHz, so
/// the first flush always clears the trim budget and contributes samples. The
/// only way to exercise the guard is to model the pathological resampler it
/// exists for — one whose reported delay outlives everything it produces — by
/// setting the trim budget past any achievable output. Nothing in the production
/// path is relaxed to allow this; the test writes a private field of the type it
/// is defined alongside.
#[test]
fn a_flush_that_never_makes_progress_fails_instead_of_looping_forever() {
    let mut streaming = StreamingWavResampler::new(44_100).unwrap();
    streaming.push(&[0.25_f32; 64]).unwrap();
    streaming.delay_to_trim = usize::MAX;

    let error = streaming.finish().unwrap_err();

    assert!(
        matches!(error, CaptureError::AudioDecodeFailed(detail) if detail.contains("flush made no progress"))
    );
}
