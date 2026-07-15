use std::sync::Mutex;

use async_trait::async_trait;
use chrono::NaiveDate;
use neuralnote_core::ai::{OpenRouterRankedModel, OpenRouterRankedModels, ProviderConfig};

use crate::openrouter_catalogue::{
    append_bounded_chunk, fetch_validated_catalogue, persist_selected_model, CatalogueEndpoint,
    CatalogueTransport, OpenRouterCatalogueState, TransportFailure,
    OPENROUTER_RANKINGS_ATTRIBUTION_URL,
};
use crate::provider_config_mutation::ProviderConfigMutationGate;

const DATE: &str = "2026-07-13";
const KEY: &str = "sk-or-test-secret";

struct FakeTransport {
    requests: Mutex<Vec<(CatalogueEndpoint, bool)>>,
    rankings: Mutex<Result<String, TransportFailure>>,
    catalogue: Mutex<Result<String, TransportFailure>>,
}

impl FakeTransport {
    fn successful(rankings: String, catalogue: String) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            rankings: Mutex::new(Ok(rankings)),
            catalogue: Mutex::new(Ok(catalogue)),
        }
    }
}

#[async_trait]
impl CatalogueTransport for FakeTransport {
    async fn fetch(
        &self,
        endpoint: CatalogueEndpoint,
        bearer: Option<&str>,
    ) -> Result<String, TransportFailure> {
        self.requests
            .lock()
            .unwrap()
            .push((endpoint.clone(), bearer == Some(KEY)));
        match endpoint {
            CatalogueEndpoint::DailyRankings { .. } => self.rankings.lock().unwrap().clone(),
            CatalogueEndpoint::Models => self.catalogue.lock().unwrap().clone(),
        }
    }
}

fn rankings_json() -> String {
    serde_json::json!({
        "data": [{
            "date": DATE,
            "model_permaslug": "vendor/permanent",
            "total_tokens": "100"
        }],
        "meta": {
            "as_of": "2026-07-14T02:00:00Z",
            "end_date": DATE,
            "start_date": DATE,
            "version": "v1"
        }
    })
    .to_string()
}

fn catalogue_json() -> String {
    serde_json::json!({
        "data": [{
            "id": "vendor/current",
            "canonical_slug": "vendor/permanent",
            "name": "Current",
            "context_length": 65_536,
            "supported_parameters": ["tools"]
        }]
    })
    .to_string()
}

fn ranked(models: Vec<OpenRouterRankedModel>) -> OpenRouterRankedModels {
    OpenRouterRankedModels {
        models,
        as_of: DATE.to_string(),
    }
}

#[tokio::test]
async fn transport_authenticates_only_rankings_and_requests_exact_completed_day() {
    let transport = FakeTransport::successful(rankings_json(), catalogue_json());

    let result = fetch_validated_catalogue(&transport, DATE, KEY)
        .await
        .unwrap();

    assert_eq!(result.models[0].id, "vendor/current");
    assert_eq!(
        *transport.requests.lock().unwrap(),
        vec![
            (
                CatalogueEndpoint::DailyRankings {
                    date: DATE.to_string()
                },
                true
            ),
            (CatalogueEndpoint::Models, false),
        ]
    );
}

#[tokio::test]
async fn provider_failures_and_invalid_bodies_are_sanitized() {
    let transport = FakeTransport {
        requests: Mutex::new(Vec::new()),
        rankings: Mutex::new(Err(TransportFailure::HttpStatus(401))),
        catalogue: Mutex::new(Ok("provider-body-that-must-not-leak".into())),
    };
    let error = fetch_validated_catalogue(&transport, DATE, KEY)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("authentication failed"));
    assert!(!error.contains(KEY));
    assert!(!error.contains("provider-body"));

    let malformed = FakeTransport::successful("secret provider body".into(), catalogue_json());
    let error = fetch_validated_catalogue(&malformed, DATE, KEY)
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(error, "llm error: OpenRouter returned invalid model data.");
    assert!(!error.contains("secret provider body"));
}

#[test]
fn bounded_body_rejects_the_chunk_that_crosses_the_limit() {
    let mut body = b"1234".to_vec();
    append_bounded_chunk(&mut body, b"56", 5).unwrap_err();
    assert_eq!(body, b"1234", "oversized bytes must not be appended");
}

#[test]
fn cache_keeps_valid_empty_results_but_expires_daily_and_force_bypasses_it() {
    let day = NaiveDate::parse_from_str(DATE, "%Y-%m-%d").unwrap();
    let next_day = day.succ_opt().unwrap();
    let mut state = OpenRouterCatalogueState::default();
    state.remember(day, ranked(Vec::new()));

    assert!(state.cached_for(day, false).is_some());
    assert!(state.cached_for(day, true).is_none());
    assert!(state.cached_for(next_day, false).is_none());
}

#[test]
fn menu_pins_the_current_model_without_auto_switching_and_records_exact_offers() {
    let day = NaiveDate::parse_from_str(DATE, "%Y-%m-%d").unwrap();
    let mut state = OpenRouterCatalogueState::default();
    state.remember(
        day,
        ranked(vec![OpenRouterRankedModel {
            id: "vendor/ranked".into(),
            name: "Ranked".into(),
            context_length: 65_536,
            rank: 1,
        }]),
    );

    let menu = state.offer_for(day, "vendor/current").unwrap();

    assert_eq!(
        menu.pinned_selected_model.as_deref(),
        Some("vendor/current")
    );
    assert_eq!(menu.selected_model, "vendor/current");
    assert!(state.was_offered("vendor/ranked"));
    assert!(state.was_offered("vendor/current"));
    assert!(!state.was_offered("vendor/not-offered"));
}

#[test]
fn model_selection_changes_only_the_model_and_rejects_unoffered_values() {
    let dir = tempfile::tempdir().unwrap();
    let original = ProviderConfig {
        active_provider: Some(neuralnote_core::ai::ProviderKind::Local),
        model: "vendor/old".into(),
        local_model_tag: Some("qwen2.5:7b".into()),
        reasoning: true,
        reasoning_probe: Some(neuralnote_core::ai::ProbedReasoning {
            model: "vendor/old".into(),
            support: neuralnote_core::ai::ReasoningSupport::Supported,
        }),
        reasoning_probe_generation: 7,
        disabled_skills: vec!["youtube-distil".into()],
    };
    neuralnote_core::ai::write_provider_config(dir.path(), &original).unwrap();
    let offered = ["vendor/new".to_string()].into_iter().collect();

    let gate = ProviderConfigMutationGate::default();
    // Selecting a model is a preference change; the OpenRouter key presence is
    // unchanged, so pass it as a constant. Here the provider is explicitly Local, so
    // the value doesn't affect the effective target — the model change is dormant.
    let persisted =
        persist_selected_model(dir.path(), &gate, true, &offered, "vendor/new").unwrap();

    assert_eq!(persisted.model, "vendor/new");
    assert_eq!(persisted.active_provider, original.active_provider);
    assert_eq!(persisted.local_model_tag, original.local_model_tag);
    assert_eq!(persisted.reasoning, original.reasoning);
    assert_eq!(persisted.reasoning_probe, original.reasoning_probe);
    assert_eq!(
        persisted.reasoning_probe_generation,
        original.reasoning_probe_generation
    );
    assert_eq!(persisted.disabled_skills, original.disabled_skills);

    let before = std::fs::read_to_string(neuralnote_core::ai::provider_config::config_file(
        dir.path(),
    ))
    .unwrap();
    assert!(
        persist_selected_model(dir.path(), &gate, true, &offered, "vendor/not-offered").is_err()
    );
    let after = std::fs::read_to_string(neuralnote_core::ai::provider_config::config_file(
        dir.path(),
    ))
    .unwrap();
    assert_eq!(after, before);
}

#[test]
fn active_openrouter_model_selection_invalidates_probe_ownership_and_cache() {
    let dir = tempfile::tempdir().unwrap();
    neuralnote_core::ai::write_provider_config(
        dir.path(),
        &ProviderConfig {
            active_provider: Some(neuralnote_core::ai::ProviderKind::OpenRouter),
            model: "vendor/old".into(),
            reasoning_probe: Some(neuralnote_core::ai::ProbedReasoning {
                model: "vendor/old".into(),
                support: neuralnote_core::ai::ReasoningSupport::Supported,
            }),
            reasoning_probe_generation: 7,
            ..Default::default()
        },
    )
    .unwrap();
    let offered = ["vendor/new".to_string()].into_iter().collect();

    let persisted = persist_selected_model(
        dir.path(),
        &ProviderConfigMutationGate::default(),
        true,
        &offered,
        "vendor/new",
    )
    .unwrap();

    assert_eq!(persisted.reasoning_probe_generation, 8);
    assert_eq!(persisted.reasoning_probe, None);
}

#[test]
fn rankings_attribution_target_is_fixed_in_rust() {
    assert_eq!(
        OPENROUTER_RANKINGS_ATTRIBUTION_URL,
        "https://openrouter.ai/rankings"
    );
}
