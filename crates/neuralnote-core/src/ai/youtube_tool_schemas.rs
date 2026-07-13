//! JSON schemas for the five model-facing YouTube distil tools.

use crate::ai::tools::{
    function_tool, TOOL_FETCH_CAPTIONS, TOOL_FETCH_VIDEO_INFO, TOOL_RESOLVE_DISTIL_ROUTE,
    TOOL_SELECT_PLAYLIST_VIDEOS, TOOL_TRANSCRIBE_AUDIO,
};
use serde_json::{json, Value};

pub(super) fn active_schemas() -> [(&'static str, Value); 5] {
    [
        (
            TOOL_FETCH_VIDEO_INFO,
            function_tool(
                TOOL_FETCH_VIDEO_INFO,
                "Inspect validated YouTube metadata and caption availability without exposing extractor JSON.",
                json!({
                    "type": "object",
                    "properties": { "url": { "type": "string", "maxLength": 2048 } },
                    "required": ["url"],
                    "additionalProperties": false
                }),
            ),
        ),
        (
            TOOL_FETCH_CAPTIONS,
            function_tool(
                TOOL_FETCH_CAPTIONS,
                "Fetch and render timestamped captions. Only genuine caption absence permits local transcription.",
                json!({
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "maxLength": 2048 },
                        "lang": { "type": "string", "default": "en", "maxLength": 64 }
                    },
                    "required": ["url"],
                    "additionalProperties": false
                }),
            ),
        ),
        (
            TOOL_TRANSCRIBE_AUDIO,
            function_tool(
                TOOL_TRANSCRIBE_AUDIO,
                "Transcribe locally with the pinned Whisper model after fetch_captions proved both caption inventories empty.",
                json!({
                    "type": "object",
                    "properties": { "url": { "type": "string", "maxLength": 2048 } },
                    "required": ["url"],
                    "additionalProperties": false
                }),
            ),
        ),
        (
            TOOL_SELECT_PLAYLIST_VIDEOS,
            function_tool(
                TOOL_SELECT_PLAYLIST_VIDEOS,
                "Enumerate a playlist and ask the user to choose videos. Returns only selected validated ids.",
                json!({
                    "type": "object",
                    "properties": {
                        "playlist_url": { "type": "string", "maxLength": 2048 }
                    },
                    "required": ["playlist_url"],
                    "additionalProperties": false
                }),
            ),
        ),
        (
            TOOL_RESOLVE_DISTIL_ROUTE,
            function_tool(
                TOOL_RESOLVE_DISTIL_ROUTE,
                "Detect the vault scheme and suggest an existing folder plus neighbouring notes whose conventions should be copied.",
                json!({
                    "type": "object",
                    "properties": {
                        "topic": { "type": "string", "minLength": 1, "maxLength": 200 }
                    },
                    "required": ["topic"],
                    "additionalProperties": false
                }),
            ),
        ),
    ]
}
