//! Pure model-capability parsing shared by hosted and local AI providers.

use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Whether the selected model can emit reasoning tokens. `Unknown` when the
/// probe could not run (offline, a hand-typed model id, a 5xx) — callers FAIL OPEN.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReasoningSupport {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCapabilities {
    pub id: String,
    pub supported_parameters: Vec<String>,
}

#[derive(Deserialize)]
struct RawOpenRouterModels {
    #[serde(default)]
    data: Vec<RawOpenRouterModel>,
}

#[derive(Deserialize)]
struct RawOpenRouterModel {
    #[serde(default)]
    id: String,
    // `Option`, not `#[serde(default)]`: an ABSENT array must stay distinguishable
    // from a present-but-empty one. Absent = the server never told us (→ `Unknown`,
    // fail open); present-empty = it told us and listed nothing (→ `Unsupported`).
    supported_parameters: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct RawOllamaShow {
    // See `RawOpenRouterModel::supported_parameters`: absent vs present-empty differ.
    capabilities: Option<Vec<String>>,
}

pub fn parse_openrouter_models(json: &str) -> CoreResult<Vec<ModelCapabilities>> {
    let raw: RawOpenRouterModels = serde_json::from_str(json)
        .map_err(|e| CoreError::Llm(format!("could not parse OpenRouter models: {e}")))?;

    Ok(raw
        .data
        .into_iter()
        .map(|model| ModelCapabilities {
            id: model.id,
            // The catalogue view flattens absent → empty; the absent-vs-present
            // distinction that drives the fail-open verdict is read from the raw
            // struct in `openrouter_reasoning_support`, not here.
            supported_parameters: model.supported_parameters.unwrap_or_default(),
        })
        .collect())
}

pub fn supports_reasoning(supported_parameters: &[String]) -> bool {
    supported_parameters.iter().any(|p| p == "reasoning")
}

/// Map an optional capability array to a verdict. An ABSENT array (`None`) fails
/// OPEN to `Unknown` — the server never told us (spec §2). A PRESENT array is
/// authoritative: `has_capability` decides `Supported` vs `Unsupported`.
fn capability_verdict(
    capabilities: Option<&[String]>,
    has_capability: fn(&[String]) -> bool,
) -> ReasoningSupport {
    match capabilities {
        None => ReasoningSupport::Unknown,
        Some(caps) if has_capability(caps) => ReasoningSupport::Supported,
        Some(_) => ReasoningSupport::Unsupported,
    }
}

/// Verdict for a hosted model, from the raw OpenRouter `/models` body and the
/// selected id. A model whose `supported_parameters` is absent → `Unknown` (fail
/// open, spec §2); an unparseable body or an unlisted id is likewise `Unknown`.
pub fn openrouter_reasoning_support(models_json: &str, model_id: &str) -> ReasoningSupport {
    let Ok(raw) = serde_json::from_str::<RawOpenRouterModels>(models_json) else {
        return ReasoningSupport::Unknown;
    };
    let Some(model) = raw.data.into_iter().find(|model| model.id == model_id) else {
        return ReasoningSupport::Unknown;
    };

    capability_verdict(model.supported_parameters.as_deref(), supports_reasoning)
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

/// The call-site rule: only send a reasoning request when the user opted in and
/// the model is not known to lack the capability.
///
/// if a user enables reasoning then switches to a non-reasoning model,
/// `config.reasoning` stays `true`; sending the reasoning request anyway would
/// make Phase A's empty-answer / zero-`Thinking` backstop fire on a perfectly
/// normal turn. `Unknown` still sends (fail open).
pub fn effective_reasoning(opt_in: bool, support: ReasoningSupport) -> bool {
    opt_in && support != ReasoningSupport::Unsupported
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;

    const OPENROUTER_MODELS: &str = r#"{
        "data": [
            {
                "id": "anthropic/claude-sonnet-5",
                "supported_parameters": ["include_reasoning","max_completion_tokens","max_tokens","reasoning","reasoning_effort","response_format","stop","structured_outputs","tool_choice","tools","verbosity"]
            },
            {
                "id": "openai/gpt-chat-latest",
                "supported_parameters": ["frequency_penalty","logit_bias","logprobs","max_tokens","presence_penalty","response_format","seed","stop","structured_outputs","tool_choice","tools","top_logprobs"]
            }
        ]
    }"#;

    #[test]
    fn openrouter_models_report_real_reasoning_support() {
        let models = parse_openrouter_models(OPENROUTER_MODELS).unwrap();
        let claude = models
            .iter()
            .find(|model| model.id == "anthropic/claude-sonnet-5")
            .unwrap();
        let gpt = models
            .iter()
            .find(|model| model.id == "openai/gpt-chat-latest")
            .unwrap();

        assert!(supports_reasoning(&claude.supported_parameters));
        assert!(!supports_reasoning(&gpt.supported_parameters));
    }

    #[test]
    fn absent_openrouter_model_lookup_returns_none() {
        let models = parse_openrouter_models(OPENROUTER_MODELS).unwrap();

        assert!(models
            .iter()
            .find(|model| model.id == "missing/model")
            .is_none());
    }

    #[test]
    fn openrouter_reasoning_verdict_is_supported_for_reasoning_model() {
        assert_eq!(
            openrouter_reasoning_support(OPENROUTER_MODELS, "anthropic/claude-sonnet-5"),
            ReasoningSupport::Supported
        );
    }

    #[test]
    fn openrouter_reasoning_verdict_is_unsupported_for_non_reasoning_model() {
        assert_eq!(
            openrouter_reasoning_support(OPENROUTER_MODELS, "openai/gpt-chat-latest"),
            ReasoningSupport::Unsupported
        );
    }

    #[test]
    fn openrouter_reasoning_verdict_is_unknown_for_absent_model() {
        assert_eq!(
            openrouter_reasoning_support(OPENROUTER_MODELS, "missing/model"),
            ReasoningSupport::Unknown
        );
    }

    #[test]
    fn openrouter_reasoning_verdict_is_unknown_when_model_lists_no_parameters() {
        // The model is present but its `supported_parameters` field is absent — the
        // server never told us what it supports → fail OPEN (spec §2), never the
        // positively-verified `Unsupported` that would disable a billed control.
        assert_eq!(
            openrouter_reasoning_support(r#"{"data":[{"id":"custom/model"}]}"#, "custom/model"),
            ReasoningSupport::Unknown
        );
    }

    #[test]
    fn openrouter_reasoning_verdict_is_unsupported_for_present_empty_parameters() {
        // A present-but-empty array IS the server telling us: it listed nothing.
        assert_eq!(
            openrouter_reasoning_support(
                r#"{"data":[{"id":"custom/model","supported_parameters":[]}]}"#,
                "custom/model"
            ),
            ReasoningSupport::Unsupported
        );
    }

    #[test]
    fn openrouter_reasoning_verdict_is_unknown_for_malformed_json() {
        assert_eq!(
            openrouter_reasoning_support(r#"{"data":"#, "anthropic/claude-sonnet-5"),
            ReasoningSupport::Unknown
        );
    }

    #[test]
    fn openrouter_reasoning_verdict_is_unknown_when_data_is_absent() {
        assert_eq!(
            openrouter_reasoning_support("{}", "anthropic/claude-sonnet-5"),
            ReasoningSupport::Unknown
        );
    }

    #[test]
    fn missing_supported_parameters_is_empty_and_unsupported() {
        let models = parse_openrouter_models(r#"{"data":[{"id":"custom/model"}]}"#).unwrap();

        assert_eq!(models[0].supported_parameters, Vec::<String>::new());
        assert!(!supports_reasoning(&models[0].supported_parameters));
    }

    #[test]
    fn missing_openrouter_data_field_is_empty() {
        assert!(parse_openrouter_models("{}").unwrap().is_empty());
    }

    #[test]
    fn malformed_openrouter_json_is_an_llm_error() {
        assert!(matches!(
            parse_openrouter_models(r#"{"data":"#),
            Err(CoreError::Llm(_))
        ));
    }

    #[test]
    fn reasoning_support_serde_round_trips_camel_case() {
        for (support, expected) in [
            (ReasoningSupport::Supported, r#""supported""#),
            (ReasoningSupport::Unsupported, r#""unsupported""#),
            (ReasoningSupport::Unknown, r#""unknown""#),
        ] {
            let json = serde_json::to_string(&support).unwrap();

            assert_eq!(json, expected);
            assert_eq!(
                serde_json::from_str::<ReasoningSupport>(&json).unwrap(),
                support
            );
        }
    }

    #[test]
    fn reasoning_support_requires_an_exact_parameter_match() {
        assert!(!supports_reasoning(&["reasoning_effort".to_string()]));
        assert!(supports_reasoning(&["reasoning".to_string()]));
    }

    #[test]
    fn ollama_fixture_reports_thinking_support() {
        let capabilities =
            parse_ollama_capabilities(r#"{"capabilities":["completion","tools","thinking"]}"#)
                .unwrap();

        assert!(supports_thinking(&capabilities));
    }

    #[test]
    fn ollama_fixture_without_thinking_is_unsupported() {
        let capabilities =
            parse_ollama_capabilities(r#"{"capabilities":["completion","tools"]}"#).unwrap();

        assert!(!supports_thinking(&capabilities));
    }

    #[test]
    fn ollama_reasoning_verdict_is_supported_when_thinking_is_present() {
        assert_eq!(
            ollama_reasoning_support(r#"{"capabilities":["completion","tools","thinking"]}"#),
            ReasoningSupport::Supported
        );
    }

    #[test]
    fn ollama_reasoning_verdict_is_unsupported_without_thinking() {
        assert_eq!(
            ollama_reasoning_support(r#"{"capabilities":["completion","tools"]}"#),
            ReasoningSupport::Unsupported
        );
    }

    #[test]
    fn ollama_reasoning_verdict_is_unknown_when_capabilities_are_absent() {
        // Absent field = the server never told us → fail OPEN (spec §2), never the
        // positively-verified `Unsupported`.
        assert_eq!(ollama_reasoning_support("{}"), ReasoningSupport::Unknown);
    }

    #[test]
    fn ollama_reasoning_verdict_is_unsupported_for_present_empty_capabilities() {
        // A present-but-empty array IS the server telling us: it listed nothing.
        assert_eq!(
            ollama_reasoning_support(r#"{"capabilities":[]}"#),
            ReasoningSupport::Unsupported
        );
    }

    #[test]
    fn ollama_reasoning_verdict_is_unknown_for_malformed_json() {
        assert_eq!(
            ollama_reasoning_support(r#"{"capabilities":"#),
            ReasoningSupport::Unknown
        );
    }

    #[test]
    fn ollama_missing_capabilities_is_empty_and_unsupported() {
        let capabilities = parse_ollama_capabilities("{}").unwrap();

        assert!(capabilities.is_empty());
        assert!(!supports_thinking(&capabilities));
    }

    #[test]
    fn malformed_ollama_json_is_a_local_ai_error() {
        assert!(matches!(
            parse_ollama_capabilities(r#"{"capabilities":"#),
            Err(CoreError::LocalAi(_))
        ));
    }

    #[test]
    fn thinking_support_requires_an_exact_capability_match() {
        assert!(!supports_thinking(&["thinking-preview".to_string()]));
    }

    #[test]
    fn effective_reasoning_sends_for_opted_in_supported_model() {
        assert!(effective_reasoning(true, ReasoningSupport::Supported));
    }

    #[test]
    fn effective_reasoning_fails_open_for_opted_in_unknown_model() {
        assert!(effective_reasoning(true, ReasoningSupport::Unknown));
    }

    #[test]
    fn effective_reasoning_suppresses_opted_in_unsupported_model() {
        assert!(!effective_reasoning(true, ReasoningSupport::Unsupported));
    }

    #[test]
    fn effective_reasoning_respects_opt_out_for_supported_model() {
        assert!(!effective_reasoning(false, ReasoningSupport::Supported));
    }

    #[test]
    fn effective_reasoning_respects_opt_out_for_unsupported_model() {
        assert!(!effective_reasoning(false, ReasoningSupport::Unsupported));
    }
}
