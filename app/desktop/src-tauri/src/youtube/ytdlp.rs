use super::process::{EnvironmentPolicy, ProcessSpec};
use super::SANITIZED_PATH;
use neuralnote_core::ai::{CaptionRequest, YoutubeUrl};
use neuralnote_core::capture::{youtube_audio_format_selector, CaptionSource, MAX_VTT_BYTES};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// PyInstaller extraction costs roughly six seconds before network work begins.
const METADATA_TIMEOUT: Duration = Duration::from_secs(90);
const CAPTION_TIMEOUT: Duration = Duration::from_secs(120);
const PLAYLIST_TIMEOUT: Duration = Duration::from_secs(90);
const AUDIO_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(3 * 60);
/// JSON is bounded again by core's parser; runner limits prevent pipe growth first.
const METADATA_STDOUT_LIMIT: usize = 4 * 1024 * 1024;
const PLAYLIST_STDOUT_LIMIT: usize = 8 * 1024 * 1024;
/// File-writing invocations should emit diagnostics, not source material, on pipes.
const FILE_COMMAND_STDOUT_LIMIT: usize = 1024 * 1024;
const YTDLP_STDERR_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PotRouting {
    pub(super) plugin_dir: PathBuf,
    pub(super) base_url: String,
    /// Explicitly nonexistent path disables the plugin's CLI-provider probes.
    pub(super) disabled_cli_path: PathBuf,
}

#[derive(Debug, Clone)]
pub(super) struct YtDlpCommands {
    program: PathBuf,
    runtime_dir: PathBuf,
}

impl YtDlpCommands {
    pub(super) fn new(program: PathBuf) -> Self {
        let runtime_dir = program
            .parent()
            .and_then(Path::parent)
            .unwrap_or_else(|| Path::new("/"))
            .join("yt-dlp-runtime");
        Self {
            program,
            runtime_dir,
        }
    }

    pub(super) fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }

    pub(super) fn metadata(&self, url: &YoutubeUrl) -> ProcessSpec {
        self.spec(
            [
                OsString::from("--dump-single-json"),
                OsString::from("--skip-download"),
                OsString::from("--no-playlist"),
                OsString::from(url.as_ref()),
            ],
            &self.runtime_dir,
            METADATA_TIMEOUT,
            METADATA_STDOUT_LIMIT,
        )
    }

    pub(super) fn captions(
        &self,
        request: &CaptionRequest,
        workspace: &Path,
        pot: Option<&PotRouting>,
    ) -> ProcessSpec {
        let source_flag = match request.source {
            CaptionSource::Human => "--write-subs",
            CaptionSource::Automatic => "--write-auto-subs",
        };
        let mut args = vec![
            OsString::from(source_flag),
            OsString::from("--skip-download"),
            OsString::from("--sub-langs"),
            OsString::from(&request.language),
            OsString::from("--sub-format"),
            OsString::from("vtt"),
            OsString::from("--ignore-no-formats-error"),
            OsString::from("--no-playlist"),
            OsString::from("--output"),
            workspace.join("captions.%(ext)s").into_os_string(),
        ];
        if let Some(pot) = pot {
            args.extend([
                OsString::from("--plugin-dirs"),
                pot.plugin_dir.as_os_str().to_owned(),
                OsString::from("--extractor-args"),
                OsString::from(format!("youtubepot-bgutilhttp:base_url={}", pot.base_url)),
                OsString::from("--extractor-args"),
                OsString::from(format!(
                    "youtubepot-bgutilcli:cli_path={}",
                    pot.disabled_cli_path.display()
                )),
            ]);
        }
        // A full validated URL is always last, so a video id beginning with '-'
        // can never become a process option.
        args.push(OsString::from(request.url.as_ref()));
        self.spec(args, workspace, CAPTION_TIMEOUT, FILE_COMMAND_STDOUT_LIMIT)
    }

    pub(super) fn playlist(&self, url: &YoutubeUrl) -> ProcessSpec {
        self.spec(
            [
                OsString::from("--flat-playlist"),
                OsString::from("--dump-single-json"),
                OsString::from(url.as_ref()),
            ],
            &self.runtime_dir,
            PLAYLIST_TIMEOUT,
            PLAYLIST_STDOUT_LIMIT,
        )
    }

    pub(super) fn audio(&self, url: &YoutubeUrl, workspace: &Path) -> ProcessSpec {
        self.spec(
            [
                OsString::from("-f"),
                OsString::from(youtube_audio_format_selector()),
                OsString::from("--max-filesize"),
                OsString::from("256M"),
                OsString::from("--no-playlist"),
                OsString::from("--output"),
                workspace.join("audio.%(ext)s").into_os_string(),
                OsString::from(url.as_ref()),
            ],
            workspace,
            AUDIO_TIMEOUT,
            FILE_COMMAND_STDOUT_LIMIT,
        )
    }

    pub(super) fn update(&self) -> ProcessSpec {
        self.spec(
            [OsString::from("-U")],
            &self.runtime_dir,
            UPDATE_TIMEOUT,
            FILE_COMMAND_STDOUT_LIMIT,
        )
    }

    pub(super) const fn caption_file_limit() -> usize {
        MAX_VTT_BYTES
    }

    fn spec(
        &self,
        args: impl IntoIterator<Item = OsString>,
        cwd: &Path,
        timeout: Duration,
        stdout_limit: usize,
    ) -> ProcessSpec {
        let mut command_args = Vec::from([
            OsString::from("--ignore-config"),
            OsString::from("--no-plugin-dirs"),
        ]);
        command_args.extend(args);
        ProcessSpec {
            program: self.program.clone(),
            args: command_args,
            cwd: Some(cwd.to_path_buf()),
            environment: EnvironmentPolicy::ClearAndSet(self.environment()),
            timeout,
            stdout_limit,
            stderr_limit: YTDLP_STDERR_LIMIT,
        }
    }

    fn environment(&self) -> BTreeMap<OsString, OsString> {
        BTreeMap::from([
            (OsString::from("PATH"), OsString::from(SANITIZED_PATH)),
            (
                OsString::from("HOME"),
                self.runtime_dir.join("home").into_os_string(),
            ),
            (
                OsString::from("XDG_CACHE_HOME"),
                self.runtime_dir.join("cache").into_os_string(),
            ),
            (
                OsString::from("TMPDIR"),
                self.runtime_dir.join("tmp").into_os_string(),
            ),
        ])
    }
}
