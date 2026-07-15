//! Pure AAC-LC M4A decode and Whisper-compatible WAV rendering.

use crate::capture::CaptureError;
use std::io::Cursor;
use symphonia::core::codecs::audio::well_known::CODEC_ID_AAC;
use symphonia::core::codecs::audio::{AudioCodecId, AudioCodecParameters, AudioDecoderOptions};
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

#[path = "audio_stream.rs"]
mod stream;

use stream::StreamingWavResampler;
#[cfg(test)]
use stream::{
    encode_pcm_s16le_wav, resample_to_16khz, validate_resample_capacity, validate_resample_counts,
    write_wav_header, MAX_RESAMPLED_SAMPLES,
};

const MAX_M4A_BYTES: usize = 256 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS: usize = 2 * 60 * 60;

/// yt-dlp selector that excludes the HE-AAC rendition Symphonia cannot decode.
pub const YOUTUBE_AAC_LC_SELECTOR: &str = "bestaudio[ext=m4a][acodec^=mp4a.40.2]";

/// Return the only YouTube audio rendition accepted by the pure-Rust decoder.
pub const fn youtube_audio_format_selector() -> &'static str {
    YOUTUBE_AAC_LC_SELECTOR
}

/// Decode a downloaded YouTube AAC-LC M4A payload to Whisper-compatible WAV bytes.
pub fn decode_m4a_to_wav(bytes: &[u8]) -> Result<Vec<u8>, CaptureError> {
    decode_m4a_to_wav_cancellable(bytes, || false)
}

/// Decode while allowing the host-owned cancellation token to be observed at
/// packet boundaries, where Symphonia safely yields control.
pub fn decode_m4a_to_wav_cancellable(
    bytes: &[u8],
    is_cancelled: impl Fn() -> bool,
) -> Result<Vec<u8>, CaptureError> {
    ensure_decode_active(&is_cancelled)?;
    if bytes.is_empty() {
        return Err(CaptureError::AudioUnavailable(
            "audio payload is empty".into(),
        ));
    }
    validate_input_len(bytes.len())?;

    let source = Cursor::new(bytes);
    let stream = MediaSourceStream::new(Box::new(source), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("m4a");

    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| decode_failure("could not read M4A container", error))?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| CaptureError::AudioUnavailable("M4A contains no audio track".into()))?;
    let track_id = track.id;
    let codec_params = require_audio_codec_params(track.codec_params.as_ref())?;

    validate_aac_codec(codec_params.codec)?;

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .map_err(|error| codec_failure("could not create AAC-LC decoder", error))?;

    let mut source_rate = None;
    let mut source_channels = None;
    let mut interleaved = Vec::<f32>::new();
    let mut total_source_frames = 0usize;
    let mut wav_resampler = None;

    loop {
        ensure_decode_active(&is_cancelled)?;
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(error) => {
                return Err(decode_failure("could not read audio packet", error));
            }
        };
        if packet.track_id != track_id {
            continue;
        }

        let decoded = decoder
            .decode(&packet)
            .map_err(|error| codec_failure("could not decode AAC-LC packet", error))?;
        let rate = decoded.spec().rate();
        let channels = decoded.spec().channels().count();
        validate_audio_spec(rate, channels, source_rate, source_channels)?;
        source_rate.get_or_insert(rate);
        source_channels.get_or_insert(channels);

        decoded.copy_to_vec_interleaved(&mut interleaved);
        let mono = downmix_packet(&interleaved, channels, rate, total_source_frames)?;
        total_source_frames = total_source_frames.checked_add(mono.len()).ok_or_else(|| {
            CaptureError::AudioDecodeFailed("decoded audio length overflow".into())
        })?;
        if wav_resampler.is_none() {
            wav_resampler = Some(StreamingWavResampler::new(rate)?);
        }
        wav_resampler
            .as_mut()
            .expect("resampler was initialised")
            .push(&mono)?;
    }

    ensure_decode_active(&is_cancelled)?;
    require_decoded_audio(source_rate, total_source_frames)?;
    wav_resampler
        .ok_or_else(|| CaptureError::AudioDecodeFailed("AAC-LC stream decoded zero frames".into()))?
        .finish()
}

fn ensure_decode_active(is_cancelled: &impl Fn() -> bool) -> Result<(), CaptureError> {
    if is_cancelled() {
        Err(CaptureError::Cancelled(
            "audio decoding was cancelled".into(),
        ))
    } else {
        Ok(())
    }
}

fn validate_input_len(len: usize) -> Result<(), CaptureError> {
    if len > MAX_M4A_BYTES {
        return Err(CaptureError::AudioDecodeFailed(format!(
            "audio payload exceeds the {MAX_M4A_BYTES}-byte safety limit"
        )));
    }
    Ok(())
}

fn require_audio_codec_params(
    params: Option<&CodecParameters>,
) -> Result<AudioCodecParameters, CaptureError> {
    params
        .and_then(CodecParameters::audio)
        .cloned()
        .ok_or_else(|| {
            CaptureError::AudioDecodeFailed("audio track has no codec parameters".into())
        })
}

fn validate_aac_codec(codec: AudioCodecId) -> Result<(), CaptureError> {
    if codec != CODEC_ID_AAC {
        return Err(unsupported_codec(format!(
            "expected AAC-LC, found {codec:?}"
        )));
    }
    Ok(())
}

fn require_decoded_audio(source_rate: Option<u32>, frames: usize) -> Result<u32, CaptureError> {
    match (source_rate, frames) {
        (Some(rate), frames) if frames > 0 => Ok(rate),
        _ => Err(CaptureError::AudioDecodeFailed(
            "AAC-LC stream decoded zero frames".into(),
        )),
    }
}

fn validate_audio_spec(
    rate: u32,
    channels: usize,
    expected_rate: Option<u32>,
    expected_channels: Option<usize>,
) -> Result<(), CaptureError> {
    if rate == 0 || channels == 0 || channels > 2 {
        return Err(CaptureError::AudioDecodeFailed(format!(
            "invalid decoded audio format: {rate} Hz, {channels} channels"
        )));
    }
    if expected_rate.is_some_and(|expected| expected != rate)
        || expected_channels.is_some_and(|expected| expected != channels)
    {
        return Err(CaptureError::AudioDecodeFailed(
            "audio format changed between packets".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
fn reference_append_downmixed(
    interleaved: &[f32],
    channels: usize,
    rate: u32,
    mono: &mut Vec<f64>,
) -> Result<(), CaptureError> {
    if channels == 0 {
        return Err(CaptureError::AudioDecodeFailed(
            "decoded packet has zero channels".into(),
        ));
    }
    if !interleaved.len().is_multiple_of(channels) {
        return Err(CaptureError::AudioDecodeFailed(
            "decoded packet is not frame-aligned".into(),
        ));
    }

    let frames = interleaved.len() / channels;
    let next_len = validate_frame_budget(mono.len(), frames, rate)?;
    mono.try_reserve(frames)
        .map_err(|_| CaptureError::AudioDecodeFailed("could not allocate decoded audio".into()))?;

    for frame in interleaved.chunks_exact(channels) {
        if frame.iter().any(|sample| !sample.is_finite()) {
            return Err(CaptureError::AudioDecodeFailed(
                "decoded audio contains a non-finite sample".into(),
            ));
        }
        let sum = frame.iter().map(|sample| f64::from(*sample)).sum::<f64>();
        mono.push(sum / channels as f64);
    }
    debug_assert_eq!(mono.len(), next_len);
    Ok(())
}

fn downmix_packet(
    interleaved: &[f32],
    channels: usize,
    rate: u32,
    current_frames: usize,
) -> Result<Vec<f32>, CaptureError> {
    if channels == 0 || !interleaved.len().is_multiple_of(channels) {
        return Err(CaptureError::AudioDecodeFailed(
            "decoded packet is not frame-aligned".into(),
        ));
    }
    let frames = interleaved.len() / channels;
    validate_frame_budget(current_frames, frames, rate)?;
    let mut mono = Vec::new();
    mono.try_reserve_exact(frames)
        .map_err(|_| CaptureError::AudioDecodeFailed("could not allocate audio packet".into()))?;
    for frame in interleaved.chunks_exact(channels) {
        if frame.iter().any(|sample| !sample.is_finite()) {
            return Err(CaptureError::AudioDecodeFailed(
                "decoded audio contains a non-finite sample".into(),
            ));
        }
        mono.push(frame.iter().sum::<f32>() / channels as f32);
    }
    Ok(mono)
}

fn validate_frame_budget(
    current: usize,
    additional: usize,
    rate: u32,
) -> Result<usize, CaptureError> {
    let max_frames = (rate as usize)
        .checked_mul(MAX_AUDIO_DURATION_SECONDS)
        .ok_or_else(|| CaptureError::AudioDecodeFailed("audio duration overflow".into()))?;
    let next_len = current
        .checked_add(additional)
        .ok_or_else(|| CaptureError::AudioDecodeFailed("decoded audio length overflow".into()))?;
    if next_len > max_frames {
        return Err(CaptureError::AudioDecodeFailed(format!(
            "decoded audio exceeds the {MAX_AUDIO_DURATION_SECONDS}-second safety limit"
        )));
    }
    Ok(next_len)
}

fn decode_failure(context: &str, error: SymphoniaError) -> CaptureError {
    CaptureError::AudioDecodeFailed(format!("{context}: {error}"))
}

fn codec_failure(context: &str, error: SymphoniaError) -> CaptureError {
    match error {
        SymphoniaError::Unsupported(detail) => unsupported_codec(format!("{context}: {detail}")),
        other => decode_failure(context, other),
    }
}

fn unsupported_codec(detail: String) -> CaptureError {
    // TODO(ffmpeg-fallback, #59): this is the trigger site for the consented ffmpeg
    // fallback. The pure-Rust decoder handles only AAC-LC in m4a; a video with no
    // mp4a.40.2 rendition (HE-AAC, Opus, no-m4a) or a real AAC-LC payload Symphonia
    // rejects lands here. How often that happens across a representative sample is
    // measured by the `youtube_audio_coverage_report` harness classifying formats
    // via `capture::audio_coverage`. Build the fallback (follow-up #59) once the
    // written threshold in specs/youtube-distil-skill.md is crossed:
    // >10% of captionless videos lack a decodable AAC-LC m4a, or any single
    // undecodable class (HE-AAC / Opus / no-m4a) exceeds 5%.
    CaptureError::UnsupportedAudioCodec(format!(
        "this video's audio isn't in the supported AAC-LC (m4a) format, so local \
         transcription can't decode it. Try a video that has captions, or a different \
         source; support for other audio codecs (via ffmpeg) is planned. Technical detail: {detail}"
    ))
}

#[cfg(test)]
#[path = "audio_tests.rs"]
mod tests;
