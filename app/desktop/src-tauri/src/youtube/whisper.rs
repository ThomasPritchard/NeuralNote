use super::process::{EnvironmentPolicy, ProcessSpec};
use super::SANITIZED_PATH;
use neuralnote_core::capture::{parse_vtt, CaptureError, MAX_VTT_BYTES};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const WHISPER_BINARY: &str = "whisper-cli";
const WHISPER_MODEL: &str = "ggml-small.en.bin";
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// `-np` should keep stdout quiet; the cap still contains unexpected output.
const WHISPER_STDOUT_LIMIT: usize = 256 * 1024;
/// Model diagnostics are useful on failure but may not grow without bound.
const WHISPER_STDERR_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone)]
pub(super) struct WhisperCli {
    binary: PathBuf,
    model: PathBuf,
}

impl WhisperCli {
    pub(super) fn from_app_data(app_data: &Path) -> Result<Self, CaptureError> {
        if !app_data.is_absolute() {
            return Err(requirement_missing(
                "application data directory must be absolute",
            ));
        }
        let binary = app_data.join("bin").join(WHISPER_BINARY);
        let model = app_data.join("assets").join(WHISPER_MODEL);
        validate_requirement(&binary, RequirementKind::Executable)?;
        validate_requirement(&model, RequirementKind::Asset)?;
        Ok(Self { binary, model })
    }

    pub(super) fn transcribe(&self, wav: &Path, output_prefix: &Path) -> ProcessSpec {
        ProcessSpec {
            program: self.binary.clone(),
            args: vec![
                OsString::from("-m"),
                self.model.as_os_str().to_owned(),
                OsString::from("-f"),
                wav.as_os_str().to_owned(),
                OsString::from("-ovtt"),
                OsString::from("-of"),
                output_prefix.as_os_str().to_owned(),
                OsString::from("-np"),
            ],
            cwd: output_prefix.parent().map(Path::to_path_buf),
            environment: EnvironmentPolicy::ClearAndSet(BTreeMap::from([(
                OsString::from("PATH"),
                OsString::from(SANITIZED_PATH),
            )])),
            timeout: TRANSCRIPTION_TIMEOUT,
            stdout_limit: WHISPER_STDOUT_LIMIT,
            stderr_limit: WHISPER_STDERR_LIMIT,
        }
    }
}

/// Read the one VTT produced by `whisper-cli -of <prefix>`, enforcing the same
/// byte and parser policy as downloaded captions before it reaches core tools.
pub(super) async fn read_output_vtt(output_prefix: &Path) -> Result<Vec<u8>, CaptureError> {
    let directory = output_prefix
        .parent()
        .ok_or_else(|| transcription_failed("Whisper output prefix has no containing directory"))?;
    let expected = output_vtt_path(output_prefix);
    let mut entries = tokio::fs::read_dir(directory).await.map_err(|error| {
        transcription_failed(format!("could not inspect Whisper output: {error}"))
    })?;
    let mut found = None;
    while let Some(entry) = entries.next_entry().await.map_err(|error| {
        transcription_failed(format!("could not inspect Whisper output: {error}"))
    })? {
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "vtt")
            && found.replace(path).is_some()
        {
            return Err(transcription_failed(
                "Whisper produced more than one VTT output",
            ));
        }
    }
    let Some(found) = found else {
        return Err(transcription_failed("Whisper produced no VTT output"));
    };
    if found != expected {
        return Err(transcription_failed(
            "Whisper VTT output did not match the requested output prefix",
        ));
    }

    let metadata = tokio::fs::symlink_metadata(&found).await.map_err(|error| {
        transcription_failed(format!("could not inspect Whisper VTT output: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(transcription_failed(
            "Whisper VTT output must be a regular non-symlink file",
        ));
    }
    if metadata.len() > MAX_VTT_BYTES as u64 {
        return Err(invalid_vtt_size());
    }

    let bytes = read_bounded_regular_file(found).await?;
    parse_vtt(&bytes)?;
    Ok(bytes)
}

fn output_vtt_path(output_prefix: &Path) -> PathBuf {
    let mut output = output_prefix.as_os_str().to_owned();
    output.push(".vtt");
    PathBuf::from(output)
}

async fn read_bounded_regular_file(path: PathBuf) -> Result<Vec<u8>, CaptureError> {
    tokio::task::spawn_blocking(move || {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(&path).map_err(|error| {
            transcription_failed(format!("could not open Whisper VTT output: {error}"))
        })?;
        let metadata = file.metadata().map_err(|error| {
            transcription_failed(format!("could not inspect Whisper VTT output: {error}"))
        })?;
        if !metadata.is_file() {
            return Err(transcription_failed(
                "Whisper VTT output must be a regular file",
            ));
        }
        if metadata.len() > MAX_VTT_BYTES as u64 {
            return Err(invalid_vtt_size());
        }
        let mut bytes = Vec::with_capacity((metadata.len() as usize).min(MAX_VTT_BYTES));
        file.take((MAX_VTT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                transcription_failed(format!("could not read Whisper VTT output: {error}"))
            })?;
        if bytes.len() > MAX_VTT_BYTES {
            return Err(invalid_vtt_size());
        }
        Ok(bytes)
    })
    .await
    .map_err(|error| transcription_failed(format!("Whisper VTT read task failed: {error}")))?
}

#[derive(Debug, Clone, Copy)]
enum RequirementKind {
    Executable,
    Asset,
}

fn validate_requirement(path: &Path, kind: RequirementKind) -> Result<(), CaptureError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        requirement_missing(match kind {
            RequirementKind::Executable => "Whisper executable is unavailable",
            RequirementKind::Asset => "Whisper model is unavailable",
        })
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(requirement_missing(match kind {
            RequirementKind::Executable => "Whisper executable must be a regular non-symlink file",
            RequirementKind::Asset => "Whisper model must be a regular non-symlink file",
        }));
    }
    #[cfg(unix)]
    if matches!(kind, RequirementKind::Executable) {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(requirement_missing("Whisper executable is not executable"));
        }
    }
    Ok(())
}

fn requirement_missing(detail: impl Into<String>) -> CaptureError {
    CaptureError::RequirementMissing(detail.into())
}

fn transcription_failed(detail: impl Into<String>) -> CaptureError {
    CaptureError::TranscriptionFailed(detail.into())
}

fn invalid_vtt_size() -> CaptureError {
    CaptureError::InvalidVtt(format!("VTT exceeds the {MAX_VTT_BYTES}-byte limit"))
}

#[cfg(test)]
#[path = "whisper_tests.rs"]
mod tests;
