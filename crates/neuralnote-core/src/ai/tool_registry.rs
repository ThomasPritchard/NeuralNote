//! The closed set of tools the model can call, and the human title each one
//! shows on the timeline.
//!
//! The title table lives here, in Rust, for one reason: the UI must never compose
//! or string-match a tool label. [`RegisteredTool::title`] and
//! [`RegisteredTool::name`] are exhaustive matches with no wildcard arm, and
//! `tools::dispatch` routes on this enum — so a new tool cannot be dispatched
//! until it has been given both a name and a title, enforced by the compiler.

pub const TOOL_LIST_NOTES: &str = "list_notes";
pub const TOOL_LIST_FOLDERS: &str = "list_folders";
pub const TOOL_SEARCH_NOTES: &str = "search_notes";
pub const TOOL_READ_NOTE_SPAN: &str = "read_note_span";
pub const TOOL_USE_SKILL: &str = "use_skill";
pub const TOOL_SKILL_STEP: &str = "skill_step";
pub const TOOL_ASK_USER: &str = "ask_user";
pub const TOOL_WRITE_NOTE: &str = "write_note";
pub const TOOL_FETCH_VIDEO_INFO: &str = "fetch_video_info";
pub const TOOL_FETCH_CAPTIONS: &str = "fetch_captions";
pub const TOOL_TRANSCRIBE_AUDIO: &str = "transcribe_audio";
pub const TOOL_SELECT_PLAYLIST_VIDEOS: &str = "select_playlist_videos";
pub const TOOL_RESOLVE_DISTIL_ROUTE: &str = "resolve_distil_route";
pub const TOOL_UPDATE_PLAN: &str = "update_plan";

/// The label shown for a name that is not a registered tool. The model can invent
/// one; the call is rejected, but it still gets a timeline node — with a title we
/// wrote, never the string the model made up.
pub const UNKNOWN_TOOL_TITLE: &str = "Unrecognised tool";

/// One tool the dispatcher can route. Closed on purpose: `tools::dispatch` matches
/// on this enum, so a tool that can actually be called must appear here, and both
/// matches below are wildcard-free — adding a variant without a title is a
/// compile error, not a blank label on someone's screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisteredTool {
    ListNotes,
    ListFolders,
    SearchNotes,
    ReadNoteSpan,
    UseSkill,
    SkillStep,
    AskUser,
    WriteNote,
    FetchVideoInfo,
    FetchCaptions,
    TranscribeAudio,
    SelectPlaylistVideos,
    ResolveDistilRoute,
    UpdatePlan,
}

impl RegisteredTool {
    /// Every registered tool, for callers that need the whole set (schema/registry
    /// agreement checks, and the tests that keep this table honest).
    pub const ALL: [Self; 14] = [
        Self::ListNotes,
        Self::ListFolders,
        Self::SearchNotes,
        Self::ReadNoteSpan,
        Self::UseSkill,
        Self::SkillStep,
        Self::AskUser,
        Self::WriteNote,
        Self::FetchVideoInfo,
        Self::FetchCaptions,
        Self::TranscribeAudio,
        Self::SelectPlaylistVideos,
        Self::ResolveDistilRoute,
        Self::UpdatePlan,
    ];

    /// The model-facing wire name.
    pub const fn name(self) -> &'static str {
        match self {
            Self::ListNotes => TOOL_LIST_NOTES,
            Self::ListFolders => TOOL_LIST_FOLDERS,
            Self::SearchNotes => TOOL_SEARCH_NOTES,
            Self::ReadNoteSpan => TOOL_READ_NOTE_SPAN,
            Self::UseSkill => TOOL_USE_SKILL,
            Self::SkillStep => TOOL_SKILL_STEP,
            Self::AskUser => TOOL_ASK_USER,
            Self::WriteNote => TOOL_WRITE_NOTE,
            Self::FetchVideoInfo => TOOL_FETCH_VIDEO_INFO,
            Self::FetchCaptions => TOOL_FETCH_CAPTIONS,
            Self::TranscribeAudio => TOOL_TRANSCRIBE_AUDIO,
            Self::SelectPlaylistVideos => TOOL_SELECT_PLAYLIST_VIDEOS,
            Self::ResolveDistilRoute => TOOL_RESOLVE_DISTIL_ROUTE,
            Self::UpdatePlan => TOOL_UPDATE_PLAN,
        }
    }

    /// The human label for the timeline. Deliberately tense-neutral: one label
    /// serves the live node and the settled one, so the UI never composes either.
    pub const fn title(self) -> &'static str {
        match self {
            Self::ListNotes => "List notes",
            Self::ListFolders => "List folders",
            Self::SearchNotes => "Search notes",
            Self::ReadNoteSpan => "Read note",
            Self::UseSkill => "Activate skill",
            Self::SkillStep => "Skill progress",
            Self::AskUser => "Ask you",
            Self::WriteNote => "Write note",
            Self::FetchVideoInfo => "Fetch video details",
            Self::FetchCaptions => "Fetch captions",
            Self::TranscribeAudio => "Transcribe audio",
            Self::SelectPlaylistVideos => "Choose playlist videos",
            Self::ResolveDistilRoute => "Choose transcript source",
            Self::UpdatePlan => "Plan",
        }
    }

    /// Resolve a wire name the model sent. `None` for anything unregistered —
    /// the dispatcher rejects it, and [`title_for`] still labels it.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tool| tool.name() == name)
    }
}

/// The timeline label for any tool name, registered or not.
pub fn title_for(name: &str) -> &'static str {
    match RegisteredTool::from_name(name) {
        Some(tool) => tool.title(),
        None => UNKNOWN_TOOL_TITLE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn every_registered_tool_round_trips_between_name_and_variant() {
        for tool in RegisteredTool::ALL {
            assert_eq!(RegisteredTool::from_name(tool.name()), Some(tool));
        }
    }

    #[test]
    fn every_registered_tool_has_a_distinct_non_empty_title() {
        let titles: BTreeSet<&str> = RegisteredTool::ALL.iter().map(|t| t.title()).collect();
        assert_eq!(
            titles.len(),
            RegisteredTool::ALL.len(),
            "two tools share a title, so the timeline cannot tell them apart"
        );
        assert!(titles.iter().all(|title| !title.trim().is_empty()));
    }

    #[test]
    fn an_unknown_tool_name_still_gets_a_rust_authored_title() {
        // The model can invent a tool name. That call is rejected, but it must
        // still reach the timeline with a label WE wrote — never its own prose.
        assert_eq!(title_for("definitely_not_a_tool"), UNKNOWN_TOOL_TITLE);
        assert_eq!(RegisteredTool::from_name("definitely_not_a_tool"), None);
    }

    #[test]
    fn title_for_resolves_every_registered_name() {
        for tool in RegisteredTool::ALL {
            assert_eq!(title_for(tool.name()), tool.title());
            assert_ne!(title_for(tool.name()), UNKNOWN_TOOL_TITLE);
        }
    }

    #[test]
    fn no_title_leaks_the_snake_case_tool_name() {
        // A title is a human label, not the wire name echoed back at the user.
        for tool in RegisteredTool::ALL {
            assert_ne!(tool.title(), tool.name());
        }
    }
}
