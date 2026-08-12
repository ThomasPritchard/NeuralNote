// The safe default `ApprovalStatus`, shared by the e2e mock vault and every test
// that builds an `AiStatus` by hand.
//
// It exists so those call sites cannot drift into asserting an *unsafe* default
// by accident: a fixture that quietly said `yolo` would make a suite pass while
// describing a build nobody would ship.
//
// **Generated, not written.** The values used to be literals here — seven
// snake_case tool keys and three English phrases — with nothing checking them
// against the Rust tables they mirror. The comment in this file said it was
// "never a second source of truth", and in the test tier that was exactly what
// it had become (issue #120). The JSON below is now emitted from
// `ProviderConfig::default()` by `crates/neuralnote-core/tests/approval_status_fixture.rs`,
// which reddens under plain `cargo test` when the tracked copy drifts.
// Regenerate with:
//
//   UPDATE_APPROVAL_STATUS_FIXTURE=1 cargo test -p neuralnote-core --test approval_status_fixture

import generatedDefault from "./fixtures/approval-status-default.json";
import type { ApprovalStatus } from "./types";

/** What a fresh install, and any pre-feature `ai-config.json`, resolves to.
 *
 *  The assertion is what a JSON import costs: TypeScript widens the file's
 *  string values to `string`, losing `ApprovalMode`. It is not a claim taken on
 *  trust — `approvalStatusFixture.test.ts` asserts the modes are real
 *  `ApprovalMode` values and that the tool keys are exactly the ones this build
 *  knows about. */
export const ALWAYS_ASK_APPROVAL_STATUS = generatedDefault as ApprovalStatus;
