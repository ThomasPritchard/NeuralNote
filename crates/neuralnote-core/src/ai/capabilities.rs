//! Pure model-capability parsing shared by hosted and local AI providers.

use crate::capture::ModelPricing;
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

/// What the reasoning control should offer for the selected model.
///
/// A closed set, because the control is a rendering decision and every state the
/// probe can produce needs exactly one: an unanswered probe is not the same as a
/// model that cannot reason, and neither is a model whose reasoning is forced on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ReasoningControl {
    /// The model cannot reason. Show nothing.
    Hidden,
    /// The probe has not answered yet. Show the control disabled rather than
    /// guessing at a shape it may not have.
    Pending,
    /// Reasoning is on or off, with no effort menu behind it.
    Toggle { default_on: bool },
    /// The model always reasons. Show that it is on, and that it cannot be
    /// turned off.
    Locked,
    /// The model publishes an effort menu. `options` is that menu VERBATIM, in
    /// the model's own words and its own order.
    Efforts {
        options: Vec<String>,
        default_effort: Option<String>,
        can_disable: bool,
    },
}

/// The value a model uses inside its own effort menu to mean "do not reason".
/// It is a sentinel, not an effort, so it never reaches the user as a menu item.
const OFF_SENTINEL: &str = "none";

/// Decide which reasoning control a model's capability record calls for.
///
/// `None` means the model published no reasoning block. It is NOT "the probe has
/// not answered" — that is [`ReasoningControl::Pending`], which only the caller
/// can know and which this function therefore never returns.
///
/// The precedence, in order, and why (amendment D1):
///
/// 1. **A published menu wins.** `supported_efforts` is the only field that
///    offers the user a choice, so a record carrying one renders [`Efforts`]
///    even when it also carries `mandatory` or `supports_max_tokens`.
///    `mandatory: true` alongside a menu is not a contradiction — the user picks
///    how hard the model thinks without being able to stop it thinking — and a
///    `max_tokens` budget is a different knob that OpenRouter documents as
///    mutually exclusive with `effort`.
/// 2. **Off gets exactly one representation.** The catalogue spells "reasoning
///    can be turned off" two ways: `none` inside the menu, and `mandatory:
///    false` beside it. Both fold into `can_disable`, so two models that behave
///    identically render an identical control. Only `mandatory: true` takes the
///    off switch away.
/// 3. **No menu, `mandatory: true` → [`Locked`].** On is the only state.
/// 4. **No menu otherwise → [`Toggle`]**, following `default_enabled` where the
///    record publishes one and starting **off** where it does not. Absent means
///    the server never told us, reasoning tokens bill as output, and the
///    existing opt-in already starts false.
///
/// The effort VALUES are never touched: not lower-cased, not reordered, not
/// checked against a compiled-in list. The live catalogue carries 21 distinct
/// menus, so any list compiled in here would be wrong for some model and would
/// silently downgrade its reasoning. Stripping [`OFF_SENTINEL`] is the single
/// permitted normalisation, and it removes a state — not a value.
///
/// See the captured fixture at
/// `crates/neuralnote-core/src/ai/fixtures/openrouter_models_reasoning.json`.
pub fn reasoning_control(capability: Option<&RawReasoningCapability>) -> ReasoningControl {
    let Some(capability) = capability else {
        return ReasoningControl::Hidden;
    };
    let mandatory = capability.mandatory == Some(true);
    let options = offerable_efforts(capability);

    if options.is_empty() {
        return menuless_control(capability, mandatory);
    }
    ReasoningControl::Efforts {
        options,
        default_effort: capability.default_effort.clone(),
        can_disable: !mandatory,
    }
}

/// The efforts a user may actually pick, with the off sentinel removed.
///
/// Empty for a record that published no menu, and equally empty for one whose
/// menu held nothing but the sentinel — neither leaves anything to choose
/// between, so both take the menu-less path.
fn offerable_efforts(capability: &RawReasoningCapability) -> Vec<String> {
    capability
        .supported_efforts
        .iter()
        .flatten()
        .filter(|effort| effort.as_str() != OFF_SENTINEL)
        .cloned()
        .collect()
}

/// The control for a record with no effort to offer: on-only when reasoning is
/// mandatory, otherwise an on/off switch starting where the record says (and off
/// where it says nothing).
fn menuless_control(capability: &RawReasoningCapability, mandatory: bool) -> ReasoningControl {
    if mandatory {
        ReasoningControl::Locked
    } else {
        ReasoningControl::Toggle {
            default_on: capability.default_enabled.unwrap_or(false),
        }
    }
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
    // but empty one.
    reasoning: Option<RawReasoningCapability>,
}

#[derive(Deserialize)]
struct RawOpenRouterPricing {
    prompt: Option<String>,
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

    /// Six whole records captured verbatim from OpenRouter's public `/models`
    /// endpoint on 2026-08-18. Captured rather than hand-written on purpose: a
    /// hand-written literal tests our model of the payload, not the payload, and
    /// the failure this fixture exists to catch is precisely a mismatch between
    /// the two.
    const CAPTURED_MODELS: &str = include_str!("fixtures/openrouter_models_reasoning.json");

    #[test]
    fn reasoning_capability_parses_a_captured_full_effort_menu() {
        // The wire is snake_case. Every field on `RawReasoningCapability` is
        // `Option`, so a `rename_all = "camelCase"` would not error — it would
        // quietly yield all-`None`, indistinguishable from a model that published
        // nothing. This test is what makes that failure loud.
        let capability =
            openrouter_reasoning_capability(CAPTURED_MODELS, "openai/gpt-5.6-luna-pro")
                .expect("the captured record publishes a reasoning block");

        assert_eq!(
            capability.supported_efforts.as_deref(),
            Some(
                [
                    "max".to_string(),
                    "xhigh".to_string(),
                    "high".to_string(),
                    "medium".to_string(),
                    "low".to_string(),
                    "none".to_string(),
                ]
                .as_slice()
            ),
            "the menu round-trips verbatim, in the model's own order"
        );
        assert_eq!(capability.default_effort.as_deref(), Some("medium"));
        assert_eq!(capability.default_enabled, Some(true));
        assert_eq!(capability.mandatory, Some(false));
        // Absent on this record, and absent must stay absent rather than become
        // `Some(false)` — "not offered" and "offered and off" are different facts.
        assert_eq!(capability.supports_max_tokens, None);
    }

    #[test]
    fn every_reasoning_field_survives_the_wire_on_some_captured_record() {
        // One record per field is not enough: a rename that broke only
        // `supports_max_tokens` would slip past a test that reads one model. Each
        // field is asserted where the catalogue actually publishes it.
        let capability = |id| {
            openrouter_reasoning_capability(CAPTURED_MODELS, id)
                .unwrap_or_else(|| panic!("{id} publishes a reasoning block"))
        };

        assert_eq!(capability("x-ai/grok-4.6").mandatory, Some(true));
        assert_eq!(
            capability("nvidia/nemotron-3-ultra-550b-a55b").supports_max_tokens,
            Some(true)
        );
        assert_eq!(
            capability("inclusionai/ling-3.0-flash").default_enabled,
            Some(true)
        );
        // A block carrying only `mandatory` is a real, common shape — and the one
        // that survives a wrong `rename_all` by luck, because the word has no case
        // boundary in it. It must not be the only evidence the parse works.
        assert_eq!(
            capability("dots-studio/dots-3-note-preview:free"),
            RawReasoningCapability {
                mandatory: Some(false),
                ..RawReasoningCapability::default()
            }
        );
    }

    /// The capability record `id` publishes, from the captured catalogue.
    fn captured(id: &str) -> RawReasoningCapability {
        openrouter_reasoning_capability(CAPTURED_MODELS, id)
            .unwrap_or_else(|| panic!("{id} publishes a reasoning block"))
    }

    #[test]
    fn a_published_menu_becomes_efforts_verbatim_with_the_off_sentinel_stripped() {
        // The captured record lists `none` INSIDE its menu. `none` is not an
        // effort the user picks — it is how this model spells "off" — so it
        // leaves the menu and becomes `can_disable`. Every other value survives
        // in the model's own words and its own order.
        assert_eq!(
            reasoning_control(Some(&captured("openai/gpt-5.6-luna-pro"))),
            ReasoningControl::Efforts {
                options: vec![
                    "max".into(),
                    "xhigh".into(),
                    "high".into(),
                    "medium".into(),
                    "low".into(),
                ],
                default_effort: Some("medium".into()),
                can_disable: true,
            }
        );
    }

    #[test]
    fn a_mandatory_model_with_a_menu_offers_the_menu_but_no_way_off() {
        // `x-ai/grok-4.6` carries `mandatory: true` AND a full menu. Both facts
        // are real and they do not conflict: the user picks how hard it thinks,
        // but cannot stop it thinking.
        assert_eq!(
            reasoning_control(Some(&captured("x-ai/grok-4.6"))),
            ReasoningControl::Efforts {
                options: vec!["xhigh".into(), "high".into(), "medium".into(), "low".into()],
                default_effort: Some("high".into()),
                can_disable: false,
            }
        );
    }

    #[test]
    fn a_menu_without_the_off_sentinel_can_still_be_disabled_when_it_is_not_mandatory() {
        // `nvidia/nemotron-3-ultra-550b-a55b` spells off the OTHER way the
        // catalogue spells it — `mandatory: false`, no `none` in the array. It
        // must render the same control as a model that lists `none`, or two
        // models that behave identically look different (amendment D1).
        assert_eq!(
            reasoning_control(Some(&captured("nvidia/nemotron-3-ultra-550b-a55b"))),
            ReasoningControl::Efforts {
                options: vec!["high".into(), "medium".into()],
                default_effort: Some("high".into()),
                can_disable: true,
            }
        );
        // `supports_max_tokens: true` on this record must not divert it: a token
        // budget is a different knob, and OpenRouter documents effort and
        // max_tokens as mutually exclusive. The published menu wins.
        assert_eq!(
            captured("nvidia/nemotron-3-ultra-550b-a55b").supports_max_tokens,
            Some(true)
        );
    }

    #[test]
    fn no_menu_falls_back_to_a_toggle_that_follows_the_published_default() {
        assert_eq!(
            reasoning_control(Some(&captured("inclusionai/ling-3.0-flash"))),
            ReasoningControl::Toggle { default_on: true }
        );
    }

    #[test]
    fn no_menu_and_no_published_default_starts_the_toggle_off() {
        // The commonest shape in the catalogue is a bare `{"mandatory": false}`.
        // Absent `default_enabled` means the server never told us, and the safe
        // reading of that is OFF: reasoning tokens bill as output, and today's
        // opt-in already starts false.
        assert_eq!(
            reasoning_control(Some(&captured("dots-studio/dots-3-note-preview:free"))),
            ReasoningControl::Toggle { default_on: false }
        );
    }

    #[test]
    fn mandatory_without_a_menu_is_locked_on() {
        // Constructed rather than captured: none of the six captured records is a
        // menu-less mandatory model, and hand-writing one in JSON would test our
        // spelling of the wire rather than the precedence. The wire spelling is
        // already pinned by the two parse tests above.
        assert_eq!(
            reasoning_control(Some(&RawReasoningCapability {
                mandatory: Some(true),
                ..RawReasoningCapability::default()
            })),
            ReasoningControl::Locked
        );
        // `default_enabled` is not a second opinion on a locked model — it
        // cannot be turned off either way.
        assert_eq!(
            reasoning_control(Some(&RawReasoningCapability {
                mandatory: Some(true),
                default_enabled: Some(false),
                ..RawReasoningCapability::default()
            })),
            ReasoningControl::Locked
        );
    }

    #[test]
    fn a_published_but_empty_block_is_a_toggle_that_starts_off() {
        // `{}` IS an answer: the model published a reasoning block and named
        // nothing in it. Not `Hidden` — that is reserved for no block at all.
        assert_eq!(
            reasoning_control(Some(&RawReasoningCapability::default())),
            ReasoningControl::Toggle { default_on: false }
        );
    }

    #[test]
    fn a_model_publishing_no_block_at_all_shows_no_control() {
        // `openrouter/auto-beta` is in the captured catalogue with `reasoning:
        // null`, which `openrouter_reasoning_capability` reports as `None`.
        // Whether an UNPROBED model shows `Pending` is the caller's decision,
        // not this function's — it is handed only what was published.
        assert_eq!(
            openrouter_reasoning_capability(CAPTURED_MODELS, "openrouter/auto-beta"),
            None
        );
        assert_eq!(reasoning_control(None), ReasoningControl::Hidden);
    }

    #[test]
    fn an_effort_menu_is_never_reordered_lowercased_or_filtered_beyond_the_sentinel() {
        // 21 distinct menus exist in the live catalogue, so any compiled-in list
        // would be wrong for some model and would silently downgrade it. The
        // ONLY value this function may remove is the off sentinel.
        let control = reasoning_control(Some(&RawReasoningCapability {
            supported_efforts: Some(vec![
                "Ultra".into(),
                "none".into(),
                "ludicrous-speed".into(),
                "MINIMAL".into(),
            ]),
            ..RawReasoningCapability::default()
        }));

        assert_eq!(
            control,
            ReasoningControl::Efforts {
                options: vec!["Ultra".into(), "ludicrous-speed".into(), "MINIMAL".into()],
                default_effort: None,
                can_disable: true,
            }
        );
    }

    #[test]
    fn a_menu_of_nothing_but_the_off_sentinel_leaves_a_toggle_not_an_empty_menu() {
        // Stripping the sentinel can empty the list, and a menu with no options
        // is a control with nothing to pick. What the record actually says is
        // "reasoning can be on or off", which is a toggle.
        assert_eq!(
            reasoning_control(Some(&RawReasoningCapability {
                supported_efforts: Some(vec!["none".into()]),
                default_enabled: Some(true),
                ..RawReasoningCapability::default()
            })),
            ReasoningControl::Toggle { default_on: true }
        );
    }

    #[test]
    fn reasoning_control_crosses_the_ipc_boundary_entirely_in_camel_case() {
        // The wire INTO this module is snake_case (OpenRouter); the wire OUT of it
        // is the repo's camelCase IPC contract. Both the tag values and the
        // struct-variant fields are renamed — `rename_all` alone leaves the fields
        // snake_case, which is the half-conversion this pins.
        assert_eq!(
            serde_json::to_value(ReasoningControl::Efforts {
                options: vec!["xhigh".into(), "low".into()],
                default_effort: Some("xhigh".into()),
                can_disable: true,
            })
            .unwrap(),
            serde_json::json!({
                "kind": "efforts",
                "options": ["xhigh", "low"],
                "defaultEffort": "xhigh",
                "canDisable": true,
            })
        );
        assert_eq!(
            serde_json::to_value(ReasoningControl::Toggle { default_on: false }).unwrap(),
            serde_json::json!({ "kind": "toggle", "defaultOn": false })
        );
        for (control, kind) in [
            (ReasoningControl::Hidden, "hidden"),
            (ReasoningControl::Pending, "pending"),
            (ReasoningControl::Locked, "locked"),
        ] {
            assert_eq!(
                serde_json::to_value(&control).unwrap(),
                serde_json::json!({ "kind": kind })
            );
            assert_eq!(
                serde_json::from_value::<ReasoningControl>(serde_json::json!({ "kind": kind }))
                    .unwrap(),
                control
            );
        }
    }

    #[test]
    fn a_model_publishing_no_reasoning_block_is_absent_not_empty() {
        // "The server told us nothing about reasoning" must stay distinguishable
        // from "the server told us reasoning exists and said nothing else" — the
        // first is what `reasoning_control` reads as an unanswered probe.
        assert_eq!(
            openrouter_reasoning_capability(CAPTURED_MODELS, "openrouter/auto-beta"),
            None
        );
        assert_eq!(
            openrouter_reasoning_capability(CAPTURED_MODELS, "vendor/not-in-the-catalogue"),
            None
        );
        assert_eq!(openrouter_reasoning_capability(r#"{"data":"#, "any"), None);
    }

    #[test]
    fn openrouter_context_windows_parse_positive_lengths_for_every_listed_model() {
        let json = r#"{"data":[
            {"id":"vendor/small","context_length":32768},
            {"id":"vendor/big","context_length":1000000}
        ]}"#;

        let windows = parse_openrouter_context_windows(json).unwrap();

        assert_eq!(
            windows,
            vec![
                ("vendor/small".to_string(), 32_768),
                ("vendor/big".to_string(), 1_000_000),
            ]
        );
    }

    #[test]
    fn openrouter_context_windows_skip_absent_and_zero_lengths_fail_open() {
        // A missing field means the server never told us, and a zero window is not a
        // real model — both are skipped (budgeting stays inert) rather than guessed.
        let json = r#"{"data":[
            {"id":"vendor/unknown"},
            {"id":"vendor/zero","context_length":0},
            {"id":"vendor/known","context_length":65536}
        ]}"#;

        let windows = parse_openrouter_context_windows(json).unwrap();

        assert_eq!(windows, vec![("vendor/known".to_string(), 65_536)]);
    }

    #[test]
    fn openrouter_context_windows_are_none_on_malformed_json() {
        assert!(parse_openrouter_context_windows(r#"{"data":"#).is_none());
        // A wholly absent `data` array parses as an empty catalogue, not an error.
        assert_eq!(parse_openrouter_context_windows("{}"), Some(vec![]));
    }

    #[test]
    fn ollama_num_ctx_is_the_window_every_curated_local_model_supports() {
        // The single source of truth for the local window: the shell sends it as
        // `num_ctx` and the orchestrator budgets against it. Anchor the value so a
        // change here is a deliberate, reviewed decision.
        assert_eq!(crate::ai::local::OLLAMA_NUM_CTX, 32_768);
    }

    #[test]
    fn selected_openrouter_model_pricing_parses_prompt_usd_per_token() {
        let json = r#"{"data":[{"id":"other","pricing":{"prompt":"9"}},{"id":"openai/test","pricing":{"prompt":"0.000003"}}]}"#;

        let pricing = parse_openrouter_input_pricing(json, "openai/test").unwrap();

        assert_eq!(pricing.model, "openai/test");
        assert_eq!(pricing.input_usd_per_token, 0.000003);
    }

    #[test]
    fn selected_openrouter_model_pricing_fails_explicitly_when_missing_or_invalid() {
        for json in [
            r#"{"data":[]}"#,
            r#"{"data":[{"id":"openai/test"}]}"#,
            r#"{"data":[{"id":"openai/test","pricing":{"prompt":"nope"}}]}"#,
            r#"{"data":[{"id":"openai/test","pricing":{"prompt":"-1"}}]}"#,
        ] {
            assert!(parse_openrouter_input_pricing(json, "openai/test").is_err());
        }
    }
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
