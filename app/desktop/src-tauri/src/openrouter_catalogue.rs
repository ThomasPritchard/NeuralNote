use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDate;
use futures_util::StreamExt;
use neuralnote_core::ai::{OpenRouterRankedModels, ProviderConfig};
use neuralnote_core::CoreError;
use serde::Serialize;
use ts_rs::TS;

const OPENROUTER_DAILY_RANKINGS_URL: &str = "https://openrouter.ai/api/v1/datasets/rankings-daily";
const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
pub(crate) const OPENROUTER_RANKINGS_ATTRIBUTION_URL: &str = "https://openrouter.ai/rankings";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RANKINGS_BODY_BYTES: usize = 256 * 1024;
const MAX_MODELS_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_MODEL_ID_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CatalogueEndpoint {
    DailyRankings { date: String },
    Models,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TransportFailure {
    Network,
    HttpStatus(u16),
    BodyTooLarge,
    InvalidUtf8,
}

pub(crate) struct ReqwestCatalogueTransport {
    client: reqwest::Client,
}

impl ReqwestCatalogueTransport {
    pub(crate) fn new() -> Result<Self, CoreError> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| {
                CoreError::Llm("Could not prepare the OpenRouter model request.".into())
            })?;
        Ok(Self { client })
    }
}

#[async_trait]
pub(crate) trait CatalogueTransport: Send + Sync {
    async fn fetch(
        &self,
        endpoint: CatalogueEndpoint,
        bearer: Option<&str>,
    ) -> Result<String, TransportFailure>;
}

#[async_trait]
impl CatalogueTransport for ReqwestCatalogueTransport {
    async fn fetch(
        &self,
        endpoint: CatalogueEndpoint,
        bearer: Option<&str>,
    ) -> Result<String, TransportFailure> {
        let (mut request, limit) = match &endpoint {
            CatalogueEndpoint::DailyRankings { date } => (
                self.client
                    .get(OPENROUTER_DAILY_RANKINGS_URL)
                    .query(&[("start_date", date.as_str()), ("end_date", date.as_str())]),
                MAX_RANKINGS_BODY_BYTES,
            ),
            CatalogueEndpoint::Models => (
                self.client.get(OPENROUTER_MODELS_URL),
                MAX_MODELS_BODY_BYTES,
            ),
        };
        if let Some(secret) = bearer {
            request = request.bearer_auth(secret);
        }

        let response = request
            .send()
            .await
            .map_err(|_| TransportFailure::Network)?;
        if !response.status().is_success() {
            return Err(TransportFailure::HttpStatus(response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(TransportFailure::BodyTooLarge);
        }

        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| TransportFailure::Network)?;
            append_bounded_chunk(&mut bytes, &chunk, limit)?;
        }
        String::from_utf8(bytes).map_err(|_| TransportFailure::InvalidUtf8)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct OpenRouterModelMenu {
    pub(crate) models: Vec<OpenRouterModelChoice>,
    pub(crate) as_of: String,
    pub(crate) selected_model: String,
    pub(crate) pinned_selected_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct OpenRouterModelChoice {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) context_length: u64,
    pub(crate) rank: usize,
}

#[derive(Clone)]
struct CachedCatalogue {
    day: NaiveDate,
    models: OpenRouterRankedModels,
}

#[derive(Default)]
pub(crate) struct OpenRouterCatalogueState {
    cached: Option<CachedCatalogue>,
    last_offered: HashSet<String>,
}

impl OpenRouterCatalogueState {
    pub(crate) fn remember(&mut self, day: NaiveDate, models: OpenRouterRankedModels) {
        self.cached = Some(CachedCatalogue { day, models });
    }

    pub(crate) fn cached_for(
        &self,
        day: NaiveDate,
        force_refresh: bool,
    ) -> Option<OpenRouterRankedModels> {
        if force_refresh {
            return None;
        }
        self.cached
            .as_ref()
            .filter(|cached| cached.day == day)
            .map(|cached| cached.models.clone())
    }

    pub(crate) fn offer_for(
        &mut self,
        day: NaiveDate,
        selected_model: &str,
    ) -> Result<OpenRouterModelMenu, CoreError> {
        validate_model_id(selected_model)?;
        let cached = self
            .cached
            .as_ref()
            .filter(|cached| cached.day == day)
            .ok_or_else(|| CoreError::Llm("OpenRouter model choices are not loaded.".into()))?;

        let models = cached
            .models
            .models
            .iter()
            .map(|model| OpenRouterModelChoice {
                id: model.id.clone(),
                name: model.name.clone(),
                context_length: model.context_length,
                rank: model.rank,
            })
            .collect::<Vec<_>>();
        let selected_is_ranked = models.iter().any(|model| model.id == selected_model);
        let pinned_selected_model = (!selected_is_ranked).then(|| selected_model.to_string());

        self.last_offered.clear();
        self.last_offered
            .extend(models.iter().map(|model| model.id.clone()));
        self.last_offered.insert(selected_model.to_string());

        Ok(OpenRouterModelMenu {
            models,
            as_of: cached.models.as_of.clone(),
            selected_model: selected_model.to_string(),
            pinned_selected_model,
        })
    }

    #[cfg(test)]
    pub(crate) fn was_offered(&self, model: &str) -> bool {
        self.last_offered.contains(model)
    }

    pub(crate) fn offered_models(&self) -> HashSet<String> {
        self.last_offered.clone()
    }
}

pub(crate) fn append_bounded_chunk(
    body: &mut Vec<u8>,
    chunk: &[u8],
    limit: usize,
) -> Result<(), TransportFailure> {
    if body
        .len()
        .checked_add(chunk.len())
        .is_none_or(|length| length > limit)
    {
        return Err(TransportFailure::BodyTooLarge);
    }
    body.extend_from_slice(chunk);
    Ok(())
}

pub(crate) async fn fetch_validated_catalogue<T: CatalogueTransport + ?Sized>(
    transport: &T,
    date: &str,
    api_key: &str,
) -> Result<OpenRouterRankedModels, CoreError> {
    if api_key.trim().is_empty() {
        return Err(CoreError::Llm(
            "An OpenRouter API key is required to load model rankings.".into(),
        ));
    }
    let rankings = transport
        .fetch(
            CatalogueEndpoint::DailyRankings {
                date: date.to_string(),
            },
            Some(api_key),
        )
        .await
        .map_err(transport_error)?;
    let catalogue = transport
        .fetch(CatalogueEndpoint::Models, None)
        .await
        .map_err(transport_error)?;

    neuralnote_core::ai::rank_openrouter_models(&rankings, &catalogue, date)
        .map_err(|_| CoreError::Llm("OpenRouter returned invalid model data.".into()))
}

pub(crate) fn persist_selected_model(
    config_dir: &Path,
    offered: &HashSet<String>,
    model: &str,
) -> Result<ProviderConfig, CoreError> {
    validate_model_id(model)?;
    if !offered.contains(model) {
        return Err(CoreError::InvalidName(
            "Choose a model from the last loaded OpenRouter list.".into(),
        ));
    }

    let mut config = neuralnote_core::ai::read_provider_config(config_dir)?;
    config.model = model.to_string();
    neuralnote_core::ai::write_provider_config(config_dir, &config)?;
    neuralnote_core::ai::read_provider_config(config_dir)
}

fn validate_model_id(model: &str) -> Result<(), CoreError> {
    if model.is_empty()
        || model.len() > MAX_MODEL_ID_BYTES
        || model.trim() != model
        || model.chars().any(char::is_control)
    {
        return Err(CoreError::InvalidName(
            "The selected OpenRouter model is invalid.".into(),
        ));
    }
    Ok(())
}

fn transport_error(error: TransportFailure) -> CoreError {
    let message = match error {
        TransportFailure::HttpStatus(401 | 403) => {
            "OpenRouter authentication failed. Check your API key."
        }
        TransportFailure::HttpStatus(429) => {
            "OpenRouter model rankings are rate-limited. Try again shortly."
        }
        TransportFailure::HttpStatus(_) => "OpenRouter could not load model choices. Try again.",
        TransportFailure::BodyTooLarge => {
            "OpenRouter returned more model data than NeuralNote can safely process."
        }
        TransportFailure::Network => "NeuralNote could not reach OpenRouter to load model choices.",
        TransportFailure::InvalidUtf8 => "OpenRouter returned invalid model data.",
    };
    CoreError::Llm(message.into())
}
