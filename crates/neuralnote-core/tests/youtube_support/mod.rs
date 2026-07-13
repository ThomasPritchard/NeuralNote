use crate::support::FsBackend;
use async_trait::async_trait;
use futures::executor::block_on;
use image::{DynamicImage, ImageFormat};
use neuralnote_core::ai::tools::{self, ToolContext};
use neuralnote_core::ai::{
    ActiveSkills, CaptionPayload, CaptionRequest, CaptureCancellation, ChatEvent, Elicitation,
    EventSink, EvidenceRegistry, HardwareSpec, MetadataPayload, PlaylistPayload, RetrievalProvider,
    SkillEnvironment, SkillRegistry, ThumbnailPayload, UserPrompt, VideoId, WriteSession,
    YoutubeIo, YoutubeToolSession, YoutubeUrl,
};
use neuralnote_core::capture::{CaptureError, PricingInput, VaultProfileIo};
use neuralnote_core::CoreResult;
use std::collections::{BTreeSet, VecDeque};
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Default)]
struct NoopSink;

impl EventSink for NoopSink {
    fn send(&mut self, _event: ChatEvent) {}
}

#[derive(Default)]
pub struct ScriptedPrompt {
    answers: Mutex<VecDeque<CoreResult<Option<Vec<String>>>>>,
    pub seen: Mutex<Vec<Elicitation>>,
}

impl ScriptedPrompt {
    pub fn with_answers(answers: impl IntoIterator<Item = Vec<String>>) -> Self {
        Self {
            answers: Mutex::new(answers.into_iter().map(|answer| Ok(Some(answer))).collect()),
            seen: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl UserPrompt for ScriptedPrompt {
    async fn ask(&self, elicitation: Elicitation) -> CoreResult<Option<Vec<String>>> {
        self.seen.lock().unwrap().push(elicitation);
        self.answers.lock().unwrap().pop_front().unwrap_or(Ok(None))
    }
}

pub struct PlaylistIo {
    pub media_type: String,
    pub thumbnail: Vec<u8>,
}

impl Default for PlaylistIo {
    fn default() -> Self {
        let mut thumbnail = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(2, 2)
            .write_to(&mut thumbnail, ImageFormat::Jpeg)
            .unwrap();
        Self {
            media_type: "image/jpeg".into(),
            thumbnail: thumbnail.into_inner(),
        }
    }
}

#[async_trait]
impl YoutubeIo for PlaylistIo {
    async fn inspect_metadata(&self, _url: &YoutubeUrl) -> Result<MetadataPayload, CaptureError> {
        Err(CaptureError::MetadataUnavailable("unused".into()))
    }

    async fn fetch_caption_vtt(
        &self,
        _request: &CaptionRequest,
    ) -> Result<CaptionPayload, CaptureError> {
        Err(CaptureError::CaptionsAbsent("unused".into()))
    }

    async fn enumerate_playlist(&self, _url: &YoutubeUrl) -> Result<PlaylistPayload, CaptureError> {
        Ok(PlaylistPayload {
            json: br#"{
                "_type":"playlist",
                "id":"PL-safe_123",
                "title":"Useful talks",
                "entries":[
                    {"id":"iG9CE55wbtY","title":"First","duration":10},
                    {"id":"UF8uR6Z6KLc","title":"Second","duration":20}
                ]
            }"#
            .to_vec(),
        })
    }

    async fn fetch_thumbnail(&self, _video_id: &VideoId) -> Result<ThumbnailPayload, CaptureError> {
        Ok(ThumbnailPayload {
            media_type: self.media_type.clone(),
            bytes: self.thumbnail.clone(),
        })
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

#[derive(Default)]
pub struct MemoryProfileIo {
    pub loaded: Mutex<Option<Vec<u8>>>,
    pub saved: Mutex<Vec<Vec<u8>>>,
}

impl VaultProfileIo for MemoryProfileIo {
    fn load(&self) -> Result<Option<Vec<u8>>, CaptureError> {
        Ok(self.loaded.lock().unwrap().clone())
    }

    fn save(&self, bytes: &[u8]) -> Result<(), CaptureError> {
        self.saved.lock().unwrap().push(bytes.to_vec());
        Ok(())
    }
}

fn environment() -> SkillEnvironment {
    SkillEnvironment {
        hardware: HardwareSpec {
            total_ram_bytes: 1,
            cpu_cores: 1,
            cpu_brand: "test".into(),
            gpu_label: None,
            arch: "aarch64".into(),
            os: "macos".into(),
            free_disk_bytes: 2_000_000_000,
        },
        app_data_bin_dir: PathBuf::from("/app-data/bin"),
        available_binaries: BTreeSet::new(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn call(
    vault: &std::path::Path,
    retriever: &dyn RetrievalProvider,
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    profile_io: &dyn VaultProfileIo,
    prompt: &dyn UserPrompt,
    name: &str,
    arguments: &str,
) -> tools::ToolResult {
    let mut writes = WriteSession::new(1).unwrap();
    call_with_writes(
        vault,
        retriever,
        io,
        session,
        profile_io,
        prompt,
        name,
        arguments,
        &mut writes,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn call_with_writes(
    vault: &std::path::Path,
    retriever: &dyn RetrievalProvider,
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    profile_io: &dyn VaultProfileIo,
    prompt: &dyn UserPrompt,
    name: &str,
    arguments: &str,
    writes: &mut WriteSession,
) -> tools::ToolResult {
    let pricing = PricingInput::Local;
    call_configured(
        vault,
        retriever,
        io,
        session,
        profile_io,
        prompt,
        name,
        arguments,
        writes,
        Some(&pricing),
        true,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn call_configured(
    vault: &std::path::Path,
    retriever: &dyn RetrievalProvider,
    io: &dyn YoutubeIo,
    session: &mut YoutubeToolSession,
    profile_io: &dyn VaultProfileIo,
    prompt: &dyn UserPrompt,
    name: &str,
    arguments: &str,
    writes: &mut WriteSession,
    pricing: Option<&PricingInput>,
    wire_youtube: bool,
) -> tools::ToolResult {
    let skills = SkillRegistry::built_in(&[]).unwrap();
    let env = environment();
    let mut active = ActiveSkills::new(8);
    let mut sink = NoopSink;
    let allowed = BTreeSet::from([name.to_string()]);
    let mut evidence = EvidenceRegistry::new();
    let mut context = ToolContext::new(
        vault,
        &skills,
        &env,
        &mut active,
        &FsBackend,
        writes,
        &mut sink,
        &allowed,
    );
    if wire_youtube {
        context = context.with_youtube(io, session);
    }
    context = context.with_vault_profile_io(profile_io);
    if let Some(pricing) = pricing {
        context = context.with_pricing(pricing);
    }

    block_on(tools::dispatch(
        "implementation-authored",
        name,
        arguments,
        retriever,
        &mut evidence,
        prompt,
        &mut context,
    ))
}
