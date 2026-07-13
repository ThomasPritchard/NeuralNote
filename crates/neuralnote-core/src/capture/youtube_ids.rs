//! Validated identifier types used at the host-owned YouTube I/O boundary.

use crate::capture::CaptureError;

/// A validated YouTube video id.
///
/// A valid id may start with `-`. Any host that passes it to a shell or process
/// argv must place it after `--` or in an argv position that cannot be parsed as
/// a flag. Core never invokes a shell or process itself.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VideoId(String);

impl VideoId {
    pub fn new(value: &str) -> Result<Self, CaptureError> {
        if valid_video_id(value) {
            Ok(Self(value.to_string()))
        } else {
            Err(CaptureError::InvalidSource(
                "video id must be exactly 11 URL-safe characters".into(),
            ))
        }
    }
}

impl AsRef<str> for VideoId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for VideoId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A validated HTTPS YouTube URL retained exactly as supplied.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct YoutubeUrl(String);

impl YoutubeUrl {
    pub fn new(value: &str) -> Result<Self, CaptureError> {
        if value.is_empty()
            || value.len() > 2_048
            || value
                .chars()
                .any(|character| character.is_control() || character.is_whitespace())
        {
            return Err(CaptureError::InvalidSource(
                "YouTube URL must contain 1 to 2048 visible non-whitespace characters".into(),
            ));
        }
        let lower = value.to_ascii_lowercase();
        let valid_host = lower.starts_with("https://www.youtube.com/")
            || lower.starts_with("https://youtube.com/")
            || lower.starts_with("https://m.youtube.com/")
            || lower.starts_with("https://youtu.be/");
        if !valid_host {
            return Err(CaptureError::InvalidSource(
                "source must be an https YouTube or youtu.be URL".into(),
            ));
        }
        Ok(Self(value.to_string()))
    }

    /// Extract a video id from the supported watch, short-link, shorts, embed,
    /// and live URL shapes without consulting untrusted extractor output.
    pub fn video_id(&self) -> Option<VideoId> {
        let lower = self.0.to_ascii_lowercase();
        const SHORT: &str = "https://youtu.be/";
        if lower.starts_with(SHORT) {
            let candidate = self.0[SHORT.len()..].split(['?', '#', '/']).next()?;
            return VideoId::new(candidate).ok();
        }

        let path_and_query = [
            "https://www.youtube.com/",
            "https://youtube.com/",
            "https://m.youtube.com/",
        ]
        .into_iter()
        .find_map(|prefix| lower.starts_with(prefix).then(|| &self.0[prefix.len()..]))?;
        if let Some(query) = path_and_query.strip_prefix("watch?") {
            let query = query.split('#').next()?;
            let candidate = query.split('&').find_map(|pair| {
                let (name, value) = pair.split_once('=')?;
                (name == "v").then_some(value)
            })?;
            return VideoId::new(candidate).ok();
        }
        let mut segments = path_and_query.split(['?', '#', '/']);
        match segments.next()? {
            "shorts" | "embed" | "live" => VideoId::new(segments.next()?).ok(),
            _ => None,
        }
    }
}

impl AsRef<str> for YoutubeUrl {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for YoutubeUrl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

pub(super) fn valid_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
