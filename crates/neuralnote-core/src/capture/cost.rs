//! Checked transcript token and input-price estimation.

use crate::capture::CaptureError;
use serde::Serialize;

const METHOD: &str =
    "Estimated tokens = ceil(words × 4 ÷ 3); hosted cost = tokens × the model input price.";
const LOCAL_METHOD: &str =
    "Estimated tokens = ceil(words × 4 ÷ 3); local inference has no hosted token charge.";

#[derive(Debug, Clone, PartialEq)]
pub struct ModelPricing {
    pub model: String,
    pub input_usd_per_token: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PricingInput {
    Hosted(ModelPricing),
    Local,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub word_count: u64,
    pub estimated_tokens: u64,
    pub model: Option<String>,
    pub estimated_cost_usd: Option<f64>,
    pub display: String,
    pub method: String,
}

pub fn estimate_transcript_cost(
    word_count: u64,
    pricing: PricingInput,
) -> Result<CostEstimate, CaptureError> {
    let estimated_tokens = word_count
        .checked_mul(4)
        .and_then(|value| value.checked_add(2))
        .map(|value| value / 3)
        .ok_or_else(|| invalid_cost("word count is too large to estimate safely"))?;
    match pricing {
        PricingInput::Local => Ok(CostEstimate {
            word_count,
            estimated_tokens,
            model: None,
            estimated_cost_usd: None,
            display: "free — runs locally".into(),
            method: LOCAL_METHOD.into(),
        }),
        PricingInput::Hosted(pricing) => {
            validate_pricing(&pricing)?;
            let estimated_cost_usd = estimated_tokens as f64 * pricing.input_usd_per_token;
            if !estimated_cost_usd.is_finite() {
                return Err(invalid_cost("estimated hosted cost overflowed"));
            }
            Ok(CostEstimate {
                word_count,
                estimated_tokens,
                model: Some(pricing.model),
                estimated_cost_usd: Some(estimated_cost_usd),
                display: format!("${estimated_cost_usd:.6} estimated"),
                method: METHOD.into(),
            })
        }
    }
}

fn validate_pricing(pricing: &ModelPricing) -> Result<(), CaptureError> {
    let model = pricing.model.trim();
    if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
        return Err(invalid_cost("hosted model id is empty or invalid"));
    }
    if !pricing.input_usd_per_token.is_finite() || pricing.input_usd_per_token < 0.0 {
        return Err(invalid_cost(
            "hosted input price must be a finite non-negative amount",
        ));
    }
    Ok(())
}

fn invalid_cost(detail: impl Into<String>) -> CaptureError {
    CaptureError::InvalidMetadata(detail.into())
}
