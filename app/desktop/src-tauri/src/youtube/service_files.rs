use neuralnote_core::capture::{parse_vtt, CaptureError};
use std::io::Read;
use std::path::{Path, PathBuf};

pub(super) const MAX_M4A_DOWNLOAD_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(super) enum ArtifactKind {
    Caption,
    Audio,
}

pub(super) async fn read_single_artifact(
    directory: &Path,
    extension: &str,
    max_bytes: usize,
    kind: ArtifactKind,
) -> Result<(PathBuf, Vec<u8>), CaptureError> {
    let paths = ordinary_files_with_extension(directory, extension, kind).await?;
    let [path] = paths.as_slice() else {
        return Err(failure(
            kind,
            format!(
                "expected exactly one ordinary .{extension} artifact, found {}",
                paths.len()
            ),
        ));
    };
    let bytes = read_bounded_file(path, max_bytes, kind).await?;
    Ok((path.clone(), bytes))
}

pub(super) async fn read_valid_vtt(
    directory: &Path,
    extension: &str,
    max_bytes: usize,
    kind: ArtifactKind,
) -> Result<Vec<u8>, CaptureError> {
    let (_, bytes) = read_single_artifact(directory, extension, max_bytes, kind).await?;
    parse_vtt(&bytes)?;
    Ok(bytes)
}

async fn ordinary_files_with_extension(
    directory: &Path,
    extension: &str,
    kind: ArtifactKind,
) -> Result<Vec<PathBuf>, CaptureError> {
    let mut entries = tokio::fs::read_dir(directory)
        .await
        .map_err(|error| failure(kind, format!("could not inspect capture output: {error}")))?;
    let mut paths = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| failure(kind, format!("could not inspect capture output: {error}")))?
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some(extension) {
            continue;
        }
        let metadata = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|error| failure(kind, format!("could not inspect artifact: {error}")))?;
        if !metadata.file_type().is_file() {
            return Err(failure(kind, "capture artifact is not an ordinary file"));
        }
        paths.push(path);
    }
    paths.sort();
    Ok(paths)
}

async fn read_bounded_file(
    path: &Path,
    max_bytes: usize,
    kind: ArtifactKind,
) -> Result<Vec<u8>, CaptureError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(&path)
            .map_err(|error| failure(kind, format!("could not open capture artifact: {error}")))?;
        let metadata = file.metadata().map_err(|error| {
            failure(kind, format!("could not inspect capture artifact: {error}"))
        })?;
        if !metadata.is_file() {
            return Err(failure(kind, "capture artifact is not an ordinary file"));
        }
        if metadata.len() > max_bytes as u64 {
            return Err(failure(kind, "capture artifact exceeds its byte limit"));
        }
        let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(max_bytes));
        file.take((max_bytes as u64).saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| failure(kind, format!("could not read capture artifact: {error}")))?;
        if bytes.len() > max_bytes {
            return Err(failure(kind, "capture artifact exceeds its byte limit"));
        }
        if bytes.is_empty() {
            return Err(failure(kind, "capture artifact is empty"));
        }
        Ok(bytes)
    })
    .await
    .map_err(|error| failure(kind, format!("capture artifact read task failed: {error}")))?
}

fn failure(kind: ArtifactKind, detail: impl Into<String>) -> CaptureError {
    match kind {
        ArtifactKind::Caption => CaptureError::InvalidVtt(detail.into()),
        ArtifactKind::Audio => CaptureError::AudioUnavailable(detail.into()),
    }
}
