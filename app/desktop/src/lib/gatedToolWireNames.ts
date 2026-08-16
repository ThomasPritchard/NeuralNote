// The wire name of every gated tool, keyed by its `GatedTool` variant.
//
// Rust speaks both dialects: `GatedTool` crosses IPC as a camelCase identifier
// (`"writeNote"`), while `toolOverrides` and `effectiveModes` are keyed by the
// snake_case `TOOL_*` constant the dispatcher routes on (`"write_note"`). This
// table is the one place the frontend states the correspondence.
//
// **It is a `Record<GatedTool, string>` on purpose, and that is the whole point
// of the file.** `GatedTool` is generated from Rust by ts-rs, so adding a gated
// tool over there and regenerating bindings makes this object fail to compile
// until someone declares the new tool's wire name. That compile error is the
// only thing standing between "Rust gates a new action" and "the settings
// surface silently stops covering one" — before it existed, the frontend's idea
// of the gated set was a hand-written literal in a fixture, and the fixture was
// the only thing the settings suite compared itself against (issue #120).
//
// `approvalStatusFixture.test.ts` asserts these values are exactly the keys of
// the Rust-generated fixture, so a wrong wire name here is caught too — the
// compiler proves the set is COMPLETE, the test proves the names are RIGHT.

import type { GatedTool } from "./types";

export const GATED_TOOL_WIRE_NAMES: Record<GatedTool, string> = {
  writeNote: "write_note",
  useSkill: "use_skill",
  selectPlaylistVideos: "select_playlist_videos",
  resolveDistilRoute: "resolve_distil_route",
  fetchVideoInfo: "fetch_video_info",
  fetchCaptions: "fetch_captions",
  transcribeAudio: "transcribe_audio",
};
