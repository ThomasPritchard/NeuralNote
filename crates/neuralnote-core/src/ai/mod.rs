//! The client-agnostic AI orchestration core — an agentic tool-search chat loop
//! over the user's markdown notes.
//!
//! The model is handed tools to search and read the vault; it answers ONLY from
//! retrieved evidence, and **every citation is re-verified against the source
//! before it is surfaced** (a wrong citation is worse than no answer — the moat).
//! The whole loop emits a stream of typed [`ChatEvent`]s so a UI can render the
//! live "searching / reading / verifying" steps.
//!
//! Everything here is network-free and runtime-agnostic: the LLM transport is the
//! [`LlmClient`] trait (the host app supplies a real HTTP client; unit tests
//! supply a mock), and events leave via the [`EventSink`] trait (the host wraps a
//! Tauri channel; tests collect into a `Vec`). A later embedding-RAG retriever
//! slots in as just another [`RetrievalProvider`] returning the same
//! [`EvidenceSpan`] shape, with no change to the chat layer.

pub mod capabilities;
pub mod elicitation;
pub mod events;
pub mod evidence;
pub mod llm;
pub mod local;
pub mod openai;
pub mod openrouter_catalogue;
pub mod orchestrator;
pub mod provider_config;
pub mod requirement_binaries;
pub mod retrieval;
mod skill_tools;
pub mod skills;
pub mod tools;
pub mod verify;
pub mod write_policy;
pub mod youtube;
mod youtube_route;
mod youtube_selection;
mod youtube_tool_errors;
mod youtube_tool_schemas;
mod youtube_tools;

pub use capabilities::{
    effective_reasoning, ollama_reasoning_support, openrouter_reasoning_support,
    parse_ollama_capabilities, parse_openrouter_input_pricing, parse_openrouter_models,
    supports_reasoning, supports_thinking, ModelCapabilities, ReasoningSupport,
};
pub use elicitation::{elicit_user, ElicitationOutcome};
pub use events::{ChatEvent, ElicitOption, Elicitation, EventSink};
pub use evidence::{EvidenceRegistry, EvidenceSpan};
pub use llm::{
    Completion, LlmClient, LlmMessage, LlmRequest, NoUserPrompt, Role, ToolCall, UserPrompt,
};
pub use local::hf::{parse_hf_metadata, HfModelMeta};
pub use local::pull::{parse_pull_line, PullEvent, PullProgress, PullSink};
pub use local::tags::{parse_installed_models, InstalledModel};
pub use local::{
    curated_candidates, is_curated_model, model_installed, recommend_model, CandidateModel,
    HardwareSpec, Recommendation, DEFAULT_LOCAL_MODEL,
};
pub use openrouter_catalogue::{
    latest_completed_utc_day, rank_openrouter_models, OpenRouterRankedModel, OpenRouterRankedModels,
};
pub use orchestrator::{
    run_chat, Guards, SkillServices, DEFAULT_MODEL, SKILL_ACTIVATION_FAILURE_MARK,
};
pub use provider_config::{
    read_provider_config, write_provider_config, ProbedReasoning, ProviderConfig, ProviderKind,
    ReasoningProbeTarget,
};
pub use requirement_binaries::{
    lookup_requirement_binary, lookup_requirement_source_build, requirement_binaries,
    requirement_files, validate_requirement_binary_name, verify_requirement_checksum,
    RequirementBinary, RequirementFile, RequirementInstallKind, RequirementSourceBuild,
};
pub use retrieval::{KeywordRetriever, ListOutcome, NoteMeta, RetrievalProvider, SearchOutcome};
pub use skills::{
    ActiveSkills, Eligibility, Requirement, RequirementStatus, SkillActivation, SkillEnvironment,
    SkillListing, SkillLookupError, SkillManifest, SkillRegistry, SkillRequirement,
    FIXTURE_SKILL_ID, YOUTUBE_DISTIL_SKILL_ID,
};
pub use verify::CitationVerifier;
pub use write_policy::{
    note_content_hash, write_note_policy, NoteKind, NotePathState, NoteWriteBackend,
    NoteWriteParent, OpenedNoteParent, UnavailableNoteWriter, UndoCheck, UndoEntry, UndoLedger,
    WriteBudget, WriteOutcome, WriteSession, WRITES_PER_WORK_ITEM,
};
pub use youtube::{
    CaptionPayload, CaptionRequest, CaptureCancellation, ExtractorUpdateSession, MetadataPayload,
    PlaylistPayload, PotMode, ThumbnailPayload, UnavailableYoutubeIo, VideoId, YoutubeAnnotation,
    YoutubeIo, YoutubeRequirementInstaller, YoutubeToolSession, YoutubeUrl, WHISPER_MODEL_NAME,
};
