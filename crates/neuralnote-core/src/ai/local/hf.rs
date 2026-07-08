//! Hugging Face model metadata parsing.
//!
//! This is enrichment only: missing optional fields stay `None`, but malformed
//! JSON is a local-AI failure because the host cannot trust the response shape.

use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HfModelMeta {
    pub id: String,
    pub downloads: Option<u64>,
    pub likes: Option<u64>,
    pub last_modified: Option<String>,
    pub license: Option<String>,
}

#[derive(Deserialize)]
struct RawHfModelMeta {
    #[serde(default)]
    id: String,
    #[serde(default)]
    downloads: Option<u64>,
    #[serde(default)]
    likes: Option<u64>,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default, rename = "cardData")]
    card_data: Option<RawCardData>,
}

#[derive(Deserialize)]
struct RawCardData {
    #[serde(default)]
    license: Option<String>,
}

pub fn parse_hf_metadata(json: &str) -> CoreResult<HfModelMeta> {
    let raw: RawHfModelMeta = serde_json::from_str(json)
        .map_err(|e| CoreError::LocalAi(format!("could not parse Hugging Face metadata: {e}")))?;

    Ok(HfModelMeta {
        id: raw.id,
        downloads: raw.downloads,
        likes: raw.likes,
        last_modified: raw.last_modified,
        license: raw.card_data.and_then(|c| c.license),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreError;

    #[test]
    fn parses_full_hugging_face_metadata_fixture() {
        let meta = parse_hf_metadata(
            r#"{"id":"Qwen/Qwen2.5-7B-Instruct","downloads":1234567,"likes":890,"lastModified":"2025-05-10T08:06:48.000Z","createdAt":"2024-09-01T00:00:00.000Z","cardData":{"license":"apache-2.0"},"tags":["text-generation"],"pipeline_tag":"text-generation"}"#,
        )
        .unwrap();

        assert_eq!(meta.id, "Qwen/Qwen2.5-7B-Instruct");
        assert_eq!(meta.downloads, Some(1_234_567));
        assert_eq!(meta.likes, Some(890));
        assert_eq!(
            meta.last_modified.as_deref(),
            Some("2025-05-10T08:06:48.000Z")
        );
        assert_eq!(meta.license.as_deref(), Some("apache-2.0"));
    }

    #[test]
    fn parses_minimal_metadata_with_missing_fields_as_none() {
        let meta = parse_hf_metadata(r#"{"id":"meta-llama/Llama-3.2-1B-Instruct"}"#).unwrap();

        assert_eq!(meta.id, "meta-llama/Llama-3.2-1B-Instruct");
        assert_eq!(meta.downloads, None);
        assert_eq!(meta.likes, None);
        assert_eq!(meta.last_modified, None);
        assert_eq!(meta.license, None);
    }

    #[test]
    fn card_data_without_license_is_non_fatal() {
        assert_eq!(
            parse_hf_metadata(r#"{"id":"x","cardData":{"foo":1}}"#)
                .unwrap()
                .license,
            None
        );
    }

    #[test]
    fn malformed_json_surfaces_as_local_ai_error() {
        assert!(matches!(
            parse_hf_metadata(r#"{"id":"#),
            Err(CoreError::LocalAi(_))
        ));
    }

    #[test]
    fn serde_uses_camel_case_for_metadata() {
        let value = serde_json::to_value(HfModelMeta {
            id: "x".into(),
            downloads: None,
            likes: None,
            last_modified: Some("2025-05-10T08:06:48.000Z".into()),
            license: Some("apache-2.0".into()),
        })
        .unwrap();

        assert!(value.get("lastModified").is_some());
    }
}
