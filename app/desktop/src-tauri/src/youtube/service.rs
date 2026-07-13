use super::pot::{PotInstallation, PotSidecar};
use super::process::{ProcessOutput, ProcessRunner, ProcessSpec, TokioProcessRunner};
use super::service_files::{read_valid_vtt, ArtifactKind};
use super::service_process::OperationKind;
use super::thumbnail;
use super::workspace::{CaptureWorkspace, OperationWorkspace};
use super::ytdlp::YtDlpCommands;
use async_trait::async_trait;
use neuralnote_core::ai::{
    CaptionPayload, CaptionRequest, CaptureCancellation, MetadataPayload, PlaylistPayload, PotMode,
    ThumbnailPayload, VideoId, YoutubeAnnotation, YoutubeIo, YoutubeUrl,
};
use neuralnote_core::capture::{parse_playlist, parse_video_metadata, CaptureError};
use std::path::PathBuf;
use std::sync::Arc;

pub(crate) struct ShellYoutubeIo {
    pub(super) app_data_dir: PathBuf,
    pub(super) workspace: CaptureWorkspace,
    pub(super) commands: YtDlpCommands,
    pub(super) runner: Arc<dyn ProcessRunner>,
    client: reqwest::Client,
    cancellation: CaptureCancellation,
    pot: Option<PotSidecar>,
}

impl ShellYoutubeIo {
    pub(super) fn new(
        app_data_dir: PathBuf,
        cancellation: CaptureCancellation,
        pot: PotSidecar,
    ) -> Result<Self, CaptureError> {
        Self::build(
            app_data_dir,
            Arc::new(TokioProcessRunner),
            cancellation,
            Some(pot),
        )
    }

    #[cfg(test)]
    pub(super) fn with_runner(
        app_data_dir: PathBuf,
        runner: Arc<dyn ProcessRunner>,
        cancellation: CaptureCancellation,
        pot: Option<PotSidecar>,
    ) -> Result<Self, CaptureError> {
        Self::build(app_data_dir, runner, cancellation, pot)
    }

    fn build(
        app_data_dir: PathBuf,
        runner: Arc<dyn ProcessRunner>,
        cancellation: CaptureCancellation,
        pot: Option<PotSidecar>,
    ) -> Result<Self, CaptureError> {
        if !app_data_dir.is_absolute() {
            return Err(CaptureError::RequirementMissing(
                "YouTube app-data directory must be absolute".into(),
            ));
        }
        let commands = YtDlpCommands::new(app_data_dir.join("bin").join("yt-dlp"));
        for directory in [
            commands.runtime_dir().join("home"),
            commands.runtime_dir().join("cache"),
            commands.runtime_dir().join("tmp"),
        ] {
            std::fs::create_dir_all(directory).map_err(|error| {
                CaptureError::RequirementMissing(format!(
                    "could not prepare the yt-dlp runtime: {error}"
                ))
            })?;
        }
        let workspace = CaptureWorkspace::new(&app_data_dir)?;
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("NeuralNote/0.1")
            .build()
            .map_err(|error| {
                CaptureError::MetadataUnavailable(format!(
                    "could not create the thumbnail client: {error}"
                ))
            })?;
        Ok(Self {
            app_data_dir,
            workspace,
            commands,
            runner,
            client,
            cancellation,
            pot,
        })
    }

    fn begin(
        &self,
        url: Option<&YoutubeUrl>,
        operation: &str,
    ) -> Result<OperationWorkspace, CaptureError> {
        self.ensure_active()?;
        self.workspace
            .begin(url.and_then(video_id_from_url).as_ref(), operation)
    }

    fn ensure_active(&self) -> Result<(), CaptureError> {
        if self.cancellation.is_cancelled() {
            return Err(CaptureError::Cancelled(
                "YouTube capture was cancelled".into(),
            ));
        }
        Ok(())
    }

    async fn run_ytdlp(
        &self,
        operation: OperationWorkspace,
        spec: ProcessSpec,
        kind: OperationKind,
        cancellation: &CaptureCancellation,
    ) -> Result<(OperationWorkspace, ProcessOutput), CaptureError> {
        super::service_process::run_ytdlp(self.runner.as_ref(), operation, spec, kind, cancellation)
            .await
    }

    fn pot_installation(&self) -> PotInstallation {
        PotInstallation::new(
            self.app_data_dir.join("bin").join("bgutil-pot"),
            self.app_data_dir.join("assets").join("bgutil-plugin.zip"),
            self.app_data_dir.join("bgutil-pot-runtime"),
        )
    }
}

#[async_trait]
impl YoutubeIo for ShellYoutubeIo {
    async fn inspect_metadata(&self, url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        let operation = self.begin(Some(url), "metadata")?;
        let (operation, output) = self
            .run_ytdlp(
                operation,
                self.commands.metadata(url),
                OperationKind::Metadata,
                &self.cancellation,
            )
            .await?;
        if let Err(error) = operation.write_raw("metadata.json", &output.stdout).await {
            return Err(operation.preserve_failure(error).await);
        }
        if let Err(error) = parse_video_metadata(&output.stdout) {
            return Err(operation.preserve_failure(error).await);
        }
        let annotations = po_listing_warning(&output.stderr)
            .then_some(YoutubeAnnotation::SubtitleListingWithheld)
            .into_iter()
            .collect();
        operation.complete().await?;
        Ok(MetadataPayload {
            json: output.stdout,
            annotations,
        })
    }

    async fn fetch_caption_vtt(
        &self,
        request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        self.ensure_active()?;
        let routing = if request.pot == PotMode::Prefer {
            let video_id = video_id_from_url(&request.url).ok_or_else(|| {
                CaptureError::InvalidSource(
                    "caption URL does not contain a valid YouTube video id".into(),
                )
            })?;
            let pot = self.pot.as_ref().ok_or_else(|| {
                CaptureError::PotUnavailable("the optional POT sidecar is unavailable".into())
            })?;
            Some(
                pot.ensure_started_cancellable(
                    &self.pot_installation(),
                    &video_id,
                    &self.cancellation,
                )
                .await?,
            )
        } else {
            None
        };
        self.ensure_active()?;
        let operation = self.begin(Some(&request.url), "captions")?;
        let spec = self
            .commands
            .captions(request, operation.path(), routing.as_ref());
        let (operation, _) = self
            .run_ytdlp(operation, spec, OperationKind::Captions, &self.cancellation)
            .await?;
        let vtt = match read_valid_vtt(
            operation.path(),
            "vtt",
            YtDlpCommands::caption_file_limit(),
            ArtifactKind::Caption,
        )
        .await
        {
            Ok(vtt) => vtt,
            Err(error) => return Err(operation.preserve_failure(error).await),
        };
        operation.complete().await?;
        Ok(CaptionPayload {
            vtt,
            annotations: Vec::new(),
        })
    }

    async fn enumerate_playlist(&self, url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        let operation = self.begin(None, "playlist")?;
        let (operation, output) = self
            .run_ytdlp(
                operation,
                self.commands.playlist(url),
                OperationKind::Playlist,
                &self.cancellation,
            )
            .await?;
        if let Err(error) = operation.write_raw("playlist.json", &output.stdout).await {
            return Err(operation.preserve_failure(error).await);
        }
        if let Err(error) = parse_playlist(&output.stdout) {
            return Err(operation.preserve_failure(error).await);
        }
        operation.complete().await?;
        Ok(PlaylistPayload {
            json: output.stdout,
        })
    }

    async fn fetch_thumbnail(&self, video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        let operation = self.workspace.begin(Some(video_id), "thumbnail")?;
        thumbnail::finalize_thumbnail(
            operation,
            thumbnail::fetch_thumbnail(&self.client, video_id, &self.cancellation).await,
        )
        .await
    }

    async fn transcribe_audio(
        &self,
        url: &YoutubeUrl,
        model: &str,
        cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        super::transcription::transcribe(self, url, model, cancellation).await
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        let operation = self.begin(None, "extractor-update")?;
        let (operation, _) = self
            .run_ytdlp(
                operation,
                self.commands.update(),
                OperationKind::Update,
                &self.cancellation,
            )
            .await?;
        operation.complete().await
    }
}

pub(super) fn video_id_from_url(url: &YoutubeUrl) -> Option<VideoId> {
    let parsed = reqwest::Url::parse(url.as_ref()).ok()?;
    let candidate = if parsed.host_str() == Some("youtu.be") {
        parsed.path_segments()?.next()?.to_string()
    } else if let Some(video_id) = parsed
        .query_pairs()
        .find_map(|(name, value)| (name == "v").then(|| value.into_owned()))
    {
        video_id
    } else {
        let mut segments = parsed.path_segments()?;
        match segments.next()? {
            "shorts" | "embed" | "live" => segments.next()?.to_string(),
            _ => return None,
        }
    };
    VideoId::new(&candidate).ok()
}

fn po_listing_warning(stderr: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    stderr.contains("subtitles languages because a po token was not provided")
        || stderr.contains("subtitles require a po token which was not provided")
}
