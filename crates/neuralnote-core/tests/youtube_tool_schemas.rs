use neuralnote_core::ai::tools::{
    advertised_tool_names, tool_schemas, TOOL_FETCH_CAPTIONS, TOOL_FETCH_VIDEO_INFO,
    TOOL_RESOLVE_DISTIL_ROUTE, TOOL_SELECT_PLAYLIST_VIDEOS, TOOL_TRANSCRIBE_AUDIO,
};
use std::collections::BTreeSet;

fn youtube_names() -> BTreeSet<String> {
    BTreeSet::from([
        TOOL_FETCH_VIDEO_INFO.into(),
        TOOL_FETCH_CAPTIONS.into(),
        TOOL_TRANSCRIBE_AUDIO.into(),
        TOOL_SELECT_PLAYLIST_VIDEOS.into(),
        TOOL_RESOLVE_DISTIL_ROUTE.into(),
    ])
}

#[test]
fn youtube_tool_names_are_advertised_only_when_granted() {
    let inactive = advertised_tool_names(&tool_schemas(&BTreeSet::new()));
    for name in youtube_names() {
        assert!(!inactive.contains(&name));
    }

    let active = advertised_tool_names(&tool_schemas(&youtube_names()));
    for name in youtube_names() {
        assert!(active.contains(&name), "missing {name}");
    }
}

#[test]
fn youtube_tool_schemas_freeze_model_facing_argument_shapes() {
    let schemas = tool_schemas(&youtube_names());
    let by_name = |name: &str| {
        schemas
            .iter()
            .find(|schema| schema["function"]["name"] == name)
            .unwrap()
    };

    for (name, required) in [
        (TOOL_FETCH_VIDEO_INFO, serde_json::json!(["url"])),
        (TOOL_FETCH_CAPTIONS, serde_json::json!(["url"])),
        (TOOL_TRANSCRIBE_AUDIO, serde_json::json!(["url"])),
        (
            TOOL_SELECT_PLAYLIST_VIDEOS,
            serde_json::json!(["playlist_url"]),
        ),
        (TOOL_RESOLVE_DISTIL_ROUTE, serde_json::json!(["topic"])),
    ] {
        let parameters = &by_name(name)["function"]["parameters"];
        assert_eq!(parameters["type"], "object");
        assert_eq!(parameters["required"], required);
        assert_eq!(parameters["additionalProperties"], false);
    }

    let captions = &by_name(TOOL_FETCH_CAPTIONS)["function"]["parameters"];
    assert_eq!(captions["properties"]["lang"]["default"], "en");
    let route = &by_name(TOOL_RESOLVE_DISTIL_ROUTE)["function"]["parameters"];
    assert_eq!(route["properties"]["topic"]["maxLength"], 200);
    assert!(
        by_name(TOOL_TRANSCRIBE_AUDIO)["function"]["parameters"]["properties"]
            .get("model")
            .is_none()
    );
}
