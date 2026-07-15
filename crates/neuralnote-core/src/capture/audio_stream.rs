//! Streaming sample-rate conversion and Whisper-compatible WAV emission.
//!
//! Coverage note (issue #55): this module deliberately sits below the 90%
//! line-coverage target. The uncovered lines are defensive guards that are
//! unreachable with valid inputs and cannot be exercised without a mock
//! resampler/allocator seam we chose not to add to this security-sensitive
//! path: the `checked_add`/`checked_mul` overflow arms (would need ~usize::MAX
//! samples), the `try_reserve` allocation-failure arms, the "flush made no
//! progress" guard, and the `InterleavedSlice`/`process_into_buffer`
//! error arms on buffers this code always sizes correctly. See
//! `docs/security/dependency-advisories.md` neighbours for the auditing stance.

use super::{validate_frame_budget, MAX_AUDIO_DURATION_SECONDS};
use crate::capture::CaptureError;
use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler};

const TARGET_SAMPLE_RATE: usize = 16_000;
const RESAMPLER_CHUNK_FRAMES: usize = 1_024;
pub(super) const MAX_RESAMPLED_SAMPLES: usize =
    TARGET_SAMPLE_RATE * MAX_AUDIO_DURATION_SECONDS + RESAMPLER_CHUNK_FRAMES * 8;
const WAV_HEADER_BYTES: usize = 44;

pub(super) struct StreamingWavResampler {
    source_rate: u32,
    resampler: Fft<f64>,
    pending: Vec<f64>,
    wav: Vec<u8>,
    total_input_frames: usize,
    written_samples: usize,
    delay_to_trim: usize,
}

impl StreamingWavResampler {
    pub(super) fn new(source_rate: u32) -> Result<Self, CaptureError> {
        let resampler = Fft::<f64>::new(
            source_rate as usize,
            TARGET_SAMPLE_RATE,
            RESAMPLER_CHUNK_FRAMES,
            1,
            FixedSync::Both,
        )
        .map_err(|error| {
            CaptureError::AudioDecodeFailed(format!("resampler setup failed: {error}"))
        })?;
        let delay_to_trim = resampler.output_delay();
        Ok(Self {
            source_rate,
            resampler,
            pending: Vec::new(),
            wav: vec![0; WAV_HEADER_BYTES],
            total_input_frames: 0,
            written_samples: 0,
            delay_to_trim,
        })
    }

    pub(super) fn push(&mut self, samples: &[f32]) -> Result<(), CaptureError> {
        validate_frame_budget(self.total_input_frames, samples.len(), self.source_rate)?;
        self.total_input_frames = self
            .total_input_frames
            .checked_add(samples.len())
            .ok_or_else(|| {
                CaptureError::AudioDecodeFailed("decoded audio length overflow".into())
            })?;
        self.pending.try_reserve(samples.len()).map_err(|_| {
            CaptureError::AudioDecodeFailed("could not allocate resampler input".into())
        })?;
        self.pending
            .extend(samples.iter().map(|sample| f64::from(*sample)));
        while self.pending.len() >= self.resampler.input_frames_next() {
            self.process_chunk(None)?;
        }
        Ok(())
    }

    pub(super) fn finish(mut self) -> Result<Vec<u8>, CaptureError> {
        if self.total_input_frames == 0 {
            return Err(CaptureError::AudioDecodeFailed(
                "AAC-LC stream decoded zero frames".into(),
            ));
        }
        if !self.pending.is_empty() {
            let partial_len = self.pending.len();
            self.process_chunk(Some(partial_len))?;
        }
        let expected_samples = ((TARGET_SAMPLE_RATE as f64 / self.source_rate as f64)
            * self.total_input_frames as f64)
            .ceil() as usize;
        validate_resample_capacity(expected_samples)?;
        while self.written_samples < expected_samples {
            let before = self.written_samples;
            self.process_chunk(Some(0))?;
            if self.written_samples == before {
                return Err(CaptureError::AudioDecodeFailed(
                    "resampler flush made no progress".into(),
                ));
            }
        }
        self.wav.truncate(
            WAV_HEADER_BYTES
                .checked_add(expected_samples.checked_mul(2).ok_or_else(|| {
                    CaptureError::AudioDecodeFailed("WAV data length overflow".into())
                })?)
                .ok_or_else(|| {
                    CaptureError::AudioDecodeFailed("WAV allocation length overflow".into())
                })?,
        );
        self.written_samples = expected_samples;
        write_wav_header(&mut self.wav, expected_samples)?;
        Ok(self.wav)
    }

    pub(super) fn process_chunk(&mut self, partial_len: Option<usize>) -> Result<(), CaptureError> {
        let input_frames = self.resampler.input_frames_next();
        let valid_frames = partial_len.unwrap_or(input_frames);
        if valid_frames > self.pending.len() {
            return Err(CaptureError::AudioDecodeFailed(
                "resampler requested unavailable input frames".into(),
            ));
        }
        let mut input_data = vec![0.0; input_frames];
        input_data[..valid_frames].copy_from_slice(&self.pending[..valid_frames]);
        self.pending.drain(..valid_frames);
        let output_frames = self.resampler.output_frames_next();
        let mut output_data = vec![0.0; output_frames];
        let input = InterleavedSlice::new(&input_data, 1, input_frames).map_err(|error| {
            CaptureError::AudioDecodeFailed(format!("invalid audio buffer: {error}"))
        })?;
        let mut output =
            InterleavedSlice::new_mut(&mut output_data, 1, output_frames).map_err(|error| {
                CaptureError::AudioDecodeFailed(format!("invalid resample output buffer: {error}"))
            })?;
        let indexing = partial_len.map(|partial_len| Indexing {
            partial_len: Some(partial_len),
            ..Indexing::default()
        });
        let (consumed, produced) = self
            .resampler
            .process_into_buffer(&input, &mut output, indexing.as_ref())
            .map_err(|error| {
                CaptureError::AudioDecodeFailed(format!("resampling failed: {error}"))
            })?;
        let expected_consumed = if partial_len.is_some() {
            input_frames
        } else {
            valid_frames
        };
        if consumed != expected_consumed || produced > output_frames {
            return Err(CaptureError::AudioDecodeFailed(format!(
                "resampler produced an invalid frame count ({consumed} consumed, {produced} produced)"
            )));
        }
        self.append_output(&output_data[..produced])
    }

    fn append_output(&mut self, samples: &[f64]) -> Result<(), CaptureError> {
        let skip = self.delay_to_trim.min(samples.len());
        self.delay_to_trim -= skip;
        let samples = &samples[skip..];
        let next_count = self
            .written_samples
            .checked_add(samples.len())
            .ok_or_else(|| CaptureError::AudioDecodeFailed("WAV sample count overflow".into()))?;
        validate_resample_capacity(next_count)?;
        self.wav
            .try_reserve(samples.len().checked_mul(2).ok_or_else(|| {
                CaptureError::AudioDecodeFailed("WAV data length overflow".into())
            })?)
            .map_err(|_| CaptureError::AudioDecodeFailed("could not allocate WAV output".into()))?;
        for sample in samples {
            append_pcm_sample(&mut self.wav, *sample)?;
        }
        self.written_samples = next_count;
        Ok(())
    }
}

#[cfg(test)]
pub(super) fn resample_to_16khz(mono: &[f64], source_rate: u32) -> Result<Vec<f64>, CaptureError> {
    let mut resampler = Fft::<f64>::new(
        source_rate as usize,
        TARGET_SAMPLE_RATE,
        RESAMPLER_CHUNK_FRAMES,
        1,
        FixedSync::Both,
    )
    .map_err(|error| CaptureError::AudioDecodeFailed(format!("resampler setup failed: {error}")))?;

    let needed = resampler.process_all_needed_output_len(mono.len());
    validate_resample_capacity(needed)?;

    let mut output_data = Vec::new();
    output_data.try_reserve_exact(needed).map_err(|_| {
        CaptureError::AudioDecodeFailed("could not allocate resampled audio".into())
    })?;
    output_data.resize(needed, 0.0);

    let input = InterleavedSlice::new(mono, 1, mono.len()).map_err(|error| {
        CaptureError::AudioDecodeFailed(format!("invalid audio buffer: {error}"))
    })?;
    let mut output = InterleavedSlice::new_mut(&mut output_data, 1, needed).map_err(|error| {
        CaptureError::AudioDecodeFailed(format!("invalid resample output buffer: {error}"))
    })?;
    let (consumed, produced) = resampler
        .process_all_into_buffer(&input, &mut output, mono.len(), None)
        .map_err(|error| CaptureError::AudioDecodeFailed(format!("resampling failed: {error}")))?;
    validate_resample_counts(consumed, produced, mono.len(), needed)?;
    output_data.truncate(produced);
    Ok(output_data)
}

pub(super) fn validate_resample_capacity(needed: usize) -> Result<(), CaptureError> {
    if needed > MAX_RESAMPLED_SAMPLES {
        return Err(CaptureError::AudioDecodeFailed(
            "resampled audio exceeds WAV safety limit".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn validate_resample_counts(
    consumed: usize,
    produced: usize,
    input_len: usize,
    capacity: usize,
) -> Result<(), CaptureError> {
    if consumed != input_len || produced == 0 || produced > capacity {
        return Err(CaptureError::AudioDecodeFailed(format!(
            "resampler produced an invalid frame count ({consumed} consumed, {produced} produced)"
        )));
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn encode_pcm_s16le_wav(samples: &[f64]) -> Result<Vec<u8>, CaptureError> {
    let data_len = samples
        .len()
        .checked_mul(std::mem::size_of::<i16>())
        .ok_or_else(|| CaptureError::AudioDecodeFailed("WAV data length overflow".into()))?;
    let total_len = WAV_HEADER_BYTES
        .checked_add(data_len)
        .ok_or_else(|| CaptureError::AudioDecodeFailed("WAV allocation length overflow".into()))?;

    let mut wav = vec![0; WAV_HEADER_BYTES];
    wav.try_reserve_exact(total_len - WAV_HEADER_BYTES)
        .map_err(|_| CaptureError::AudioDecodeFailed("could not allocate WAV output".into()))?;

    for sample in samples {
        append_pcm_sample(&mut wav, *sample)?;
    }
    write_wav_header(&mut wav, samples.len())?;
    Ok(wav)
}

fn append_pcm_sample(wav: &mut Vec<u8>, sample: f64) -> Result<(), CaptureError> {
    if !sample.is_finite() {
        return Err(CaptureError::AudioDecodeFailed(
            "resampled audio contains a non-finite sample".into(),
        ));
    }
    let pcm = (sample.clamp(-1.0, 1.0) * f64::from(i16::MAX)).round() as i16;
    wav.extend_from_slice(&pcm.to_le_bytes());
    Ok(())
}

pub(super) fn write_wav_header(wav: &mut [u8], sample_count: usize) -> Result<(), CaptureError> {
    let data_len = sample_count
        .checked_mul(std::mem::size_of::<i16>())
        .ok_or_else(|| CaptureError::AudioDecodeFailed("WAV data length overflow".into()))?;
    let total_len = WAV_HEADER_BYTES
        .checked_add(data_len)
        .ok_or_else(|| CaptureError::AudioDecodeFailed("WAV allocation length overflow".into()))?;
    let data_len_u32 = u32::try_from(data_len)
        .map_err(|_| CaptureError::AudioDecodeFailed("WAV exceeds the RIFF size limit".into()))?;
    let riff_len = 36_u32
        .checked_add(data_len_u32)
        .ok_or_else(|| CaptureError::AudioDecodeFailed("WAV RIFF length overflow".into()))?;
    if wav.len() != total_len {
        return Err(CaptureError::AudioDecodeFailed(
            "WAV buffer length does not match its sample count".into(),
        ));
    }
    wav[0..4].copy_from_slice(b"RIFF");
    wav[4..8].copy_from_slice(&riff_len.to_le_bytes());
    wav[8..12].copy_from_slice(b"WAVE");
    wav[12..16].copy_from_slice(b"fmt ");
    wav[16..20].copy_from_slice(&16_u32.to_le_bytes());
    wav[20..22].copy_from_slice(&1_u16.to_le_bytes());
    wav[22..24].copy_from_slice(&1_u16.to_le_bytes());
    wav[24..28].copy_from_slice(&(TARGET_SAMPLE_RATE as u32).to_le_bytes());
    wav[28..32].copy_from_slice(&((TARGET_SAMPLE_RATE * 2) as u32).to_le_bytes());
    wav[32..34].copy_from_slice(&2_u16.to_le_bytes());
    wav[34..36].copy_from_slice(&16_u16.to_le_bytes());
    wav[36..40].copy_from_slice(b"data");
    wav[40..44].copy_from_slice(&data_len_u32.to_le_bytes());
    Ok(())
}
