//! Reading Ollama's `/api/show` capability list.
//!
//! The local lane's whole capability surface: a list of words, one of which may
//! be "thinking". No effort menu, no pricing, no context window — Ollama
//! publishes none of them, and `num_ctx` is something this app chooses rather
//! than reads.

use super::{capability_verdict, ReasoningSupport};
use crate::error::{CoreError, CoreResult};
use serde::Deserialize;

#[derive(Deserialize)]
struct RawOllamaShow {
    // See `RawOpenRouterModel::supported_parameters`: absent vs present-empty differ.
    capabilities: Option<Vec<String>>,
}

pub fn parse_ollama_capabilities(json: &str) -> CoreResult<Vec<String>> {
    let raw: RawOllamaShow = serde_json::from_str(json)
        .map_err(|e| CoreError::LocalAi(format!("could not parse Ollama capabilities: {e}")))?;

    Ok(raw.capabilities.unwrap_or_default())
}

pub fn supports_thinking(capabilities: &[String]) -> bool {
    capabilities.iter().any(|c| c == "thinking")
}

/// Verdict for a local model, from the raw Ollama `/api/show` body. An absent
/// `capabilities` array → `Unknown` (fail open, spec §2: the server never told us);
/// a present array is authoritative.
pub fn ollama_reasoning_support(show_json: &str) -> ReasoningSupport {
    let Ok(raw) = serde_json::from_str::<RawOllamaShow>(show_json) else {
        return ReasoningSupport::Unknown;
    };

    capability_verdict(raw.capabilities.as_deref(), supports_thinking)
}
