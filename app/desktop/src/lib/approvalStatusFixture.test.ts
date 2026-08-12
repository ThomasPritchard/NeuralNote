// The frontend half of the approval fixture's drift gate (issue #120).
//
// `crates/neuralnote-core/tests/approval_status_fixture.rs` ties the tracked
// JSON to Rust. That alone fixes nothing here: `ApprovalSettings.test.tsx`
// derives its per-tool cases from the fixture's own keys, so a regenerated
// fixture would flow a new tool into the derived cases and still never prove the
// frontend had heard of it. The chain needs a second link, and this file is it —
// `GATED_TOOL_WIRE_NAMES` is exhaustive over the ts-rs-generated `GatedTool`
// union, so it cannot compile without an entry for every tool Rust gates, and
// the assertions below tie its values to the fixture's keys.
//
// Read end to end: Rust's `ALL_GATED_TOOLS` → the generated JSON → the wire-name
// registry → the `GatedTool` union → Rust again. Add a gated tool and there is
// nowhere along that loop for the frontend to stay quietly ignorant of it.

import { describe, expect, it } from "vitest";

import { ALWAYS_ASK_APPROVAL_STATUS } from "./approvalStatusFixture";
import { GATED_TOOL_WIRE_NAMES } from "./gatedToolWireNames";
import type { ApprovalMode } from "./types";

/** Exhaustive over the generated `ApprovalMode` union for the same reason the
 *  wire-name registry is exhaustive over `GatedTool`: a mode added in Rust must
 *  not be able to reach the frontend as an unrecognised string. */
const KNOWN_APPROVAL_MODES: Record<ApprovalMode, true> = {
  alwaysAsk: true,
  approveForMe: true,
  yolo: true,
};

const isApprovalMode = (value: string): boolean =>
  Object.hasOwn(KNOWN_APPROVAL_MODES, value);

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("the generated approval fixture", () => {
  it("is keyed by exactly the gated tools this frontend knows the wire name of", () => {
    // THE drift gate. A tool added in Rust reaches the fixture through the
    // generated JSON; it reaches `GATED_TOOL_WIRE_NAMES` only when a human adds
    // it, and until they do the registry does not compile. So this failing means
    // one of two things, both worth stopping for: a wire name is spelled wrong,
    // or a gated tool exists that no frontend code has been taught about.
    expect(sorted(Object.keys(ALWAYS_ASK_APPROVAL_STATUS.effectiveModes))).toEqual(
      sorted(Object.values(GATED_TOOL_WIRE_NAMES)),
    );
  });

  it("describes a fresh install with nothing running unattended", () => {
    // The reason this fixture exists at all. Most suites that consume it never
    // assert the modes themselves, so a fixture that quietly said `yolo` would
    // leave them green while describing a build nobody would ship.
    expect(ALWAYS_ASK_APPROVAL_STATUS.mode).toBe("alwaysAsk");
    expect(ALWAYS_ASK_APPROVAL_STATUS.toolOverrides).toEqual({});
    expect(Object.values(ALWAYS_ASK_APPROVAL_STATUS.effectiveModes)).toEqual(
      Object.keys(ALWAYS_ASK_APPROVAL_STATUS.effectiveModes).map(() => "alwaysAsk"),
    );
    // A fresh install has no key, so the judge cannot run. Consumers that want
    // the cloud lane say so explicitly rather than inheriting it from here.
    expect(ALWAYS_ASK_APPROVAL_STATUS.classifierAvailable).toBe(false);
  });

  it("carries real approval modes, not whatever strings the JSON happened to hold", () => {
    // What backs the type assertion in `approvalStatusFixture.ts`: importing
    // JSON widens every value to `string`, so without this the fixture could
    // claim to be an `ApprovalStatus` while holding a mode no build recognises.
    expect(isApprovalMode(ALWAYS_ASK_APPROVAL_STATUS.mode)).toBe(true);
    for (const mode of Object.values(ALWAYS_ASK_APPROVAL_STATUS.effectiveModes)) {
      expect(isApprovalMode(mode)).toBe(true);
    }
  });

  it("names at least one irreversible action for the YOLO warning to list", () => {
    // Rust golden-tests the phrases themselves. What this side owns is that the
    // list arrives non-empty: `listSentence([])` is null, so an empty list turns
    // the YOLO confirmation's "things it cannot take back" paragraph into a
    // lead-in with nothing after it.
    expect(ALWAYS_ASK_APPROVAL_STATUS.irreversibleActions.length).toBeGreaterThan(0);
  });
});
