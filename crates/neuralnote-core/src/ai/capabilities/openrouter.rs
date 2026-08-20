//! Reading OpenRouter's `/models` payload.
//!
//! Everything in here knows the wire format; nothing in here decides anything.
//! The catalogue body answers several unrelated questions at once — which models
//! exist, what each costs, how big its context window is, and what reasoning it
//! publishes — so one fetch warms every cache, and the record shape those
//! answers are cut from is shared rather than parsed four times.
//!
//! Its `reasoning` block leaves here as [`RawReasoningCapability`], verbatim.
//! Turning that into a control the user can see is
//! [`super::reasoning_control`]'s job, one level up.

use super::{capability_verdict, reasoning_control, ReasoningControl, ReasoningSupport};
use crate::capture::ModelPricing;
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCapabilities {
    pub id: String,
    pub supported_parameters: Vec<String>,
}

/// One model's `reasoning` block from the OpenRouter `/models` payload, verbatim.
///
/// **The wire is snake_case and this struct must stay snake_case.** Do NOT add
/// `#[serde(rename_all = "camelCase")]` — the sibling [`RawOpenRouterModel`] has
/// none for the same reason, and `openai.rs` states the rule outright. Every
/// field here is `Option`, so a rename would not error: a record carrying a full
/// effort menu would deserialize to all-`None`, indistinguishable from a genuine
/// `{}`. That is a silent failure, which this project forbids, and
/// `reasoning_capability_parses_a_captured_full_effort_menu` is the check that
/// catches it.
///
/// Absent fields stay absent for the same reason the sibling's do: "the server
/// never told us" and "the server told us nothing is available" are different
/// facts, and only the caller may decide what to do about the first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct RawReasoningCapability {
    /// The model always reasons; reasoning cannot be turned off.
    pub mandatory: Option<bool>,
    /// Reasoning is on unless the caller says otherwise.
    pub default_enabled: Option<bool>,
    /// The model's own effort menu, in its own words. Never normalised — the
    /// catalogue carries 21 distinct menus.
    pub supported_efforts: Option<Vec<String>>,
    /// The effort the model uses when the caller names none.
    pub default_effort: Option<String>,
    /// The model accepts a `reasoning.max_tokens` budget instead of an effort.
    pub supports_max_tokens: Option<bool>,
}

/// The selected model's `reasoning` block from the raw OpenRouter `/models` body.
///
/// `None` covers all three ways the answer can be absent — an unparseable body,
/// an unlisted id, or a listed model that publishes no reasoning block — and it
/// is the `None` [`reasoning_control`] is specified to read as "the probe has not
/// answered" once its body is written. Fail-open, like the sibling probes here.
pub fn openrouter_reasoning_capability(
    models_json: &str,
    model_id: &str,
) -> Option<RawReasoningCapability> {
    serde_json::from_str::<RawOpenRouterModels>(models_json)
        .ok()?
        .data
        .into_iter()
        .find(|model| model.id == model_id)?
        .reasoning
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
    pricing: Option<RawOpenRouterPricing>,
    // Absent (or zero) means the server never told us the window — skipped by
    // `parse_openrouter_context_windows`, so budgeting stays inert rather than guessed.
    context_length: Option<u64>,
    // Absent for a model that publishes no reasoning block at all — see
    // `openrouter_reasoning_capability`, which keeps that apart from a published
    // but empty one. Read leniently, because this field shares its record with
    // the rest of the catalogue — see `lenient_reasoning`.
    #[serde(default, deserialize_with = "lenient_reasoning")]
    reasoning: Option<RawReasoningCapability>,
}

/// Read a model's `reasoning` block without letting an unreadable one take the
/// rest of the catalogue down with it.
///
/// This field shares [`RawOpenRouterModel`] with `pricing`, `context_length` and
/// the id list, and serde fails a whole body on one bad field. So a single
/// record whose reasoning block arrives in a shape this build cannot read would
/// otherwise break prompt budgeting (issue #22), model listing and pricing at
/// the same time — for a field none of them use.
///
/// An unreadable block is reported as absent, which is the same fail-open answer
/// this module already gives for an unparseable body: the control shows nothing
/// rather than a guess. (`pricing` still carries the un-narrowed version of this
/// exposure; narrowing it is a separate change, since its own parser is
/// deliberately fallible.)
///
/// **Tolerated, not silent.** Absent and unreadable produce the same control, so
/// without a line here a model whose menu changed shape would render as an
/// ordinary no-menu model while a previously-stored effort kept going out on
/// every turn — a billed setting degrading with nothing anywhere saying why.
/// Same shape as the other tolerated faults in this crate (`search.rs`,
/// `backlinks.rs`), which is what `log` is a dependency for.
fn lenient_reasoning<'de, D>(deserializer: D) -> Result<Option<RawReasoningCapability>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match serde_json::from_value(value) {
        Ok(capability) => Ok(capability),
        Err(error) => {
            log::warn!("capabilities: ignoring an unreadable model reasoning block: {error}");
            Ok(None)
        }
    }
}

#[derive(Deserialize)]
struct RawOpenRouterPricing {
    prompt: Option<String>,
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

pub fn parse_openrouter_input_pricing(
    models_json: &str,
    model_id: &str,
) -> CoreResult<ModelPricing> {
    let model_id = model_id.trim();
    if model_id.is_empty() || model_id.len() > 256 || model_id.chars().any(char::is_control) {
        return Err(CoreError::Llm(
            "selected OpenRouter model id is invalid".into(),
        ));
    }
    let raw: RawOpenRouterModels = serde_json::from_str(models_json)
        .map_err(|error| CoreError::Llm(format!("could not parse OpenRouter pricing: {error}")))?;
    let model = raw
        .data
        .into_iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| {
            CoreError::Llm(format!(
                "OpenRouter pricing did not include model '{model_id}'"
            ))
        })?;
    let prompt = model
        .pricing
        .and_then(|pricing| pricing.prompt)
        .ok_or_else(|| {
            CoreError::Llm(format!("OpenRouter model '{model_id}' has no prompt price"))
        })?;
    let input_usd_per_token = prompt.parse::<f64>().map_err(|_| {
        CoreError::Llm(format!(
            "OpenRouter model '{model_id}' has an invalid prompt price"
        ))
    })?;
    if !input_usd_per_token.is_finite() || input_usd_per_token < 0.0 {
        return Err(CoreError::Llm(format!(
            "OpenRouter model '{model_id}' has an invalid prompt price"
        )));
    }
    Ok(ModelPricing {
        model: model_id.to_string(),
        input_usd_per_token,
    })
}

/// The reasoning control every model in the raw OpenRouter `/models` body calls
/// for, as `(id, control)` pairs.
///
/// One body answers for the whole catalogue, so a caller warms one cache from
/// one fetch rather than asking per model. A listed model that publishes no
/// reasoning block is present here as [`ReasoningControl::Hidden`] — "listed and
/// silent" is an answer, and it is not the same as "not in this body", which is
/// the absence a caller reads as an unanswered probe.
///
/// Fail-open like its sibling probes: a malformed body yields `None` and the
/// caller's cache simply stays unwarmed.
pub fn parse_openrouter_reasoning_controls(
    models_json: &str,
) -> Option<Vec<(String, ReasoningControl)>> {
    let raw: RawOpenRouterModels = serde_json::from_str(models_json).ok()?;
    Some(
        raw.data
            .into_iter()
            .map(|model| (model.id, reasoning_control(model.reasoning.as_ref())))
            .collect(),
    )
}

/// The context window (`context_length`) of every model in the raw OpenRouter
/// `/models` body, as `(id, tokens)` pairs. Fail-open like the reasoning probe: a
/// malformed body yields `None` (the caller's cache just stays unwarmed), and a
/// record with an absent or zero length is skipped — an unknown window must leave
/// prompt budgeting inert, never guessed (issue #22).
pub fn parse_openrouter_context_windows(models_json: &str) -> Option<Vec<(String, u64)>> {
    let raw: RawOpenRouterModels = serde_json::from_str(models_json).ok()?;
    Some(
        raw.data
            .into_iter()
            .filter_map(|model| {
                let context_length = model.context_length.filter(|length| *length > 0)?;
                Some((model.id, context_length))
            })
            .collect(),
    )
}
