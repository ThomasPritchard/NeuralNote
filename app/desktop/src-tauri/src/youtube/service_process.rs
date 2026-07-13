use super::process::{ProcessError, ProcessOutput, ProcessRunner, ProcessSpec};
use super::workspace::{append_error_context, OperationWorkspace};
use neuralnote_core::ai::CaptureCancellation;
use neuralnote_core::capture::{classify_ytdlp_failure, CaptureError};

#[derive(Clone, Copy)]
pub(super) enum OperationKind {
    Metadata,
    Captions,
    Playlist,
    Audio,
    Update,
}

pub(super) async fn run_ytdlp(
    runner: &dyn ProcessRunner,
    operation: OperationWorkspace,
    spec: ProcessSpec,
    kind: OperationKind,
    cancellation: &CaptureCancellation,
) -> Result<(OperationWorkspace, ProcessOutput), CaptureError> {
    match runner.run(&spec, cancellation).await {
        Ok(output) if output.status.success() => {
            if let Err(error) = record_diagnostics(&operation, &output.stdout, &output.stderr).await
            {
                return Err(operation.preserve_failure(error).await);
            }
            Ok((operation, output))
        }
        Ok(output) => {
            let error = classify_operation_failure(
                kind,
                &output.stdout,
                &output.stderr,
                format!("extractor exited with {}", output.status),
            );
            let error = match record_diagnostics(&operation, &output.stdout, &output.stderr).await {
                Ok(()) => error,
                Err(write_error) => retention_failure(error, &write_error),
            };
            Err(operation.preserve_failure(error).await)
        }
        Err(error) => {
            let (error, stdout, stderr) = map_process_error(error, kind);
            let error = match record_diagnostics(&operation, &stdout, &stderr).await {
                Ok(()) => error,
                Err(write_error) => retention_failure(error, &write_error),
            };
            Err(operation.preserve_failure(error).await)
        }
    }
}

pub(super) async fn run_whisper(
    runner: &dyn ProcessRunner,
    operation: &OperationWorkspace,
    spec: ProcessSpec,
    cancellation: &CaptureCancellation,
) -> Result<(), CaptureError> {
    match runner.run(&spec, cancellation).await {
        Ok(output) => {
            if output.status.success() {
                record_named_diagnostics(operation, "whisper", &output.stdout, &output.stderr).await
            } else {
                let error = CaptureError::TranscriptionFailed(format!(
                    "whisper-cli exited with status {}; {}",
                    output.status,
                    surfaced_stderr(&output.stderr)
                ));
                match record_named_diagnostics(operation, "whisper", &output.stdout, &output.stderr)
                    .await
                {
                    Ok(()) => Err(error),
                    Err(write_error) => Err(retention_failure(error, &write_error)),
                }
            }
        }
        Err(error) => {
            let (error, stdout, stderr) = map_whisper_process_error(error);
            match record_named_diagnostics(operation, "whisper", &stdout, &stderr).await {
                Ok(()) => Err(error),
                Err(write_error) => Err(retention_failure(error, &write_error)),
            }
        }
    }
}

fn retention_failure(error: CaptureError, retention: &CaptureError) -> CaptureError {
    append_error_context(
        error,
        format!(
            "could not retain process diagnostics: {}",
            retention.detail()
        ),
    )
}

async fn record_diagnostics(
    operation: &OperationWorkspace,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<(), CaptureError> {
    operation.write_raw("stdout.log", stdout).await?;
    operation.write_raw("stderr.log", stderr).await
}

async fn record_named_diagnostics(
    operation: &OperationWorkspace,
    prefix: &str,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<(), CaptureError> {
    operation
        .write_raw(&format!("{prefix}-stdout.log"), stdout)
        .await?;
    operation
        .write_raw(&format!("{prefix}-stderr.log"), stderr)
        .await
}

fn combined_output(stdout: &[u8], stderr: &[u8]) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
}

fn map_process_error(error: ProcessError, kind: OperationKind) -> (CaptureError, Vec<u8>, Vec<u8>) {
    let (detail, stdout, stderr) = match error {
        ProcessError::Cancelled { stdout, stderr } => {
            return (
                CaptureError::Cancelled("YouTube capture was cancelled".into()),
                stdout,
                stderr,
            );
        }
        ProcessError::TimedOut {
            timeout,
            stdout,
            stderr,
        } => (
            format!("extractor timed out after {timeout:?}"),
            stdout,
            stderr,
        ),
        ProcessError::OutputOverflow {
            stream,
            limit,
            stdout,
            stderr,
        } => (
            format!("extractor {stream:?} exceeded the {limit}-byte limit"),
            stdout,
            stderr,
        ),
        other => (other.to_string(), Vec::new(), Vec::new()),
    };
    let error = classify_operation_failure(kind, &stdout, &stderr, detail);
    (error, stdout, stderr)
}

fn classify_operation_failure(
    kind: OperationKind,
    stdout: &[u8],
    stderr: &[u8],
    generic_detail: String,
) -> CaptureError {
    match classify_ytdlp_failure(&combined_output(stdout, stderr)) {
        CaptureError::MetadataUnavailable(_) => operation_failure(kind, generic_detail),
        classified => append_error_context(classified, generic_detail),
    }
}

fn map_whisper_process_error(error: ProcessError) -> (CaptureError, Vec<u8>, Vec<u8>) {
    match error {
        ProcessError::Cancelled { stdout, stderr } => (
            CaptureError::Cancelled("transcription was cancelled".into()),
            stdout,
            stderr,
        ),
        ProcessError::TimedOut {
            timeout,
            stdout,
            stderr,
        } => (
            CaptureError::TranscriptionFailed(format!(
                "whisper-cli timed out after {timeout:?}; {}",
                surfaced_stderr(&stderr)
            )),
            stdout,
            stderr,
        ),
        ProcessError::OutputOverflow {
            stream,
            limit,
            stdout,
            stderr,
        } => (
            CaptureError::TranscriptionFailed(format!(
                "whisper-cli {stream:?} exceeded the {limit}-byte limit; {}",
                surfaced_stderr(&stderr)
            )),
            stdout,
            stderr,
        ),
        other => (
            CaptureError::TranscriptionFailed(other.to_string()),
            Vec::new(),
            Vec::new(),
        ),
    }
}

/// The raw log remains available in the retained workspace. Keep the surfaced
/// tail small enough for a tool result while preserving the latest diagnostic.
fn surfaced_stderr(stderr: &[u8]) -> String {
    const MAX_SURFACED_STDERR_BYTES: usize = 8 * 1024;

    let text = String::from_utf8_lossy(stderr);
    let mut start = text.len().saturating_sub(MAX_SURFACED_STDERR_BYTES);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let excerpt = text[start..]
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\t') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let excerpt = excerpt.trim();
    if excerpt.is_empty() {
        "stderr was empty".into()
    } else if start == 0 {
        format!("stderr: {excerpt}")
    } else {
        format!("stderr tail (truncated): {excerpt}")
    }
}

fn operation_failure(kind: OperationKind, detail: String) -> CaptureError {
    let detail = format!("YouTube extractor operation failed: {detail}");
    match kind {
        OperationKind::Metadata | OperationKind::Captions | OperationKind::Update => {
            CaptureError::MetadataUnavailable(detail)
        }
        OperationKind::Playlist => CaptureError::PlaylistInvalid(detail),
        OperationKind::Audio => CaptureError::AudioUnavailable(format!(
            "no downloadable AAC-LC m4a audio rendition was available: {detail}"
        )),
    }
}
