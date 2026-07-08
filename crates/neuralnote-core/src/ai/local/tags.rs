//! Ollama `/api/tags` parsing.
//!
//! The shell owns HTTP; the core owns the response contract so every client gets
//! the same strict "installed model" shape and the same typed parse failures.

use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub tag: String,
    pub size_bytes: u64,
    pub family: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
}

#[derive(Deserialize)]
struct RawTagsResponse {
    models: Vec<RawInstalledModel>,
}

#[derive(Deserialize)]
struct RawInstalledModel {
    name: String,
    size: u64,
    #[serde(default)]
    details: Option<RawModelDetails>,
}

#[derive(Deserialize, Default)]
struct RawModelDetails {
    #[serde(default)]
    family: Option<String>,
    #[serde(default)]
    parameter_size: Option<String>,
    #[serde(default, rename = "quantization_level")]
    quantization: Option<String>,
}

pub fn parse_installed_models(json: &str) -> CoreResult<Vec<InstalledModel>> {
    let raw: RawTagsResponse = serde_json::from_str(json)
        .map_err(|e| CoreError::LocalAi(format!("could not parse installed local models: {e}")))?;

    Ok(raw
        .models
        .into_iter()
        .map(|model| {
            let details = model.details.unwrap_or_default();
            InstalledModel {
                tag: model.name,
                size_bytes: model.size,
                family: details.family,
                parameter_size: details.parameter_size,
                quantization: details.quantization,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreError;

    #[test]
    fn parses_full_installed_models_fixture() {
        let models = parse_installed_models(
            r#"{"models":[{"name":"qwen2.5:7b","model":"qwen2.5:7b","size":4683075271,"digest":"sha256:abc","details":{"parent_model":"","format":"gguf","family":"qwen2","families":["qwen2"],"parameter_size":"7.6B","quantization_level":"Q4_K_M"}},{"name":"llama3.2:3b","model":"llama3.2:3b","size":2019393189,"details":{"family":"llama","parameter_size":"3.2B","quantization_level":"Q4_K_M"}}]}"#,
        )
        .unwrap();

        assert_eq!(
            models,
            vec![
                InstalledModel {
                    tag: "qwen2.5:7b".into(),
                    size_bytes: 4_683_075_271,
                    family: Some("qwen2".into()),
                    parameter_size: Some("7.6B".into()),
                    quantization: Some("Q4_K_M".into()),
                },
                InstalledModel {
                    tag: "llama3.2:3b".into(),
                    size_bytes: 2_019_393_189,
                    family: Some("llama".into()),
                    parameter_size: Some("3.2B".into()),
                    quantization: Some("Q4_K_M".into()),
                },
            ]
        );
    }

    #[test]
    fn parses_empty_models_array() {
        assert_eq!(parse_installed_models(r#"{"models":[]}"#).unwrap(), vec![]);
    }

    #[test]
    fn malformed_json_surfaces_as_local_ai_error() {
        assert!(matches!(
            parse_installed_models(r#"{"models":"#),
            Err(CoreError::LocalAi(_))
        ));
    }
}
