//! The whole capability suite, in one module beside the code it exercises.
//!
//! One file rather than one per provider module, because the split above is by
//! *payload* while these tests are mostly about the decision the payloads feed —
//! `reasoning_control` is exercised through six captured OpenRouter records, so
//! cutting the suite along the production seam would separate most of these
//! assertions from the fixture that makes them real. `orchestrator/` does the
//! same: production in modules, tests in one file beside them.
//!
//! Being a child of `capabilities` is what lets these reach `super`'s private
//! items — `resolve_effort`, `offerable_efforts`, `menu_lists` — which a sibling
//! module could not.

use super::*;
use crate::warning_capture;

/// Six whole records captured verbatim from OpenRouter's public `/models`
/// endpoint on 2026-08-18. Captured rather than hand-written on purpose: a
/// hand-written literal tests our model of the payload, not the payload, and
/// the failure this fixture exists to catch is precisely a mismatch between
/// the two.
const CAPTURED_MODELS: &str = include_str!("../fixtures/openrouter_models_reasoning.json");

#[test]
fn reasoning_capability_parses_a_captured_full_effort_menu() {
    // The wire is snake_case. Every field on `RawReasoningCapability` is
    // `Option`, so a `rename_all = "camelCase"` would not error — it would
    // quietly yield all-`None`, indistinguishable from a model that published
    // nothing. This test is what makes that failure loud.
    let capability = openrouter_reasoning_capability(CAPTURED_MODELS, "openai/gpt-5.6-luna-pro")
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
        parse_ollama_capabilities(r#"{"capabilities":["completion","tools","thinking"]}"#).unwrap();

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

#[test]
fn an_opted_in_turn_with_no_chosen_effort_asks_for_the_models_own_default() {
    assert_eq!(
        effective_reasoning_ask(true, None, ReasoningSupport::Supported),
        Some(ReasoningAsk::Enabled)
    );
}

#[test]
fn a_chosen_effort_goes_out_verbatim() {
    assert_eq!(
        effective_reasoning_ask(true, Some("xHigh"), ReasoningSupport::Supported),
        Some(ReasoningAsk::Effort("xHigh".into()))
    );
}

#[test]
fn an_unprobed_model_sends_the_opt_in_but_never_an_effort() {
    // §4.2's asymmetry: the SEND path stays fail open (an `Unknown` verdict
    // still reasons), while an effort is only ever sent when it was read off
    // a probed menu. Guessing a menu invents user-facing options that may not
    // exist; omitting an effort just takes the provider's own default.
    assert_eq!(
        effective_reasoning_ask(true, None, ReasoningSupport::Unknown),
        Some(ReasoningAsk::Enabled)
    );
    assert_eq!(
        effective_reasoning_ask(true, Some("xhigh"), ReasoningSupport::Unknown),
        Some(ReasoningAsk::Enabled)
    );
}

#[test]
fn a_model_known_not_to_reason_is_asked_for_nothing_however_it_was_configured() {
    assert_eq!(
        effective_reasoning_ask(true, Some("xhigh"), ReasoningSupport::Unsupported),
        None
    );
}

#[test]
fn opting_out_sends_no_reasoning_object_even_with_an_effort_stored() {
    for support in [
        ReasoningSupport::Supported,
        ReasoningSupport::Unknown,
        ReasoningSupport::Unsupported,
    ] {
        assert_eq!(effective_reasoning_ask(false, Some("xhigh"), support), None);
    }
}

/* ───────  A menu that shrank under a stable model (amendment E3)  ─────── */

fn menu(options: &[&str], default_effort: Option<&str>) -> ReasoningControl {
    ReasoningControl::Efforts {
        options: options.iter().map(|o| (*o).to_string()).collect(),
        default_effort: default_effort.map(str::to_string),
        can_disable: true,
    }
}

#[test]
fn offers_answers_membership_of_the_menu_this_control_is_showing() {
    // The one rule, asked directly. Both the send path and the write path
    // ask it of the same value, so a model whose menu moved cannot be
    // refused by one and accepted by the other.
    let control = menu(&["high", "low"], Some("high"));

    assert!(control.offers("high"), "a listed effort is offered");
    assert!(control.offers("low"), "and so is the rest of the list");
    assert!(!control.offers("xhigh"), "an unlisted effort is not");
    assert!(
        !control.offers("HIGH"),
        "the values are the model's own words, never case-folded"
    );
}

#[test]
fn a_control_with_no_menu_offers_no_effort_at_all() {
    // Including `Pending`: "the catalogue has not answered" is not a menu,
    // and the question here is only ever what THIS control lists. What to do
    // about an unanswered probe is a separate rule, and it lives with the
    // caller that has to make that call (amendment E2).
    for control in [
        ReasoningControl::Pending,
        ReasoningControl::Hidden,
        ReasoningControl::Locked,
        ReasoningControl::Toggle { default_on: true },
        ReasoningControl::Efforts {
            options: Vec::new(),
            default_effort: None,
            can_disable: true,
        },
    ] {
        assert!(
            !control.offers("high"),
            "{control:?} publishes no effort to pick"
        );
    }
}

#[test]
fn an_effort_the_current_menu_still_offers_survives_untouched() {
    assert_eq!(
        resolve_effort(&menu(&["high", "low"], Some("high")), Some("low")).sending(),
        Some("low")
    );
}

#[test]
fn a_stored_effort_the_menu_dropped_falls_back_to_the_models_own_default() {
    // Amendment E3. The model kept its id and shrank its menu, so the stored
    // effort would now be rejected by the provider — failing a whole run over
    // a preference. Fall back to the default the menu itself publishes.
    let control = menu(&["high", "low"], Some("high"));

    assert_eq!(
        resolve_effort(&control, Some("xhigh")).sending(),
        Some("high")
    );
    assert_eq!(
        effective_reasoning_ask(
            true,
            resolve_effort(&control, Some("xhigh")).sending(),
            ReasoningSupport::Supported
        ),
        Some(ReasoningAsk::Effort("high".into()))
    );
}

#[test]
fn a_stored_effort_the_menu_dropped_falls_back_to_plain_enabled_with_no_default() {
    // The same case for a model that publishes no `default_effort`: name no
    // effort at all and take the provider's own, rather than guessing one.
    let control = menu(&["high", "low"], None);

    assert_eq!(resolve_effort(&control, Some("xhigh")).sending(), None);
    assert_eq!(
        effective_reasoning_ask(
            true,
            resolve_effort(&control, Some("xhigh")).sending(),
            ReasoningSupport::Supported
        ),
        Some(ReasoningAsk::Enabled)
    );
}

#[test]
fn a_user_who_chose_no_effort_is_not_handed_the_menus_default() {
    // The fallback exists for a choice the menu dropped, not for a choice
    // never made. "Take the model's own default" is what storing no effort
    // already means, and preselecting one here would start naming a value on
    // the wire that the user never picked.
    assert_eq!(
        resolve_effort(&menu(&["high", "low"], Some("high")), None).sending(),
        None
    );
}

#[test]
fn a_model_that_publishes_no_menu_at_all_sends_no_effort() {
    // Nothing here lists an effort, so no effort may go out — the same rule,
    // reached from the menu-less controls rather than from a shrunken menu.
    for control in [
        ReasoningControl::Toggle { default_on: true },
        ReasoningControl::Locked,
        ReasoningControl::Hidden,
    ] {
        assert_eq!(
            resolve_effort(&control, Some("xhigh")).sending(),
            None,
            "{control:?} offers no effort menu"
        );
    }
}

/// The stored preference a user who opted in and picked `effort` would have.
fn preference(effort: Option<&str>) -> ReasoningPreference {
    ReasoningPreference {
        enabled: true,
        effort: effort.map(str::to_string),
    }
}

#[test]
fn the_whole_ask_reconciles_the_stored_effort_against_the_current_menu() {
    assert_eq!(
        reasoning_ask(
            &preference(Some("xhigh")),
            ReasoningSupport::Supported,
            &menu(&["high", "low"], Some("high")),
        ),
        Some(ReasoningAsk::Effort("high".into()))
    );
}

#[test]
fn a_dropped_effort_is_reported_where_someone_can_read_it() {
    // The other half of the E3 ruling. Without this the warning could be
    // deleted and the suite would stay green, leaving a billed preference
    // overridden with nothing anywhere saying why.
    //
    // Asked of `reasoning_ask` rather than of the resolution beneath it,
    // because the send path is where the line has to appear: the sibling
    // status read shares that resolution and must stay silent, so a check
    // aimed at the shared helper would no longer be able to tell them apart.
    let mark = warning_capture::capture();
    let control = menu(&["high", "low"], Some("high"));

    assert_eq!(
        reasoning_ask(
            &preference(Some("e3-dropped-effort")),
            ReasoningSupport::Supported,
            &control,
        ),
        Some(ReasoningAsk::Effort("high".into()))
    );

    assert!(
        warning_capture::recorded(mark, "e3-dropped-effort"),
        "the override must name the effort it dropped: {:?}",
        warning_capture::since(mark)
    );
    assert!(
        warning_capture::recorded(mark, "no longer offers"),
        "and must say the menu dropped it: {:?}",
        warning_capture::since(mark)
    );
}

#[test]
fn a_turn_that_sends_no_reasoning_object_reports_no_override() {
    // A preference the user switched off is not being overridden by a menu,
    // and neither is one on a model the probe found cannot reason: both send
    // no `reasoning` object at all. Reconciling before that gate would report
    // an override on a turn that made no request, and a warning that cries
    // wolf is what makes the real one ignorable.
    //
    // Both states are reachable and neither clears the stored effort:
    // `set_reasoning(false)` flips only the bool, and `apply_reasoning_probe`
    // writes a fresh verdict for the same model without touching it.
    let mark = warning_capture::capture();

    assert_eq!(
        reasoning_ask(
            &ReasoningPreference {
                enabled: false,
                effort: Some("e3-opted-out".into()),
            },
            ReasoningSupport::Supported,
            &menu(&["high", "low"], Some("high")),
        ),
        None
    );
    assert_eq!(
        reasoning_ask(
            &preference(Some("e3-cannot-reason")),
            ReasoningSupport::Unsupported,
            &ReasoningControl::Hidden,
        ),
        None
    );

    assert!(
        !warning_capture::recorded(mark, "e3-opted-out")
            && !warning_capture::recorded(mark, "e3-cannot-reason"),
        "a turn that asked for no reasoning must not report an overridden effort: {:?}",
        warning_capture::since(mark)
    );
}

#[test]
fn an_unanswered_menu_leaves_the_stored_effort_alone() {
    // Amendment E2: `Pending` is "the catalogue has not answered", which is
    // not evidence the menu shrank. The stored value was read off this same
    // model's probed menu, so discarding it here would silently ignore the
    // user's setting for every turn of the cold-launch probe window.
    assert_eq!(
        resolve_effort(&ReasoningControl::Pending, Some("xhigh")).sending(),
        Some("xhigh")
    );
}

/* ───────  Reporting the override to whoever is paying for it  ─────── */

#[test]
fn a_dropped_effort_is_reported_as_both_halves_of_the_substitution() {
    // A log line is not a surface a desktop user opens. The pair — what they
    // chose, what is actually going out — is what makes the sentence the UI
    // renders an honest one, so both halves travel together rather than the
    // UI diffing two fields and inferring the rest.
    assert_eq!(
        reasoning_effort_override(
            &preference(Some("xhigh")),
            ReasoningSupport::Supported,
            &menu(&["high", "low"], Some("high")),
        ),
        Some(ReasoningEffortOverride {
            stored: "xhigh".into(),
            sending: Some("high".into()),
        })
    );
}

#[test]
fn an_override_with_no_published_default_reports_the_providers_own() {
    // `sending: None` reads exactly as the stored preference's own `None`
    // does: name no effort and take whatever the provider uses.
    assert_eq!(
        reasoning_effort_override(
            &preference(Some("xhigh")),
            ReasoningSupport::Supported,
            &menu(&["high", "low"], None),
        ),
        Some(ReasoningEffortOverride {
            stored: "xhigh".into(),
            sending: None,
        })
    );
    assert_eq!(
        reasoning_effort_override(
            &preference(Some("xhigh")),
            ReasoningSupport::Supported,
            &ReasoningControl::Toggle { default_on: true },
        ),
        Some(ReasoningEffortOverride {
            stored: "xhigh".into(),
            sending: None,
        }),
        "a model that dropped its menu entirely overrides the stored effort too"
    );
}

#[test]
fn nothing_is_reported_while_the_stored_effort_is_the_one_being_sent() {
    // Reporting an override on a turn that is honouring the preference would
    // make the surface cry wolf exactly as the log line would.
    for (label, preference, support, control) in [
        (
            "the menu still offers it",
            preference(Some("low")),
            ReasoningSupport::Supported,
            menu(&["high", "low"], Some("high")),
        ),
        (
            "no effort was ever chosen",
            preference(None),
            ReasoningSupport::Supported,
            menu(&["high", "low"], Some("high")),
        ),
        (
            "the catalogue has not answered (amendment E2)",
            preference(Some("xhigh")),
            ReasoningSupport::Supported,
            ReasoningControl::Pending,
        ),
        (
            "reasoning is switched off",
            ReasoningPreference {
                enabled: false,
                effort: Some("xhigh".into()),
            },
            ReasoningSupport::Supported,
            menu(&["high", "low"], Some("high")),
        ),
        (
            "the model cannot reason at all",
            preference(Some("xhigh")),
            ReasoningSupport::Unsupported,
            ReasoningControl::Hidden,
        ),
    ] {
        assert_eq!(
            reasoning_effort_override(&preference, support, &control),
            None,
            "{label}: nothing is being overridden"
        );
    }
}

#[test]
fn reporting_the_substitution_does_not_also_log_it() {
    // The status read is polled. If it warned on every poll it would bury the
    // one line the send path emits per run, which is the same cry-wolf
    // failure `a_turn_that_sends_no_reasoning_object_reports_no_override`
    // exists to prevent — reached from the other side.
    let mark = warning_capture::capture();

    assert!(reasoning_effort_override(
        &preference(Some("e3-polled-effort")),
        ReasoningSupport::Supported,
        &menu(&["high", "low"], Some("high")),
    )
    .is_some());

    assert!(
        !warning_capture::recorded(mark, "e3-polled-effort"),
        "a status read must not log: {:?}",
        warning_capture::since(mark)
    );
}

#[test]
fn an_unanswered_verdict_is_not_reported_as_the_menu_substituting_anything() {
    // With the verdict still `Unknown` the effort fails closed (§4.2), so the
    // turn sends plain `Enabled` and the stored `xhigh` is not on the wire —
    // and yet nothing has substituted for the user's choice. The probe has
    // not answered, the control renders `Pending`, the stored value is
    // untouched, and it goes out the moment the menu confirms it (amendment
    // E2). Reporting a substitution here would fire on every cold launch,
    // which is precisely how the real one becomes ignorable.
    assert_eq!(
        reasoning_effort_override(
            &preference(Some("xhigh")),
            ReasoningSupport::Unknown,
            &ReasoningControl::Pending,
        ),
        None
    );
    assert_eq!(
        reasoning_ask(
            &preference(Some("xhigh")),
            ReasoningSupport::Unknown,
            &ReasoningControl::Pending,
        ),
        Some(ReasoningAsk::Enabled)
    );
}

#[test]
fn what_is_reported_is_what_the_turn_actually_sends() {
    // The whole point of the field: a status read that disagreed with the
    // wire would be a more convincing lie than the silence it replaces. Both
    // answers come off one resolution, and this is the check that says so.
    for (preference, support, control) in [
        (
            preference(Some("xhigh")),
            ReasoningSupport::Supported,
            menu(&["high", "low"], Some("high")),
        ),
        (
            preference(Some("xhigh")),
            ReasoningSupport::Supported,
            menu(&["high", "low"], None),
        ),
        (
            preference(Some("low")),
            ReasoningSupport::Supported,
            menu(&["high", "low"], Some("high")),
        ),
        (
            preference(Some("xhigh")),
            ReasoningSupport::Supported,
            ReasoningControl::Locked,
        ),
        (
            preference(Some("xhigh")),
            ReasoningSupport::Unknown,
            ReasoningControl::Pending,
        ),
    ] {
        let ask = reasoning_ask(&preference, support, &control);
        let expected = match (
            reasoning_effort_override(&preference, support, &control),
            support,
        ) {
            // A reported substitution names what goes out in its place. This
            // is the load-bearing half: a status saying `high` while the wire
            // carries something else is worse than the silence it replaced.
            (Some(reported), _) => reported.sending,
            // Nothing reported and a probed menu behind it: the stored
            // preference goes out verbatim.
            (None, ReasoningSupport::Supported) => preference.effort.clone(),
            // Nothing reported and no answered verdict: the effort fails
            // closed (§4.2) without the menu substituting anything — see
            // `an_unanswered_verdict_is_not_reported_as_the_menu_substituting_anything`.
            (None, _) => None,
        };
        let sent = match ask {
            Some(ReasoningAsk::Effort(effort)) => Some(effort),
            Some(ReasoningAsk::Enabled) => None,
            None => None,
        };
        assert_eq!(
            sent, expected,
            "{control:?} with {preference:?} must report the effort it sends"
        );
    }
}

#[test]
fn every_listed_model_gets_a_control_from_one_catalogue_body() {
    // One fetch warms the whole cache, so the parse answers for every id the
    // body carries — including the one that publishes no reasoning block,
    // which is `Hidden` rather than missing. "Listed and silent" and "not in
    // this body at all" are different facts, and only the second is `Pending`.
    let controls = parse_openrouter_reasoning_controls(CAPTURED_MODELS).unwrap();

    // Written out rather than computed by calling the function under test:
    // three of these rows used to be `reasoning_control(captured(id))`, which
    // agrees with the implementation by construction and would keep agreeing
    // through any change to it.
    assert_eq!(
        controls,
        vec![
            (
                "openai/gpt-5.6-luna-pro".to_string(),
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
            ),
            (
                "x-ai/grok-4.6".to_string(),
                ReasoningControl::Efforts {
                    options: vec!["xhigh".into(), "high".into(), "medium".into(), "low".into()],
                    default_effort: Some("high".into()),
                    can_disable: false,
                }
            ),
            (
                "nvidia/nemotron-3-ultra-550b-a55b".to_string(),
                ReasoningControl::Efforts {
                    options: vec!["high".into(), "medium".into()],
                    default_effort: Some("high".into()),
                    can_disable: true,
                }
            ),
            (
                "inclusionai/ling-3.0-flash".to_string(),
                ReasoningControl::Toggle { default_on: true }
            ),
            (
                "dots-studio/dots-3-note-preview:free".to_string(),
                ReasoningControl::Toggle { default_on: false }
            ),
            ("openrouter/auto-beta".to_string(), ReasoningControl::Hidden),
        ]
    );
}

#[test]
fn a_default_effort_naming_the_off_sentinel_is_dropped_rather_than_preselected() {
    // A record can name `none` as its default while also listing it as a
    // menu item. The sentinel leaves the menu, so keeping it as the default
    // would preselect a value the menu no longer offers — which the
    // effort-setting command then refuses, leaving a control whose own
    // default it will not accept.
    assert_eq!(
        reasoning_control(Some(&RawReasoningCapability {
            supported_efforts: Some(vec!["high".into(), "none".into()]),
            default_effort: Some("none".into()),
            ..RawReasoningCapability::default()
        })),
        ReasoningControl::Efforts {
            options: vec!["high".into()],
            default_effort: None,
            can_disable: true,
        }
    );
}

#[test]
fn a_malformed_catalogue_body_warms_no_controls_rather_than_erroring() {
    assert!(parse_openrouter_reasoning_controls(r#"{"data":"#).is_none());
    assert_eq!(parse_openrouter_reasoning_controls("{}"), Some(vec![]));
}

#[test]
fn one_unreadable_reasoning_block_does_not_take_the_rest_of_the_body_with_it() {
    // `reasoning` shares one raw record with pricing, `context_length` and the
    // id list. A strict parse would fail the WHOLE body on a single odd
    // record, so a model whose reasoning block arrived in a shape we cannot
    // read would silently break prompt budgeting (issue #22) and the model
    // menu as well.
    let json = r#"{"data":[
        {"id":"vendor/odd","reasoning":"high","pricing":{"prompt":"0.000002"},"context_length":65536,
         "supported_parameters":["reasoning"]},
        {"id":"vendor/ordinary","reasoning":{"mandatory":true},"pricing":{"prompt":"0.000004"},"context_length":32768}
    ]}"#;

    assert_eq!(
        parse_openrouter_reasoning_controls(json),
        Some(vec![
            ("vendor/odd".to_string(), ReasoningControl::Hidden),
            ("vendor/ordinary".to_string(), ReasoningControl::Locked),
        ])
    );
    assert_eq!(
        parse_openrouter_context_windows(json),
        Some(vec![
            ("vendor/odd".to_string(), 65_536),
            ("vendor/ordinary".to_string(), 32_768),
        ])
    );
    assert_eq!(
        parse_openrouter_input_pricing(json, "vendor/odd")
            .unwrap()
            .input_usd_per_token,
        0.000002
    );
    assert_eq!(
        openrouter_reasoning_support(json, "vendor/odd"),
        ReasoningSupport::Supported
    );
}
