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

pub mod events;
pub mod evidence;
pub mod llm;
pub mod local;
pub mod openai;
pub mod orchestrator;
pub mod provider_config;
pub mod retrieval;
pub mod tools;
pub mod verify;

pub use events::{ChatEvent, EventSink};
pub use evidence::{EvidenceRegistry, EvidenceSpan};
pub use llm::{Completion, LlmClient, LlmMessage, LlmRequest, Role, ToolCall};
pub use local::hf::{parse_hf_metadata, HfModelMeta};
pub use local::pull::{parse_pull_line, PullEvent, PullSink};
pub use local::tags::{parse_installed_models, InstalledModel};
pub use local::{
    curated_candidates, is_curated_model, recommend_model, CandidateModel, HardwareSpec,
    Recommendation, DEFAULT_LOCAL_MODEL,
};
pub use orchestrator::{run_chat, Guards, DEFAULT_MODEL};
pub use provider_config::{
    read_provider_config, write_provider_config, ProviderConfig, ProviderKind,
};
pub use retrieval::{KeywordRetriever, ListOutcome, NoteMeta, RetrievalProvider, SearchOutcome};
pub use verify::CitationVerifier;
