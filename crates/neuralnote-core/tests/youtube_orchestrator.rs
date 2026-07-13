mod support;

use async_trait::async_trait;
use futures::executor::block_on;
use neuralnote_core::ai::skills::YOUTUBE_DISTIL_SKILL_ID;
use neuralnote_core::ai::{
    run_chat, CaptionPayload, CaptionRequest, CaptureCancellation, ChatEvent, Completion,
    EventSink, Guards, HardwareSpec, KeywordRetriever, LlmClient, LlmRequest, MetadataPayload,
    NoUserPrompt, PlaylistPayload, SkillEnvironment, SkillRegistry, SkillServices,
    ThumbnailPayload, ToolCall, VideoId, YoutubeIo, YoutubeUrl,
};
use neuralnote_core::capture::{CaptureError, UnavailableVaultProfileIo};
use neuralnote_core::CoreResult;
use std::collections::{BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use support::FsBackend;

#[derive(Default)]
struct Sink(Vec<ChatEvent>);

impl EventSink for Sink {
    fn send(&mut self, event: ChatEvent) {
        self.0.push(event);
    }
}

struct ScriptedLlm {
    turns: Mutex<VecDeque<Completion>>,
    requests: Mutex<Vec<LlmRequest>>,
}

#[async_trait]
impl LlmClient for ScriptedLlm {
    async fn complete(&self, request: &LlmRequest) -> CoreResult<Completion> {
        self.requests.lock().unwrap().push(request.clone());
        Ok(self.turns.lock().unwrap().pop_front().unwrap())
    }

    async fn complete_streaming(
        &self,
        request: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<String> {
        self.requests.lock().unwrap().push(request.clone());
        sink.send(ChatEvent::Answer {
            delta: "Captured.".into(),
        });
        Ok("Captured.".into())
    }
}

struct MetadataIo(AtomicUsize);

#[async_trait]
impl YoutubeIo for MetadataIo {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(MetadataPayload {
            json: br#"{"id":"iG9CE55wbtY","title":"A talk","duration":10,"subtitles":{},"automatic_captions":{}}"#.to_vec(),
            annotations: Vec::new(),
        })
    }

    async fn fetch_caption_vtt(
        &self,
        _request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(CaptureError::CaptionsAbsent("unused".into()))
    }

    async fn enumerate_playlist(&self, _url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        Err(CaptureError::PlaylistInvalid("unused".into()))
    }

    async fn fetch_thumbnail(&self, _video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        Err(CaptureError::ThumbnailRejected("unused".into()))
    }

    async fn transcribe_audio(
        &self,
        _url: &YoutubeUrl,
        _model: &str,
        _cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(CaptureError::TranscriptionFailed("unused".into()))
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        Ok(())
    }
}

struct LargeTranscriptIo(AtomicUsize);

#[async_trait]
impl YoutubeIo for LargeTranscriptIo {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(MetadataPayload {
            json: br#"{"id":"iG9CE55wbtY","title":"A long talk","duration":3600,"subtitles":{"en":[{"ext":"vtt"}]},"automatic_captions":{}}"#.to_vec(),
            annotations: Vec::new(),
        })
    }

    async fn fetch_caption_vtt(
        &self,
        _request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        let cue_text = "word ".repeat(12_200);
        Ok(CaptionPayload {
            vtt: format!("WEBVTT\n\n00:00:00.000 --> 00:59:59.000\n{cue_text}\n").into_bytes(),
            annotations: Vec::new(),
        })
    }

    async fn enumerate_playlist(&self, _url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        Err(CaptureError::PlaylistInvalid("unused".into()))
    }

    async fn fetch_thumbnail(&self, _video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        Err(CaptureError::ThumbnailRejected("unused".into()))
    }

    async fn transcribe_audio(
        &self,
        _url: &YoutubeUrl,
        _model: &str,
        _cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(CaptureError::TranscriptionFailed("unused".into()))
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        Ok(())
    }
}

fn environment() -> SkillEnvironment {
    let bin = PathBuf::from("/app-data/bin");
    let assets = PathBuf::from("/app-data/assets");
    SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 16_000_000_000,
            cpu_cores: 8,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 2_000_000_000,
        },
        app_data_bin_dir: bin.clone(),
        available_binaries: BTreeSet::from([
            bin.join("yt-dlp"),
            bin.join("bgutil-pot"),
            assets.join("bgutil-plugin.zip"),
        ]),
    }
}

#[test]
fn preloaded_youtube_skill_reaches_host_io_through_the_orchestrator() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let registry = SkillRegistry::built_in(&[]).unwrap();
    let environment = environment();
    let io = MetadataIo(AtomicUsize::new(0));
    let services = SkillServices::new(&registry, &environment, &NoUserPrompt, &FsBackend, 1)
        .with_youtube_io(&io)
        .with_vault_profile_io(&UnavailableVaultProfileIo)
        .with_capture_cancellation(CaptureCancellation::default());
    let llm = ScriptedLlm {
        turns: Mutex::new(VecDeque::from([
            Completion {
                content: None,
                tool_calls: vec![ToolCall {
                    id: "info".into(),
                    name: "fetch_video_info".into(),
                    arguments: r#"{"url":"https://www.youtube.com/watch?v=iG9CE55wbtY"}"#.into(),
                }],
            },
            Completion {
                content: Some("ready".into()),
                tool_calls: Vec::new(),
            },
        ])),
        requests: Mutex::new(Vec::new()),
    };
    let mut sink = Sink::default();

    block_on(run_chat(
        "distil this video",
        &[],
        vec![YOUTUBE_DISTIL_SKILL_ID.into()],
        vault.path(),
        "test-model",
        &retriever,
        &llm,
        &services,
        &mut sink,
        &Guards::default(),
    ))
    .unwrap();

    assert_eq!(io.0.load(Ordering::SeqCst), 1);
    let requests = llm.requests.lock().unwrap();
    assert!(requests[0]
        .tools
        .iter()
        .any(|schema| { schema["function"]["name"] == "fetch_video_info" }));
    assert!(requests[1].messages.iter().any(|message| {
        message
            .content
            .as_deref()
            .is_some_and(|content| content.contains("iG9CE55wbtY") && !content.contains("/tmp/"))
    }));
    assert!(sink.0.iter().any(|event| matches!(
        event,
        ChatEvent::SkillActivated { id, .. } if id == YOUTUBE_DISTIL_SKILL_ID
    )));
    assert!(matches!(sink.0.last(), Some(ChatEvent::Done)));
}

#[test]
fn youtube_skill_context_override_allows_routing_after_a_long_transcript() {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let registry = SkillRegistry::built_in(&[]).unwrap();
    let environment = environment();
    let io = LargeTranscriptIo(AtomicUsize::new(0));
    let services = SkillServices::new(&registry, &environment, &NoUserPrompt, &FsBackend, 1)
        .with_youtube_io(&io);
    let llm = ScriptedLlm {
        turns: Mutex::new(VecDeque::from([
            Completion {
                content: None,
                tool_calls: vec![ToolCall {
                    id: "captions".into(),
                    name: "fetch_captions".into(),
                    arguments:
                        r#"{"url":"https://www.youtube.com/watch?v=iG9CE55wbtY","lang":"en"}"#
                            .into(),
                }],
            },
            Completion {
                content: None,
                tool_calls: vec![ToolCall {
                    id: "info".into(),
                    name: "fetch_video_info".into(),
                    arguments: r#"{"url":"https://www.youtube.com/watch?v=iG9CE55wbtY"}"#.into(),
                }],
            },
            Completion {
                content: Some("ready".into()),
                tool_calls: Vec::new(),
            },
        ])),
        requests: Mutex::new(Vec::new()),
    };
    let mut sink = Sink::default();

    block_on(run_chat(
        "distil this long video",
        &[],
        vec![YOUTUBE_DISTIL_SKILL_ID.into()],
        vault.path(),
        "test-model",
        &retriever,
        &llm,
        &services,
        &mut sink,
        &Guards::default(),
    ))
    .unwrap();

    assert_eq!(
        io.0.load(Ordering::SeqCst),
        2,
        "the 60k general chat cap must not end a YouTube distil run immediately after transcript capture"
    );
}
