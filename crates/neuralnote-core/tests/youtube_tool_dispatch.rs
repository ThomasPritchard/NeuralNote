mod support;

use async_trait::async_trait;
use futures::executor::block_on;
use neuralnote_core::ai::tools::{
    self, ToolContext, ToolOutcome, TOOL_FETCH_CAPTIONS, TOOL_FETCH_VIDEO_INFO,
    TOOL_TRANSCRIBE_AUDIO,
};
use neuralnote_core::ai::{
    ActiveSkills, CaptionPayload, CaptionRequest, CaptureCancellation, ChatEvent, Elicitation,
    EventSink, EvidenceRegistry, HardwareSpec, KeywordRetriever, MetadataPayload, NoUserPrompt,
    PlaylistPayload, PotMode, SkillEnvironment, SkillRegistry, ThumbnailPayload, UserPrompt,
    VideoId, WriteSession, YoutubeAnnotation, YoutubeIo, YoutubeRequirementInstaller,
    YoutubeToolSession, YoutubeUrl,
};
use neuralnote_core::capture::{CaptureError, ModelPricing, PricingInput};
use std::collections::{BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use support::FsBackend;

struct InstallPrompt;

#[async_trait]
impl UserPrompt for InstallPrompt {
    async fn ask(
        &self,
        elicitation: Elicitation,
    ) -> neuralnote_core::CoreResult<Option<Vec<String>>> {
        assert!(elicitation.question.contains("compil"));
        Ok(Some(vec!["install".into()]))
    }
}

struct PanicPrompt;

#[async_trait]
impl UserPrompt for PanicPrompt {
    async fn ask(
        &self,
        _elicitation: Elicitation,
    ) -> neuralnote_core::CoreResult<Option<Vec<String>>> {
        panic!("unproven caption absence must not prompt for Whisper")
    }
}

#[derive(Default)]
struct RecordingInstaller(AtomicUsize);

#[async_trait]
impl YoutubeRequirementInstaller for RecordingInstaller {
    async fn install_whisper_bundle(
        &self,
        sink: &mut dyn EventSink,
        _cancellation: &CaptureCancellation,
    ) -> Result<(), CaptureError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        sink.send(ChatEvent::SkillStep {
            message: "Compiling locally".into(),
        });
        Ok(())
    }
}

#[derive(Default)]
struct NoopSink;

impl EventSink for NoopSink {
    fn send(&mut self, _event: ChatEvent) {}
}

const URL: &str = "https://www.youtube.com/watch?v=iG9CE55wbtY";
const VTT: &[u8] = b"WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nHello &amp; welcome\n";

fn metadata(subtitles: &str, automatic: &str) -> Vec<u8> {
    format!(
        r#"{{
            "id":"iG9CE55wbtY",
            "title":"Do schools kill creativity?",
            "uploader":"TED",
            "duration":123,
            "subtitles":{subtitles},
            "automatic_captions":{automatic},
            "future_secret":{{"path":"/tmp/extractor-secret"}}
        }}"#
    )
    .into_bytes()
}

struct ScriptedYoutubeIo {
    metadata: Mutex<VecDeque<Result<MetadataPayload, CaptureError>>>,
    captions: Mutex<VecDeque<Result<CaptionPayload, CaptureError>>>,
    caption_pot_modes: Mutex<Vec<PotMode>>,
    transcriptions: Mutex<VecDeque<Result<CaptionPayload, CaptureError>>>,
    updates: AtomicUsize,
    transcribe_calls: AtomicUsize,
    cancel_during_transcription: std::sync::atomic::AtomicBool,
    cancel_during_update: Mutex<Option<CaptureCancellation>>,
}

impl ScriptedYoutubeIo {
    fn new(metadata_json: Vec<u8>) -> Self {
        Self::with_metadata_result(Ok(MetadataPayload {
            json: metadata_json,
            annotations: Vec::new(),
        }))
    }

    fn with_metadata_result(result: Result<MetadataPayload, CaptureError>) -> Self {
        Self {
            metadata: Mutex::new(VecDeque::from([result])),
            captions: Mutex::new(VecDeque::new()),
            caption_pot_modes: Mutex::new(Vec::new()),
            transcriptions: Mutex::new(VecDeque::new()),
            updates: AtomicUsize::new(0),
            transcribe_calls: AtomicUsize::new(0),
            cancel_during_transcription: std::sync::atomic::AtomicBool::new(false),
            cancel_during_update: Mutex::new(None),
        }
    }

    fn push_caption(&self, value: Result<CaptionPayload, CaptureError>) {
        self.captions.lock().unwrap().push_back(value);
    }

    fn push_transcription(&self, value: Result<CaptionPayload, CaptureError>) {
        self.transcriptions.lock().unwrap().push_back(value);
    }

    fn cancel_during_transcription(&self) {
        self.cancel_during_transcription
            .store(true, Ordering::SeqCst);
    }

    fn cancel_during_update(&self, cancellation: CaptureCancellation) {
        *self.cancel_during_update.lock().unwrap() = Some(cancellation);
    }
}

#[async_trait]
impl YoutubeIo for ScriptedYoutubeIo {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        self.metadata
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted metadata response")
    }

    async fn fetch_caption_vtt(
        &self,
        request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        self.caption_pot_modes.lock().unwrap().push(request.pot);
        self.captions
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted caption response")
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
        cancellation: &CaptureCancellation,
    ) -> Result<CaptionPayload, CaptureError> {
        self.transcribe_calls.fetch_add(1, Ordering::SeqCst);
        if self
            .cancel_during_transcription
            .swap(false, Ordering::SeqCst)
        {
            cancellation.cancel();
        }
        self.transcriptions
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted transcription response")
    }

    async fn update_extractor(&self) -> Result<(), CaptureError> {
        self.updates.fetch_add(1, Ordering::SeqCst);
        if let Some(cancellation) = self.cancel_during_update.lock().unwrap().take() {
            cancellation.cancel();
        }
        Ok(())
    }
}

fn environment(whisper_installed: bool) -> SkillEnvironment {
    let bin = PathBuf::from("/app-data/bin");
    let assets = PathBuf::from("/app-data/assets");
    let mut files = BTreeSet::new();
    if whisper_installed {
        files.insert(bin.join("whisper-cli"));
        files.insert(assets.join("ggml-small.en.bin"));
    }
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
        app_data_bin_dir: bin,
        available_binaries: files,
    }
}

fn call(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    environment: &SkillEnvironment,
    name: &str,
    arguments: &str,
) -> tools::ToolResult {
    call_with_pricing(
        io,
        session,
        environment,
        name,
        arguments,
        &PricingInput::Local,
    )
}

fn call_with_pricing(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    environment: &SkillEnvironment,
    name: &str,
    arguments: &str,
    pricing: &PricingInput,
) -> tools::ToolResult {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let mut active = ActiveSkills::new(8);
    let mut writes = WriteSession::new(1).unwrap();
    let mut sink = NoopSink;
    let allowed = BTreeSet::from([name.to_string()]);
    let mut evidence = EvidenceRegistry::new();
    let mut context = ToolContext::new(
        vault.path(),
        &skills,
        environment,
        &mut active,
        &FsBackend,
        &mut writes,
        &mut sink,
        &allowed,
    )
    .with_youtube(io, session)
    .with_pricing(pricing);

    block_on(tools::dispatch(
        "youtube-call",
        name,
        arguments,
        &retriever,
        &mut evidence,
        &NoUserPrompt,
        &mut context,
    ))
}

fn prove_caption_absence(io: &dyn YoutubeIo, session: &mut YoutubeToolSession) {
    let result = call(
        io,
        session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert_eq!(value["error"]["kind"], "captions_absent");
    assert_eq!(value["error"]["next_action"], "offer_whisper");
}

fn call_with_installer(
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    installer: &dyn YoutubeRequirementInstaller,
    prompt: &dyn UserPrompt,
) -> tools::ToolResult {
    let vault = tempfile::tempdir().unwrap();
    let retriever = KeywordRetriever::new(vault.path());
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let mut active = ActiveSkills::new(8);
    let mut writes = WriteSession::new(1).unwrap();
    let mut sink = NoopSink;
    let allowed = BTreeSet::from([TOOL_TRANSCRIBE_AUDIO.to_string()]);
    let mut evidence = EvidenceRegistry::new();
    let environment = environment(false);
    let pricing = PricingInput::Local;
    let mut context = ToolContext::new(
        vault.path(),
        &skills,
        &environment,
        &mut active,
        &FsBackend,
        &mut writes,
        &mut sink,
        &allowed,
    )
    .with_youtube(io, session)
    .with_youtube_requirements(installer)
    .with_pricing(&pricing);
    block_on(tools::dispatch(
        "install-call",
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
        &retriever,
        &mut evidence,
        prompt,
        &mut context,
    ))
}

#[test]
fn fetch_video_info_returns_only_validated_projection() {
    let io = ScriptedYoutubeIo::new(metadata(
        r#"{"en":[{"ext":"vtt","url":"https://captions.example/private"}]}"#,
        "{}",
    ));
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["video_id"], "iG9CE55wbtY");
    assert_eq!(value["title"], "Do schools kill creativity?");
    assert_eq!(
        value["caption_inventory"]["human"],
        serde_json::json!(["en"])
    );
    assert!(!result.content.contains("captions.example"));
    assert!(!result.content.contains("future_secret"));
    assert!(!result.content.contains("/tmp/"));
}

#[test]
fn fetch_video_info_surfaces_metadata_annotations() {
    let io = ScriptedYoutubeIo::with_metadata_result(Ok(MetadataPayload {
        json: metadata("{}", "{}"),
        annotations: vec![YoutubeAnnotation::SubtitleListingWithheld],
    }));
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["annotations"].as_array().unwrap().len(), 1);
    assert_eq!(value["caption_inventory"]["genuinely_absent"], false);
    assert!(value["annotations"][0]
        .as_str()
        .unwrap()
        .contains("PO-token warning"));
}

#[test]
fn withheld_subtitle_listing_cannot_unlock_whisper_from_empty_maps() {
    let io = ScriptedYoutubeIo::with_metadata_result(Ok(MetadataPayload {
        json: metadata("{}", "{}"),
        annotations: vec![YoutubeAnnotation::SubtitleListingWithheld],
    }));
    let mut session = YoutubeToolSession::default();
    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["error"]["next_action"], "surface");
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("caption listing was withheld"));
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("absence is unproven"));
    assert!(!session.can_transcribe(&YoutubeUrl::new(URL).unwrap()));
}

#[test]
fn host_failure_details_are_bounded_and_never_expose_paths_to_the_model() {
    let secret = format!("/private/tmp/neuralnote-secret\n{}", "x".repeat(2_000));
    let io =
        ScriptedYoutubeIo::with_metadata_result(Err(CaptureError::MetadataUnavailable(secret)));
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("metadata_unavailable"));
    assert!(!result.content.contains("/private/tmp"));
    assert!(result.content.len() < 1_000);
}

#[test]
fn youtube_tools_reject_malformed_arguments_and_non_youtube_urls() {
    for tool in [
        TOOL_FETCH_VIDEO_INFO,
        TOOL_FETCH_CAPTIONS,
        TOOL_TRANSCRIBE_AUDIO,
    ] {
        let malformed = call(
            &ScriptedYoutubeIo::new(metadata("{}", "{}")),
            &mut YoutubeToolSession::default(),
            &environment(true),
            tool,
            "{not-json",
        );
        assert_eq!(malformed.outcome, ToolOutcome::Rejected, "{tool}");
        assert!(malformed.content.contains("arguments"), "{tool}");

        let invalid_url = call(
            &ScriptedYoutubeIo::new(metadata("{}", "{}")),
            &mut YoutubeToolSession::default(),
            &environment(true),
            tool,
            r#"{"url":"https://example.com/not-youtube"}"#,
        );
        assert_eq!(invalid_url.outcome, ToolOutcome::Rejected, "{tool}");
        assert!(invalid_url.content.contains("invalid_source"), "{tool}");
    }

    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let shell_suffix = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(true),
        TOOL_FETCH_VIDEO_INFO,
        r#"{"url":"https://www.youtube.com/watch?v=x $(rm -rf ~)"}"#,
    );
    assert_eq!(shell_suffix.outcome, ToolOutcome::Rejected);
    assert!(shell_suffix.content.contains("invalid_source"));
    assert_eq!(io.metadata.lock().unwrap().len(), 1);
}

#[test]
fn captions_surface_invalid_language_inventory_and_vtt_without_fallback() {
    let invalid_language = call(
        &ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}")),
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":""}}"#),
    );
    assert!(invalid_language.content.contains("invalid_metadata"));

    let unavailable_language = call(
        &ScriptedYoutubeIo::new(metadata(r#"{"fr":[{"ext":"vtt"}]}"#, "{}")),
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );
    assert!(unavailable_language.content.contains("invalid_metadata"));
    assert!(!unavailable_language.content.contains("offer_whisper"));

    let invalid_vtt = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    invalid_vtt.push_caption(Ok(CaptionPayload {
        vtt: b"not webvtt".to_vec(),
        annotations: Vec::new(),
    }));
    let result = call(
        &invalid_vtt,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );
    assert!(result.content.contains("invalid_vtt"));
    assert!(result.content.contains("surface"));
}

#[test]
fn pre_cancelled_transcription_never_reaches_the_host() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let cancellation = CaptureCancellation::default();
    let mut session = YoutubeToolSession::new(cancellation.clone());
    prove_caption_absence(&io, &mut session);
    cancellation.cancel();

    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert!(result.content.contains("cancelled"));
    assert_eq!(io.transcribe_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn empty_and_windows_host_errors_have_safe_model_messages() {
    for (detail, forbidden) in [("", "never-present"), (r"C:\secret\token.txt", "secret")] {
        let io = ScriptedYoutubeIo::with_metadata_result(Err(CaptureError::MetadataUnavailable(
            detail.into(),
        )));
        let result = call(
            &io,
            &mut YoutubeToolSession::default(),
            &environment(false),
            TOOL_FETCH_VIDEO_INFO,
            &format!(r#"{{"url":"{URL}"}}"#),
        );
        let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
        assert!(!value["error"]["message"]
            .as_str()
            .unwrap()
            .contains(forbidden));
        assert!(!value["error"]["message"].as_str().unwrap().is_empty());
    }
}

#[test]
fn fetch_captions_parses_vtt_and_returns_rendered_source_record() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: vec![YoutubeAnnotation::PotUnavailable],
    }));
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["provenance"], "captions:en");
    assert!(value["transcript"]
        .as_str()
        .unwrap()
        .contains("[00:00:00](https://youtu.be/iG9CE55wbtY?t=0) Hello & welcome"));
    assert!(!result.content.contains("WEBVTT"));
    assert_eq!(value["annotations"].as_array().unwrap().len(), 1);
    assert_eq!(value["cost_estimate"]["display"], "free — runs locally");
    assert_eq!(value["cost_estimate"]["wordCount"], 3);
}

#[test]
fn pricing_failure_preserves_completed_caption_result_with_an_annotation() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let pricing = PricingInput::Hosted(ModelPricing {
        model: "provider/model".into(),
        input_usd_per_token: f64::NAN,
    });
    let result = call_with_pricing(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
        &pricing,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert!(value["transcript"].as_str().unwrap().contains("Hello"));
    assert!(value["cost_estimate"].is_null());
    assert!(value["annotations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|annotation| annotation
            .as_str()
            .unwrap()
            .contains("cost estimate unavailable (invalid_metadata)")));
}

#[test]
fn pricing_failure_preserves_completed_transcription_with_an_annotation() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();
    prove_caption_absence(&io, &mut session);
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let pricing = PricingInput::Hosted(ModelPricing {
        model: "provider/model".into(),
        input_usd_per_token: f64::INFINITY,
    });
    let result = call_with_pricing(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
        &pricing,
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert!(value["transcript"].as_str().unwrap().contains("Hello"));
    assert!(value["cost_estimate"].is_null());
    assert!(value["annotations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|annotation| annotation
            .as_str()
            .unwrap()
            .contains("cost estimate unavailable (invalid_metadata)")));
}

#[test]
fn pot_failure_retries_without_sidecar_and_surfaces_annotation() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Err(CaptureError::PotUnavailable(
        "bgutil provider timed out".into(),
    )));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    let annotations = value["annotations"].as_array().unwrap();
    assert_eq!(annotations.len(), 1);
    assert!(annotations[0]
        .as_str()
        .unwrap()
        .contains("continued without POT"));
    assert_eq!(io.updates.load(Ordering::SeqCst), 0);
    assert_eq!(
        *io.caption_pot_modes.lock().unwrap(),
        [PotMode::Prefer, PotMode::Disabled]
    );
}

#[test]
fn caption_retry_composes_extractor_update_then_plain_without_pot() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Err(CaptureError::ExtractorStale("stale extractor".into())));
    io.push_caption(Err(CaptureError::PotUnavailable("sidecar down".into())));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));

    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
    assert_eq!(
        *io.caption_pot_modes.lock().unwrap(),
        [PotMode::Prefer, PotMode::Prefer, PotMode::Disabled]
    );
    assert!(result.content.contains("continued without POT"));
}

#[test]
fn caption_retry_composes_plain_without_pot_then_extractor_update() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Err(CaptureError::PotUnavailable("sidecar down".into())));
    io.push_caption(Err(CaptureError::ExtractorStale("stale extractor".into())));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));

    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}","lang":"en"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
    assert_eq!(
        *io.caption_pot_modes.lock().unwrap(),
        [PotMode::Prefer, PotMode::Disabled, PotMode::Disabled]
    );
    assert!(result.content.contains("continued without POT"));
}

#[test]
fn extractor_staleness_updates_and_retries_at_most_once() {
    let io = ScriptedYoutubeIo::new(Vec::new());
    *io.metadata.lock().unwrap() = VecDeque::from([
        Err(CaptureError::ExtractorStale(
            "nsig extraction failed".into(),
        )),
        Ok(MetadataPayload {
            json: metadata("{}", "{}"),
            annotations: Vec::new(),
        }),
    ]);
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
}

#[test]
fn exhausted_internal_extractor_retry_is_surfaced_not_offered_again() {
    let io = ScriptedYoutubeIo::new(Vec::new());
    *io.metadata.lock().unwrap() = VecDeque::from([
        Err(CaptureError::ExtractorStale("first failure".into())),
        Err(CaptureError::ExtractorStale("retry still stale".into())),
    ]);
    let result = call(
        &io,
        &mut YoutubeToolSession::default(),
        &environment(false),
        TOOL_FETCH_VIDEO_INFO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    let value: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert_eq!(value["error"]["kind"], "extractor_stale");
    assert_eq!(value["error"]["next_action"], "surface");
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
}

#[test]
fn only_genuine_caption_absence_unlocks_whisper_for_that_source() {
    let absent = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();
    let absent_result = call(
        &absent,
        &mut session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );
    assert_eq!(absent_result.outcome, ToolOutcome::Rejected);
    assert!(absent_result.content.contains("captions_absent"));
    assert!(session.can_transcribe(&YoutubeUrl::new(URL).unwrap()));

    absent.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let transcript = call(
        &absent,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );
    assert_eq!(transcript.outcome, ToolOutcome::Action);
    assert!(transcript.content.contains("whisper:small.en"));
    assert!(transcript
        .content
        .contains("[00:00:00](https://youtu.be/iG9CE55wbtY?t=0) Hello & welcome"));

    let denied = call(
        &absent,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        r#"{"url":"https://youtu.be/different"}"#,
    );
    assert_eq!(denied.outcome, ToolOutcome::Rejected);
    assert!(denied.content.contains("requirement_missing"));
    assert!(denied.content.contains("surface"));
    assert_eq!(absent.transcribe_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn blocked_caption_fetch_is_terminal_and_never_unlocks_whisper() {
    let io = ScriptedYoutubeIo::new(metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}"));
    io.push_caption(Err(CaptureError::YoutubeBlocked(
        "Sign in to confirm you're not a bot".into(),
    )));
    let mut session = YoutubeToolSession::default();
    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("youtube_blocked"));
    assert!(result.content.contains("terminal"));
    assert!(!session.can_transcribe(&YoutubeUrl::new(URL).unwrap()));
}

#[test]
fn block_latches_for_the_run_and_prevents_further_youtube_io() {
    let metadata_json = metadata(r#"{"en":[{"ext":"vtt"}]}"#, "{}");
    let io = ScriptedYoutubeIo::new(metadata_json.clone());
    io.metadata.lock().unwrap().push_back(Ok(MetadataPayload {
        json: metadata_json,
        annotations: Vec::new(),
    }));
    io.push_caption(Err(CaptureError::YoutubeBlocked(
        "Sign in to confirm you're not a bot".into(),
    )));
    io.push_caption(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let mut session = YoutubeToolSession::default();

    let first = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );
    let second = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_FETCH_CAPTIONS,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(first.outcome, ToolOutcome::Rejected);
    assert_eq!(second.outcome, ToolOutcome::Rejected);
    assert!(second.content.contains("youtube_blocked"));
    assert_eq!(io.metadata.lock().unwrap().len(), 1);
    assert_eq!(io.captions.lock().unwrap().len(), 1);
}

#[test]
fn transcribe_requires_the_optional_whisper_bundle() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();

    let result = call(
        &io,
        &mut session,
        &environment(false),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("requirement_missing"));
    assert_eq!(io.transcribe_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn missing_whisper_bundle_is_installed_after_implementation_authored_consent() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();
    prove_caption_absence(&io, &mut session);
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let installer = RecordingInstaller::default();

    let result = call_with_installer(&io, &mut session, &installer, &InstallPrompt);

    assert_eq!(result.outcome, ToolOutcome::Action);
    assert_eq!(installer.0.load(Ordering::SeqCst), 1);
    assert!(result.content.contains("whisper:small.en"));
}

#[test]
fn unproven_caption_absence_never_prompts_or_installs_whisper() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    let mut session = YoutubeToolSession::default();
    let installer = RecordingInstaller::default();

    let result = call_with_installer(&io, &mut session, &installer, &PanicPrompt);

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result
        .content
        .contains("caption absence has not been proven"));
    assert_eq!(installer.0.load(Ordering::SeqCst), 0);
}

#[test]
fn cancellation_between_transcription_attempts_prevents_update_and_retry() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.push_transcription(Err(CaptureError::ExtractorStale(
        "audio extraction went stale".into(),
    )));
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    io.cancel_during_transcription();
    let cancellation = CaptureCancellation::default();
    let mut session = YoutubeToolSession::new(cancellation);
    prove_caption_absence(&io, &mut session);

    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("cancelled"));
    assert_eq!(io.transcribe_calls.load(Ordering::SeqCst), 1);
    assert_eq!(io.updates.load(Ordering::SeqCst), 0);
}

#[test]
fn cancellation_during_extractor_update_prevents_transcription_retry() {
    let io = ScriptedYoutubeIo::new(metadata("{}", "{}"));
    io.push_transcription(Err(CaptureError::ExtractorStale(
        "audio extraction went stale".into(),
    )));
    io.push_transcription(Ok(CaptionPayload {
        vtt: VTT.to_vec(),
        annotations: Vec::new(),
    }));
    let cancellation = CaptureCancellation::default();
    io.cancel_during_update(cancellation.clone());
    let mut session = YoutubeToolSession::new(cancellation);
    prove_caption_absence(&io, &mut session);

    let result = call(
        &io,
        &mut session,
        &environment(true),
        TOOL_TRANSCRIBE_AUDIO,
        &format!(r#"{{"url":"{URL}"}}"#),
    );

    assert_eq!(result.outcome, ToolOutcome::Rejected);
    assert!(result.content.contains("cancelled"));
    assert_eq!(io.transcribe_calls.load(Ordering::SeqCst), 1);
    assert_eq!(io.updates.load(Ordering::SeqCst), 1);
}
