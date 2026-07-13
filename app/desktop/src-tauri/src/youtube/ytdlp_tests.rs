use super::process::EnvironmentPolicy;
use super::ytdlp::{PotRouting, YtDlpCommands};
use neuralnote_core::ai::{CaptionRequest, PotMode, YoutubeUrl};
use neuralnote_core::capture::{youtube_audio_format_selector, CaptionSource, MAX_VTT_BYTES};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

fn command_builder() -> YtDlpCommands {
    YtDlpCommands::new(PathBuf::from("/app-data/bin/yt-dlp"))
}

fn args(spec: &super::process::ProcessSpec) -> Vec<String> {
    spec.args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

fn assert_sanitized_path(spec: &super::process::ProcessSpec) {
    let EnvironmentPolicy::ClearAndSet(environment) = &spec.environment;
    assert_eq!(
        environment.get(&OsString::from("PATH")),
        Some(&OsString::from("/usr/bin:/bin"))
    );
}

#[test]
fn metadata_argv_is_static_bounded_and_keeps_the_full_url_last() {
    let url = YoutubeUrl::new("https://youtu.be/-abcdefghij").unwrap();

    let spec = command_builder().metadata(&url);

    assert_eq!(
        args(&spec),
        [
            "--ignore-config",
            "--no-plugin-dirs",
            "--dump-single-json",
            "--skip-download",
            "--no-playlist",
            "https://youtu.be/-abcdefghij",
        ]
    );
    assert_eq!(spec.stdout_limit, 4 * 1024 * 1024);
    assert_sanitized_path(&spec);
}

#[test]
fn human_and_auto_caption_argv_use_the_load_bearing_subtitle_flags() {
    let workspace = Path::new("/tmp/capture");
    let url = YoutubeUrl::new("https://www.youtube.com/watch?v=jNQXAC9IVRw").unwrap();
    let human = CaptionRequest {
        url: url.clone(),
        language: "en-GB".into(),
        source: CaptionSource::Human,
        pot: PotMode::Disabled,
    };
    let automatic = CaptionRequest {
        source: CaptionSource::Automatic,
        ..human.clone()
    };

    let human_args = args(&command_builder().captions(&human, workspace, None));
    let auto_args = args(&command_builder().captions(&automatic, workspace, None));

    assert_eq!(human_args[0], "--ignore-config");
    assert_eq!(human_args[1], "--no-plugin-dirs");
    assert_eq!(human_args[2], "--write-subs");
    assert_eq!(auto_args[0], "--ignore-config");
    assert_eq!(auto_args[1], "--no-plugin-dirs");
    assert_eq!(auto_args[2], "--write-auto-subs");
    for actual in [&human_args, &auto_args] {
        assert!(actual
            .windows(2)
            .any(|pair| pair == ["--sub-langs", "en-GB"]));
        assert!(actual
            .windows(2)
            .any(|pair| pair == ["--sub-format", "vtt"]));
        assert!(actual.contains(&"--skip-download".into()));
        assert!(actual.contains(&"--ignore-no-formats-error".into()));
        assert!(actual.contains(&"--no-playlist".into()));
        assert_eq!(actual.last().unwrap(), url.as_ref());
    }
    let spec = command_builder().captions(&human, workspace, None);
    assert_eq!(spec.stdout_limit, 1024 * 1024);
    assert!(spec.stderr_limit >= 64 * 1024);
    assert_sanitized_path(&spec);
}

#[test]
fn pot_caption_argv_points_only_at_the_http_provider_and_plugin_directory() {
    let workspace = Path::new("/tmp/capture");
    let request = CaptionRequest {
        url: YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap(),
        language: "en".into(),
        source: CaptionSource::Human,
        pot: PotMode::Prefer,
    };
    let pot = PotRouting {
        plugin_dir: PathBuf::from("/app-data/assets"),
        base_url: "http://127.0.0.1:4416".into(),
        disabled_cli_path: PathBuf::from("/app-data/pot-runtime/disabled-bgutil-pot"),
    };

    let spec = command_builder().captions(&request, workspace, Some(&pot));
    let actual = args(&spec);

    assert_eq!(&actual[..2], ["--ignore-config", "--no-plugin-dirs"]);

    assert!(actual
        .windows(2)
        .any(|pair| { pair == ["--plugin-dirs", "/app-data/assets"] }));
    assert!(actual.windows(2).any(|pair| {
        pair == [
            "--extractor-args",
            "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
        ]
    }));
    assert!(actual.windows(2).any(|pair| {
        pair == [
            "--extractor-args",
            "youtubepot-bgutilcli:cli_path=/app-data/pot-runtime/disabled-bgutil-pot",
        ]
    }));
    assert_sanitized_path(&spec);
}

#[test]
fn audio_playlist_and_update_shapes_are_fixed() {
    let commands = command_builder();
    let url = YoutubeUrl::new("https://youtu.be/jNQXAC9IVRw").unwrap();

    let audio = args(&commands.audio(&url, Path::new("/tmp/capture")));
    assert_eq!(&audio[..2], ["--ignore-config", "--no-plugin-dirs"]);
    assert!(audio
        .windows(2)
        .any(|pair| pair == ["-f", youtube_audio_format_selector()]));
    assert!(audio
        .windows(2)
        .any(|pair| pair == ["--max-filesize", "256M"]));
    assert!(audio.contains(&"--no-playlist".into()));
    assert_eq!(audio.last().unwrap(), url.as_ref());

    assert_eq!(
        args(&commands.playlist(&url)),
        [
            "--ignore-config",
            "--no-plugin-dirs",
            "--flat-playlist",
            "--dump-single-json",
            "https://youtu.be/jNQXAC9IVRw",
        ]
    );
    assert_eq!(
        args(&commands.update()),
        ["--ignore-config", "--no-plugin-dirs", "-U"]
    );
}

#[test]
fn caption_file_limit_matches_the_shared_vtt_parser_limit() {
    assert_eq!(YtDlpCommands::caption_file_limit(), MAX_VTT_BYTES);
}

#[test]
fn sanitized_path_policy_has_one_production_definition() {
    const SANITIZED_PATH_LITERAL: &str = concat!("/usr", "/bin:/bin");
    let production_sources = [
        include_str!("mod.rs"),
        include_str!("ytdlp.rs"),
        include_str!("whisper.rs"),
        include_str!("pot_protocol.rs"),
    ];

    let definitions = production_sources
        .iter()
        .map(|source| source.matches(SANITIZED_PATH_LITERAL).count())
        .sum::<usize>();

    assert_eq!(definitions, 1, "sanitized PATH policy must have one owner");
}
