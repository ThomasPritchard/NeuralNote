// The safe default `ApprovalStatus`, shared by the e2e mock vault and every test
// that builds an `AiStatus` by hand.
//
// It exists so those call sites cannot drift into asserting an *unsafe* default
// by accident: a fixture that quietly said `yolo` would make a suite pass while
// describing a build nobody would ship. The real values always come from Rust —
// `commands::ai::build_ai_status` computes `effectiveModes` and
// `irreversibleActions` from the reversibility table — so this is a stand-in for
// a backend that is not running, never a second source of truth.

import type { ApprovalStatus } from "./types";

/** What a fresh install, and any pre-feature `ai-config.json`, resolves to. */
export const ALWAYS_ASK_APPROVAL_STATUS: ApprovalStatus = {
  mode: "alwaysAsk",
  toolOverrides: {},
  effectiveModes: {
    write_note: "alwaysAsk",
    use_skill: "alwaysAsk",
    select_playlist_videos: "alwaysAsk",
    resolve_distil_route: "alwaysAsk",
    fetch_video_info: "alwaysAsk",
    fetch_captions: "alwaysAsk",
    transcribe_audio: "alwaysAsk",
  },
  classifierAvailable: false,
  irreversibleActions: [
    "saving how it files your notes",
    "fetching pages and captions from the internet",
    "running audio transcription on your machine",
  ],
};
