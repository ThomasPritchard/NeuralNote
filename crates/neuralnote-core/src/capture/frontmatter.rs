//! Appendix A `nn.source` frontmatter policy.

use crate::capture::CaptureError;
use chrono::DateTime;
use serde_yaml_ng::{Mapping, Value};

const MAX_URL_BYTES: usize = 4_096;
const MAX_SOURCE_PATH_BYTES: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceType {
    Youtube,
    Article,
    Pdf,
    Text,
}

impl SourceType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Youtube => "youtube",
            Self::Article => "article",
            Self::Pdf => "pdf",
            Self::Text => "text",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NnSource {
    source_type: SourceType,
    url: String,
    captured_at: String,
    full_source: String,
    content_hash: String,
}

impl NnSource {
    pub fn new(
        source_type: SourceType,
        url: impl Into<String>,
        captured_at: impl Into<String>,
        full_source: impl Into<String>,
        content_hash: impl Into<String>,
    ) -> Result<Self, CaptureError> {
        let url = url.into();
        let captured_at = captured_at.into();
        let full_source = full_source.into();
        let content_hash = content_hash.into();
        validate_url(&url)?;
        DateTime::parse_from_rfc3339(&captured_at)
            .map_err(|_| invalid_source("nn.source.captured_at must be an RFC 3339 timestamp"))?;
        validate_relative_source_path(&full_source)?;
        validate_content_hash(&content_hash)?;
        Ok(Self {
            source_type,
            url,
            captured_at,
            full_source,
            content_hash,
        })
    }

    fn to_mapping(&self) -> Mapping {
        let mut source = Mapping::new();
        source.insert(key("type"), string(self.source_type.as_str()));
        source.insert(key("url"), string(&self.url));
        source.insert(key("captured_at"), string(&self.captured_at));
        source.insert(key("full_source"), string(&self.full_source));
        source.insert(key("content_hash"), string(&self.content_hash));
        source
    }
}

/// Add `nn.source` without replacing vault-owned keys or existing `nn` siblings.
pub fn merge_nn_source(existing: &Value, source: &NnSource) -> Result<Value, CaptureError> {
    let mut merged = existing.clone();
    let root = merged.as_mapping_mut().ok_or_else(|| {
        invalid_source("frontmatter root must be a YAML mapping before adding nn.source")
    })?;
    let nn_key = key("nn");
    if !root.contains_key(&nn_key) {
        root.insert(nn_key.clone(), Value::Mapping(Mapping::new()));
    }
    let nn = root
        .get_mut(&nn_key)
        .and_then(Value::as_mapping_mut)
        .ok_or_else(|| invalid_source("existing nn frontmatter value must be a mapping"))?;
    let source_key = key("source");
    if nn.contains_key(&source_key) {
        return Err(invalid_source(
            "existing nn.source conflicts with the source block being added",
        ));
    }
    nn.insert(source_key, Value::Mapping(source.to_mapping()));
    Ok(merged)
}

fn validate_url(url: &str) -> Result<(), CaptureError> {
    let after_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"));
    let host = after_scheme
        .and_then(|value| value.split(['/', '?', '#']).next())
        .unwrap_or_default();
    if url.is_empty()
        || url.len() > MAX_URL_BYTES
        || url
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || host.is_empty()
    {
        Err(invalid_source(
            "nn.source.url must be a bounded HTTP(S) URL",
        ))
    } else {
        Ok(())
    }
}

/// Validate the `full_source` vault-relative path: this boundary's byte cap plus
/// the shared *portable* vault-relative grammar. A stored source path is never a
/// note name and must stay portable across filesystems, so it is validated through
/// [`crate::paths::parse_portable_rel_path`] — which rejects the whole Windows
/// non-portable class (any colon, the `<>"|?*` characters, reserved device names,
/// and the trailing dot/space that could fold toward `..` on Windows) in one place,
/// rather than this boundary hand-rolling a subset.
fn validate_relative_source_path(path: &str) -> Result<(), CaptureError> {
    if path.len() > MAX_SOURCE_PATH_BYTES || crate::paths::parse_portable_rel_path(path).is_err() {
        return Err(invalid_source(
            "nn.source.full_source must be a bounded, portable vault-relative path",
        ));
    }
    Ok(())
}

fn validate_content_hash(content_hash: &str) -> Result<(), CaptureError> {
    let digest = content_hash.strip_prefix("sha256:");
    if matches!(digest, Some(value) if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    {
        Ok(())
    } else {
        Err(invalid_source(
            "nn.source.content_hash must be sha256: followed by 64 lowercase hex characters",
        ))
    }
}

fn invalid_source(detail: impl Into<String>) -> CaptureError {
    CaptureError::InvalidMetadata(detail.into())
}

fn key(value: &str) -> Value {
    Value::String(value.into())
}

fn string(value: &str) -> Value {
    Value::String(value.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_source_path_rejects_windows_trailing_dot_and_space_components() {
        for path in [
            "sources/.. ",    // dot-dot-space folds toward `..` on Windows
            "sources/note ",  // trailing space
            "sources/note.",  // trailing dot
            "bad /full.html", // trailing space on an interior component
        ] {
            assert!(
                validate_relative_source_path(path).is_err(),
                "{path:?} must be refused as a non-portable full_source path"
            );
        }
    }

    #[test]
    fn full_source_path_accepts_a_legitimate_portable_path() {
        assert!(validate_relative_source_path("sources/2026/article.html").is_ok());
        assert!(validate_relative_source_path(".neuralnote/sources/full.md").is_ok());
    }
}
