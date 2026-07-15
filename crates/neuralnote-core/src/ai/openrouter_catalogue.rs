//! Pure validation and joining for OpenRouter's daily ranking and model
//! catalogue responses.

use crate::error::{CoreError, CoreResult};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const MIN_CONTEXT_LENGTH: u64 = 32_768;
const MAX_JAVASCRIPT_SAFE_CONTEXT_LENGTH: u64 = 9_007_199_254_740_991;
const MAX_MODELS: usize = 10;
const MAX_RANKING_RECORDS: usize = 64;
const MAX_CATALOGUE_RECORDS: usize = 4_096;
const MAX_MODEL_ID_LENGTH: usize = 256;
const MAX_MODEL_NAME_LENGTH: usize = 256;
const MAX_SUPPORTED_PARAMETERS: usize = 128;
const MAX_PARAMETER_LENGTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterRankedModel {
    pub id: String,
    pub name: String,
    pub context_length: u64,
    pub rank: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterRankedModels {
    pub models: Vec<OpenRouterRankedModel>,
    pub as_of: String,
}

#[derive(Deserialize)]
struct RawRankings {
    data: Vec<RawRanking>,
    meta: RawRankingsMeta,
}

#[derive(Deserialize)]
struct RawRanking {
    date: String,
    model_permaslug: String,
    total_tokens: String,
}

#[derive(Deserialize)]
struct RawRankingsMeta {
    as_of: String,
    end_date: String,
    start_date: String,
    version: String,
}

#[derive(Deserialize)]
struct RawCatalogue {
    data: Vec<RawCatalogueModel>,
}

#[derive(Deserialize)]
struct RawCatalogueModel {
    id: String,
    canonical_slug: String,
    name: String,
    context_length: u64,
    supported_parameters: Vec<String>,
}

/// Return the most recent fully completed UTC calendar day.
pub fn latest_completed_utc_day(now: DateTime<Utc>) -> NaiveDate {
    now.date_naive()
        .pred_opt()
        .unwrap_or_else(|| now.date_naive())
}

/// Validate OpenRouter's untrusted responses, join daily ranks to canonical
/// catalogue slugs, and return at most ten app-owned choices.
pub fn rank_openrouter_models(
    rankings_json: &str,
    catalogue_json: &str,
    expected_date: &str,
) -> CoreResult<OpenRouterRankedModels> {
    let expected_date = parse_iso_date(expected_date, "requested ranking date")?;
    let rankings: RawRankings = serde_json::from_str(rankings_json).map_err(|error| {
        CoreError::Llm(format!(
            "could not parse OpenRouter daily rankings: {error}"
        ))
    })?;
    validate_rankings_meta(&rankings.meta, expected_date)?;
    let ranked = validate_and_sort_rankings(rankings.data, expected_date)?;

    let catalogue: RawCatalogue = serde_json::from_str(catalogue_json).map_err(|error| {
        CoreError::Llm(format!(
            "could not parse OpenRouter model catalogue: {error}"
        ))
    })?;
    let catalogue = validate_catalogue(catalogue.data)?;

    let models = ranked
        .into_iter()
        .enumerate()
        .filter_map(|(index, ranking)| {
            let model = catalogue.get(&ranking.model_permaslug)?;
            if model.context_length < MIN_CONTEXT_LENGTH
                || !model
                    .supported_parameters
                    .iter()
                    .any(|parameter| parameter == "tools")
            {
                return None;
            }
            Some(OpenRouterRankedModel {
                id: model.id.clone(),
                name: model.name.clone(),
                context_length: model.context_length,
                rank: index + 1,
            })
        })
        .take(MAX_MODELS)
        .collect();

    Ok(OpenRouterRankedModels {
        models,
        as_of: expected_date.to_string(),
    })
}

fn validate_rankings_meta(meta: &RawRankingsMeta, expected_date: NaiveDate) -> CoreResult<()> {
    let end_date = parse_iso_date(&meta.end_date, "OpenRouter ranking end date")?;
    if end_date != expected_date {
        return Err(CoreError::Llm(format!(
            "OpenRouter ranking end date did not match requested date {expected_date}"
        )));
    }

    let start_date = parse_iso_date(&meta.start_date, "OpenRouter ranking start date")?;
    if start_date > end_date {
        return Err(CoreError::Llm(
            "OpenRouter ranking start date was after its end date".into(),
        ));
    }
    validate_text(&meta.version, 32, "OpenRouter ranking dataset version")?;
    let as_of = DateTime::parse_from_rfc3339(&meta.as_of)
        .map_err(|_| CoreError::Llm("OpenRouter ranking as-of timestamp is invalid".into()))?;
    if as_of.offset().local_minus_utc() != 0 {
        return Err(CoreError::Llm(
            "OpenRouter ranking as-of timestamp is not UTC".into(),
        ));
    }

    Ok(())
}

fn validate_and_sort_rankings(
    records: Vec<RawRanking>,
    expected_date: NaiveDate,
) -> CoreResult<Vec<ValidatedRanking>> {
    if records.len() > MAX_RANKING_RECORDS {
        return Err(CoreError::Llm(
            "OpenRouter returned too many daily ranking records".into(),
        ));
    }

    let mut seen = HashSet::with_capacity(records.len());
    let mut ranked = Vec::new();
    for record in records {
        let date = parse_iso_date(&record.date, "OpenRouter ranking record date")?;
        validate_identifier(
            &record.model_permaslug,
            "OpenRouter ranking model permaslug",
        )?;
        let duplicate_key = (date, record.model_permaslug.clone());
        if !seen.insert(duplicate_key) {
            return Err(CoreError::Llm(
                "OpenRouter returned a duplicate daily ranking record".into(),
            ));
        }
        let total_tokens = parse_token_total(&record.total_tokens)?;
        if date == expected_date && record.model_permaslug != "other" {
            ranked.push(ValidatedRanking {
                model_permaslug: record.model_permaslug,
                total_tokens,
            });
        }
    }

    ranked.sort_by(|left, right| {
        right
            .total_tokens
            .cmp(&left.total_tokens)
            .then_with(|| left.model_permaslug.cmp(&right.model_permaslug))
    });
    Ok(ranked)
}

struct ValidatedRanking {
    model_permaslug: String,
    total_tokens: u128,
}

fn validate_catalogue(
    records: Vec<RawCatalogueModel>,
) -> CoreResult<HashMap<String, RawCatalogueModel>> {
    if records.len() > MAX_CATALOGUE_RECORDS {
        return Err(CoreError::Llm(
            "OpenRouter returned too many catalogue records".into(),
        ));
    }

    for model in &records {
        validate_catalogue_model(model)?;
    }

    let mut ids = HashSet::with_capacity(records.len());
    let mut grouped_by_canonical_slug = HashMap::<String, Vec<RawCatalogueModel>>::new();
    for model in records {
        if !ids.insert(model.id.clone()) {
            return Err(CoreError::Llm(
                "OpenRouter returned a duplicate catalogue model id".into(),
            ));
        }
        grouped_by_canonical_slug
            .entry(model.canonical_slug.clone())
            .or_default()
            .push(model);
    }

    let mut by_canonical_slug = HashMap::with_capacity(grouped_by_canonical_slug.len());
    for (canonical_slug, models) in grouped_by_canonical_slug {
        let model = if models.len() == 1 {
            models.into_iter().next().expect("one catalogue model")
        } else {
            // OpenRouter lists qualified variants such as `:free` and `:thinking`
            // beside one base inference ID under the same permanent slug. Daily
            // rankings use that shared slug, so select only the unique base.
            let mut bases = models.into_iter().filter(|model| !model.id.contains(':'));
            let Some(base) = bases.next() else {
                return Err(CoreError::Llm(
                    "OpenRouter returned a duplicate catalogue canonical slug".into(),
                ));
            };
            if bases.next().is_some() {
                return Err(CoreError::Llm(
                    "OpenRouter returned a duplicate catalogue canonical slug".into(),
                ));
            }
            base
        };
        by_canonical_slug.insert(canonical_slug, model);
    }

    Ok(by_canonical_slug)
}

fn validate_catalogue_model(model: &RawCatalogueModel) -> CoreResult<()> {
    validate_identifier(&model.id, "OpenRouter catalogue model id")?;
    validate_identifier(&model.canonical_slug, "OpenRouter catalogue canonical slug")?;
    validate_text(
        &model.name,
        MAX_MODEL_NAME_LENGTH,
        "OpenRouter catalogue model name",
    )?;
    if model.context_length > MAX_JAVASCRIPT_SAFE_CONTEXT_LENGTH {
        return Err(CoreError::Llm(
            "OpenRouter catalogue context length exceeds the exact JavaScript integer range".into(),
        ));
    }
    if model.supported_parameters.len() > MAX_SUPPORTED_PARAMETERS {
        return Err(CoreError::Llm(
            "OpenRouter catalogue model listed too many supported parameters".into(),
        ));
    }
    for parameter in &model.supported_parameters {
        validate_text(
            parameter,
            MAX_PARAMETER_LENGTH,
            "OpenRouter supported parameter",
        )?;
    }
    Ok(())
}

fn parse_token_total(raw: &str) -> CoreResult<u128> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CoreError::Llm(
            "OpenRouter ranking token total is invalid".into(),
        ));
    }
    raw.parse::<u128>()
        .map_err(|_| CoreError::Llm("OpenRouter ranking token total is invalid".into()))
}

fn parse_iso_date(raw: &str, field: &str) -> CoreResult<NaiveDate> {
    let strict_shape = raw.len() == 10
        && raw.bytes().enumerate().all(|(index, byte)| match index {
            4 | 7 => byte == b'-',
            _ => byte.is_ascii_digit(),
        });
    if !strict_shape {
        return Err(CoreError::Llm(format!("{field} is invalid")));
    }
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| CoreError::Llm(format!("{field} is invalid")))
}

fn validate_identifier(value: &str, field: &str) -> CoreResult<()> {
    validate_text(value, MAX_MODEL_ID_LENGTH, field)
}

fn validate_text(value: &str, max_length: usize, field: &str) -> CoreResult<()> {
    if value.is_empty()
        || value.len() > max_length
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(CoreError::Llm(format!("{field} is invalid")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{latest_completed_utc_day, rank_openrouter_models};
    use crate::error::CoreError;
    use chrono::{TimeZone, Utc};
    use serde_json::{json, Value};

    const DATE: &str = "2026-07-13";

    fn ranking(slug: &str, total_tokens: &str) -> Value {
        json!({
            "date": DATE,
            "model_permaslug": slug,
            "total_tokens": total_tokens,
        })
    }

    fn catalogue_model(
        id: &str,
        canonical_slug: &str,
        name: &str,
        context_length: u64,
        supported_parameters: &[&str],
    ) -> Value {
        json!({
            "id": id,
            "canonical_slug": canonical_slug,
            "name": name,
            "context_length": context_length,
            "supported_parameters": supported_parameters,
        })
    }

    fn rankings_json(data: Vec<Value>) -> String {
        json!({
            "data": data,
            "meta": {
                "as_of": "2026-07-14T02:00:00Z",
                "end_date": DATE,
                "start_date": DATE,
                "version": "v1",
            }
        })
        .to_string()
    }

    fn catalogue_json(data: Vec<Value>) -> String {
        json!({ "data": data }).to_string()
    }

    fn compatible_model(slug: &str) -> Value {
        catalogue_model(slug, slug, slug, 32_768, &["tools"])
    }

    #[test]
    fn latest_completed_utc_day_is_the_previous_calendar_day() {
        let midnight = Utc.with_ymd_and_hms(2026, 7, 14, 0, 0, 0).unwrap();
        let afternoon = Utc.with_ymd_and_hms(2026, 7, 14, 16, 45, 0).unwrap();

        assert_eq!(latest_completed_utc_day(midnight).to_string(), DATE);
        assert_eq!(latest_completed_utc_day(afternoon).to_string(), DATE);
    }

    #[test]
    fn latest_completed_utc_day_handles_month_year_and_leap_boundaries() {
        assert_eq!(
            latest_completed_utc_day(Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap())
                .to_string(),
            "2025-12-31"
        );
        assert_eq!(
            latest_completed_utc_day(Utc.with_ymd_and_hms(2024, 3, 1, 12, 0, 0).unwrap())
                .to_string(),
            "2024-02-29"
        );
    }

    #[test]
    fn expected_date_must_be_a_real_strict_iso_date() {
        let rankings = rankings_json(vec![]);
        let catalogue = catalogue_json(vec![]);

        for invalid in [
            "",
            "2026-7-13",
            "2026-07-1",
            "2026-02-30",
            " 2026-07-13",
            "2026-07-13\n",
        ] {
            let result = rank_openrouter_models(&rankings, &catalogue, invalid);
            assert!(matches!(result, Err(CoreError::Llm(_))), "{invalid:?}");
        }
    }

    #[test]
    fn rankings_meta_end_date_must_match_the_requested_completed_day() {
        let rankings = json!({
            "data": [],
            "meta": {
                "as_of": "2026-07-14T02:00:00Z",
                "end_date": "2026-07-12",
                "start_date": "2026-07-12",
                "version": "v1",
            }
        })
        .to_string();

        let result = rank_openrouter_models(&rankings, &catalogue_json(vec![]), DATE);

        assert!(matches!(result, Err(CoreError::Llm(message)) if message.contains("end date")));
    }

    #[test]
    fn rankings_meta_is_required_and_validated() {
        let catalogue = catalogue_json(vec![]);
        let cases = [
            json!({ "data": [] }),
            json!({ "data": [], "meta": { "end_date": DATE } }),
            json!({
                "data": [],
                "meta": {
                    "as_of": "not-a-timestamp",
                    "end_date": DATE,
                    "start_date": DATE,
                    "version": "v1",
                }
            }),
        ];

        for raw in cases {
            assert!(matches!(
                rank_openrouter_models(&raw.to_string(), &catalogue, DATE),
                Err(CoreError::Llm(_))
            ));
        }
    }

    #[test]
    fn excludes_other_and_sorts_token_totals_numerically() {
        let rankings = rankings_json(vec![
            ranking("vendor/two", "9"),
            ranking("other", "999999999"),
            ranking("vendor/one", "100"),
            ranking("vendor/three", "10"),
        ]);
        let catalogue = catalogue_json(vec![
            compatible_model("vendor/one"),
            compatible_model("vendor/two"),
            compatible_model("vendor/three"),
        ]);

        let result = rank_openrouter_models(&rankings, &catalogue, DATE).unwrap();

        assert_eq!(
            result
                .models
                .iter()
                .map(|model| (model.id.as_str(), model.rank))
                .collect::<Vec<_>>(),
            vec![("vendor/one", 1), ("vendor/three", 2), ("vendor/two", 3)]
        );
    }

    #[test]
    fn joins_rankings_by_canonical_slug_and_uses_catalogue_display_fields() {
        let rankings = rankings_json(vec![ranking("vendor/permanent-model", "100")]);
        let catalogue = catalogue_json(vec![catalogue_model(
            "vendor/current-alias",
            "vendor/permanent-model",
            "Current Model Name",
            65_536,
            &["tools"],
        )]);

        let result = rank_openrouter_models(&rankings, &catalogue, DATE).unwrap();

        assert_eq!(result.as_of, DATE);
        assert_eq!(result.models.len(), 1);
        assert_eq!(result.models[0].id, "vendor/current-alias");
        assert_eq!(result.models[0].name, "Current Model Name");
        assert_eq!(result.models[0].context_length, 65_536);
        assert_eq!(result.models[0].rank, 1);
    }

    #[test]
    fn shared_canonical_slug_selects_the_unqualified_base_regardless_of_catalogue_order() {
        let rankings = rankings_json(vec![ranking("tencent/hy3-20260706", "100")]);
        let free_variant = catalogue_model(
            "tencent/hy3:free",
            "tencent/hy3-20260706",
            "HY 3 Free",
            65_536,
            &["tools"],
        );
        let base = catalogue_model(
            "tencent/hy3",
            "tencent/hy3-20260706",
            "HY 3",
            65_536,
            &["tools"],
        );

        for records in [
            vec![free_variant.clone(), base.clone()],
            vec![base.clone(), free_variant.clone()],
        ] {
            let result = rank_openrouter_models(&rankings, &catalogue_json(records), DATE).unwrap();

            assert_eq!(result.models.len(), 1);
            assert_eq!(result.models[0].id, "tencent/hy3");
            assert_eq!(result.models[0].name, "HY 3");
        }
    }

    #[test]
    fn singleton_variant_catalogue_record_remains_selectable() {
        let rankings = rankings_json(vec![ranking("vendor/model-permanent", "100")]);
        let catalogue = catalogue_json(vec![catalogue_model(
            "vendor/model:free",
            "vendor/model-permanent",
            "Model Free",
            65_536,
            &["tools"],
        )]);

        let result = rank_openrouter_models(&rankings, &catalogue, DATE).unwrap();

        assert_eq!(result.models[0].id, "vendor/model:free");
    }

    #[test]
    fn shared_canonical_slug_without_one_unqualified_base_fails_closed() {
        let rankings = rankings_json(vec![ranking("vendor/model-permanent", "100")]);
        let catalogue = catalogue_json(vec![
            catalogue_model(
                "vendor/model:free",
                "vendor/model-permanent",
                "Model Free",
                65_536,
                &["tools"],
            ),
            catalogue_model(
                "vendor/model:thinking",
                "vendor/model-permanent",
                "Model Thinking",
                65_536,
                &["tools"],
            ),
        ]);

        assert!(matches!(
            rank_openrouter_models(&rankings, &catalogue, DATE),
            Err(CoreError::Llm(message)) if message.contains("duplicate catalogue canonical slug")
        ));
    }

    #[test]
    fn malformed_variant_is_rejected_before_the_valid_base_is_selected() {
        let rankings = rankings_json(vec![ranking("vendor/model-permanent", "100")]);
        let catalogue = catalogue_json(vec![
            catalogue_model(
                "vendor/model",
                "vendor/model-permanent",
                "Model",
                65_536,
                &["tools"],
            ),
            catalogue_model(
                "vendor/model:free",
                "vendor/model-permanent",
                "Model Free\nInjected",
                65_536,
                &["tools"],
            ),
        ]);

        assert!(matches!(
            rank_openrouter_models(&rankings, &catalogue, DATE),
            Err(CoreError::Llm(message)) if message.contains("catalogue model name is invalid")
        ));
    }

    #[test]
    fn requires_exact_tools_support_and_minimum_context() {
        let rankings = rankings_json(vec![
            ranking("vendor/uppercase", "50"),
            ranking("vendor/tool-choice", "40"),
            ranking("vendor/too-small", "30"),
            ranking("vendor/minimum", "20"),
        ]);
        let catalogue = catalogue_json(vec![
            catalogue_model(
                "vendor/uppercase",
                "vendor/uppercase",
                "Uppercase",
                65_536,
                &["Tools"],
            ),
            catalogue_model(
                "vendor/tool-choice",
                "vendor/tool-choice",
                "Tool choice only",
                65_536,
                &["tool_choice"],
            ),
            catalogue_model(
                "vendor/too-small",
                "vendor/too-small",
                "Too small",
                32_767,
                &["tools"],
            ),
            catalogue_model(
                "vendor/minimum",
                "vendor/minimum",
                "Minimum",
                32_768,
                &["tools"],
            ),
        ]);

        let result = rank_openrouter_models(&rankings, &catalogue, DATE).unwrap();

        assert_eq!(
            result
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["vendor/minimum"]
        );
        assert_eq!(result.models[0].rank, 4);
    }

    #[test]
    fn ties_are_ordered_by_permaslug_and_source_ranks_remain_stable_after_filtering() {
        let rankings = rankings_json(vec![
            ranking("vendor/z", "100"),
            ranking("vendor/unsupported", "200"),
            ranking("vendor/a", "100"),
        ]);
        let catalogue = catalogue_json(vec![
            compatible_model("vendor/z"),
            catalogue_model(
                "vendor/unsupported",
                "vendor/unsupported",
                "Unsupported",
                65_536,
                &[],
            ),
            compatible_model("vendor/a"),
        ]);

        let result = rank_openrouter_models(&rankings, &catalogue, DATE).unwrap();

        assert_eq!(
            result
                .models
                .iter()
                .map(|model| (model.id.as_str(), model.rank))
                .collect::<Vec<_>>(),
            vec![("vendor/a", 2), ("vendor/z", 3)]
        );
    }

    #[test]
    fn unmatched_rankings_are_not_backfilled_with_unranked_catalogue_models() {
        let rankings = rankings_json(vec![ranking("vendor/not-in-catalogue", "100")]);
        let catalogue = catalogue_json(vec![compatible_model("vendor/unranked")]);

        let result = rank_openrouter_models(&rankings, &catalogue, DATE).unwrap();

        assert!(result.models.is_empty());
    }

    #[test]
    fn duplicate_ranking_and_catalogue_records_fail_closed() {
        let valid_catalogue = catalogue_json(vec![compatible_model("vendor/model")]);
        let duplicate_rankings = rankings_json(vec![
            ranking("vendor/model", "100"),
            ranking("vendor/model", "90"),
        ]);
        assert!(matches!(
            rank_openrouter_models(&duplicate_rankings, &valid_catalogue, DATE),
            Err(CoreError::Llm(message)) if message.contains("duplicate")
        ));

        let rankings = rankings_json(vec![ranking("vendor/model", "100")]);
        let ambiguous_canonical = catalogue_json(vec![
            catalogue_model(
                "vendor/model-a",
                "vendor/model",
                "Model A",
                65_536,
                &["tools"],
            ),
            catalogue_model(
                "vendor/model-b",
                "vendor/model",
                "Model B",
                65_536,
                &["tools"],
            ),
        ]);
        assert!(matches!(
            rank_openrouter_models(&rankings, &ambiguous_canonical, DATE),
            Err(CoreError::Llm(message)) if message.contains("duplicate catalogue canonical slug")
        ));
    }

    #[test]
    fn duplicate_catalogue_ids_fail_even_when_canonical_slugs_differ() {
        let rankings = rankings_json(vec![ranking("vendor/one", "100")]);
        let catalogue = catalogue_json(vec![
            catalogue_model("vendor/shared-id", "vendor/one", "One", 65_536, &["tools"]),
            catalogue_model("vendor/shared-id", "vendor/two", "Two", 65_536, &["tools"]),
        ]);

        assert!(matches!(
            rank_openrouter_models(&rankings, &catalogue, DATE),
            Err(CoreError::Llm(message)) if message.contains("duplicate")
        ));
    }

    #[test]
    fn malformed_records_and_non_numeric_token_totals_fail_closed() {
        let catalogue = catalogue_json(vec![compatible_model("vendor/model")]);
        for invalid_total in ["", "1.5", "-1", "+1", " 1", "1e3", "not-a-number"] {
            let rankings = rankings_json(vec![ranking("vendor/model", invalid_total)]);
            assert!(matches!(
                rank_openrouter_models(&rankings, &catalogue, DATE),
                Err(CoreError::Llm(_))
            ));
        }

        let malformed_ranking = rankings_json(vec![json!({
            "date": DATE,
            "model_permaslug": "vendor/model"
        })]);
        assert!(rank_openrouter_models(&malformed_ranking, &catalogue, DATE).is_err());

        let rankings = rankings_json(vec![ranking("vendor/model", "100")]);
        let malformed_catalogue = catalogue_json(vec![json!({
            "id": "vendor/model",
            "canonical_slug": "vendor/model",
            "name": "Model",
            "context_length": "65536",
            "supported_parameters": ["tools"]
        })]);
        assert!(rank_openrouter_models(&rankings, &malformed_catalogue, DATE).is_err());
    }

    #[test]
    fn context_lengths_that_cannot_cross_javascript_exactly_fail_closed() {
        let rankings = rankings_json(vec![ranking("vendor/model", "100")]);
        let catalogue = catalogue_json(vec![catalogue_model(
            "vendor/model",
            "vendor/model",
            "Model",
            9_007_199_254_740_992,
            &["tools"],
        )]);

        assert!(matches!(
            rank_openrouter_models(&rankings, &catalogue, DATE),
            Err(CoreError::Llm(message)) if message.contains("context length")
        ));
    }

    #[test]
    fn control_characters_in_provider_strings_fail_closed() {
        let catalogue = catalogue_json(vec![compatible_model("vendor/model")]);
        let ranking_with_control = rankings_json(vec![ranking("vendor/mo\ndel", "100")]);
        assert!(rank_openrouter_models(&ranking_with_control, &catalogue, DATE).is_err());

        let rankings = rankings_json(vec![ranking("vendor/model", "100")]);
        for field in ["id", "canonical_slug", "name"] {
            let mut model = compatible_model("vendor/model");
            model[field] = Value::String("vendor/mo\u{0000}del".into());
            assert!(
                rank_openrouter_models(&rankings, &catalogue_json(vec![model]), DATE).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn returns_fewer_than_ten_without_unranked_backfill_and_caps_at_ten() {
        let few_rankings =
            rankings_json(vec![ranking("vendor/one", "2"), ranking("vendor/two", "1")]);
        let few_catalogue = catalogue_json(vec![
            compatible_model("vendor/one"),
            compatible_model("vendor/two"),
            compatible_model("vendor/unranked"),
        ]);
        assert_eq!(
            rank_openrouter_models(&few_rankings, &few_catalogue, DATE)
                .unwrap()
                .models
                .len(),
            2
        );

        let rankings = rankings_json(
            (0..12)
                .map(|index| {
                    ranking(
                        &format!("vendor/model-{index:02}"),
                        &format!("{}", 100 - index),
                    )
                })
                .collect(),
        );
        let catalogue = catalogue_json(
            (0..12)
                .map(|index| compatible_model(&format!("vendor/model-{index:02}")))
                .collect(),
        );
        let result = rank_openrouter_models(&rankings, &catalogue, DATE).unwrap();

        assert_eq!(result.models.len(), 10);
        assert_eq!(result.models[0].rank, 1);
        assert_eq!(result.models[9].rank, 10);
    }

    #[test]
    fn public_output_never_contains_ranking_token_totals() {
        let rankings = rankings_json(vec![ranking("vendor/model", "987654321")]);
        let catalogue = catalogue_json(vec![compatible_model("vendor/model")]);

        let output = rank_openrouter_models(&rankings, &catalogue, DATE).unwrap();
        let serialized = serde_json::to_string(&output).unwrap();

        assert!(!serialized.contains("987654321"));
        assert!(!serialized.contains("total_tokens"));
        assert!(!serialized.contains("totalTokens"));
    }
}
