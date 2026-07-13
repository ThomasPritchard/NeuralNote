use super::service::ShellYoutubeIo;
use super::service_files::{read_single_artifact, ArtifactKind, MAX_M4A_DOWNLOAD_BYTES};
use super::service_process::{run_whisper, OperationKind};
use super::whisper::{read_output_vtt, WhisperCli};
use neuralnote_core::ai::{CaptionPayload, CaptureCancellation, YoutubeUrl, WHISPER_MODEL_NAME};
use neuralnote_core::capture::{decode_m4a_to_wav_cancellable, CaptureError};

pub(super) async fn transcribe(
    io: &ShellYoutubeIo,
    url: &YoutubeUrl,
    model: &str,
    cancellation: &CaptureCancellation,
) -> Result<CaptionPayload, CaptureError> {
    validate_request(model, cancellation)?;
    let operation = io.workspace.begin(
        super::service::video_id_from_url(url).as_ref(),
        "transcription",
    )?;
    let audio_spec = io.commands.audio(url, operation.path());
    let (operation, _) = super::service_process::run_ytdlp(
        io.runner.as_ref(),
        operation,
        audio_spec,
        OperationKind::Audio,
        cancellation,
    )
    .await?;
    let (_, audio_bytes) = match read_single_artifact(
        operation.path(),
        "m4a",
        MAX_M4A_DOWNLOAD_BYTES,
        ArtifactKind::Audio,
    )
    .await
    {
        Ok(audio) => audio,
        Err(error) => return Err(operation.preserve_failure(error).await),
    };
    if cancellation.is_cancelled() {
        return Err(operation
            .preserve_failure(CaptureError::Cancelled(
                "transcription was cancelled before audio decoding".into(),
            ))
            .await);
    }
    let decode_cancellation = cancellation.clone();
    let wav = match tokio::task::spawn_blocking(move || {
        decode_m4a_to_wav_cancellable(&audio_bytes, || decode_cancellation.is_cancelled())
    })
    .await
    {
        Ok(Ok(wav)) => wav,
        Ok(Err(error)) => return Err(operation.preserve_failure(error).await),
        Err(error) => {
            return Err(operation
                .preserve_failure(CaptureError::AudioDecodeFailed(format!(
                    "audio decode task failed: {error}"
                )))
                .await)
        }
    };
    if cancellation.is_cancelled() {
        return Err(operation
            .preserve_failure(CaptureError::Cancelled(
                "transcription was cancelled after audio decoding".into(),
            ))
            .await);
    }
    let wav_path = operation.path().join("audio.wav");
    if let Err(error) = operation.write_raw("audio.wav", &wav).await {
        return Err(operation.preserve_failure(error).await);
    }
    let whisper = match WhisperCli::from_app_data(&io.app_data_dir) {
        Ok(whisper) => whisper,
        Err(error) => return Err(operation.preserve_failure(error).await),
    };
    let output_prefix = operation.path().join("transcript");
    if let Err(error) = run_whisper(
        io.runner.as_ref(),
        &operation,
        whisper.transcribe(&wav_path, &output_prefix),
        cancellation,
    )
    .await
    {
        return Err(operation.preserve_failure(error).await);
    }
    let vtt = match read_output_vtt(&output_prefix).await {
        Ok(vtt) => vtt,
        Err(error) => return Err(operation.preserve_failure(error).await),
    };
    operation.complete().await?;
    Ok(CaptionPayload {
        vtt,
        annotations: Vec::new(),
    })
}

fn validate_request(model: &str, cancellation: &CaptureCancellation) -> Result<(), CaptureError> {
    if model != WHISPER_MODEL_NAME {
        return Err(CaptureError::RequirementMissing(
            "only the pinned small.en Whisper model is supported".into(),
        ));
    }
    if cancellation.is_cancelled() {
        return Err(CaptureError::Cancelled(
            "transcription was cancelled before it started".into(),
        ));
    }
    Ok(())
}
