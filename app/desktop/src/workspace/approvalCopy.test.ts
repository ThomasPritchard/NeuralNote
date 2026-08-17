// The copy table's half of the gated-tool drift gate (issue #146).
//
// `gatedToolWireNames.ts` already proves the frontend knows the COMPLETE gated
// set: it is a `Record<GatedTool, string>`, so a tool added in Rust and
// regenerated through ts-rs cannot compile until someone declares its wire name
// (issue #120). What that registry did not do was reach production. Its only
// importer was `approvalStatusFixture.test.ts`, while every user-facing string
// came from a second, hand-written table in `approvalCopy.ts` that repeated the
// same tool→wire-name correspondence with nothing checking the two agreed.
//
// That mattered because of WHICH table the settings page reads. `ApprovalSettings`
// iterates the backend's own `effectiveModes` keys and resolves each one through
// `gatedToolCopyForKey`, which falls through to a catch-all rendering the raw
// `snake_case` key when it misses. So a mistyped key in the copy table did not
// fail anything — it shipped `resolve_distil_route` to a user, with the suite
// green. The compile-checked registry was guarding a test; the unchecked array
// was what people saw.
//
// These tests tie the two together at the seam the settings page actually uses.

import { describe, expect, it } from "vitest";

import { GATED_TOOL_WIRE_NAMES } from "../lib/gatedToolWireNames";
import type { GatedTool } from "../lib/types";
import { gatedToolCopy, gatedToolCopyForKey } from "./approvalCopy";

/** Every `GatedTool` variant, taken from the registry rather than written out
 *  again — a second hand-written list of tools is the bug this file exists to
 *  stop. The registry is `Record<GatedTool, string>`, so its key set IS the
 *  variant set, and nothing here can quietly test a subset. */
const ALL_GATED_TOOLS = Object.keys(GATED_TOOL_WIRE_NAMES) as GatedTool[];

describe("the gated-tool copy table", () => {
  it("has copy for every tool the wire-name registry knows about", () => {
    // Names the missing tools rather than asserting a count, so a failure says
    // which tool has no copy instead of leaving that to be worked out.
    const withoutCopy = ALL_GATED_TOOLS.filter((tool) => gatedToolCopy(tool) === null);

    expect(withoutCopy).toEqual([]);
  });

  it("takes each entry's persisted key from the registry, not from a second copy of it", () => {
    // THE assertion. Comparing whole objects makes the failure name every tool
    // whose key drifted in one diff, which is what a rename actually looks like.
    const keysByTool = Object.fromEntries(
      ALL_GATED_TOOLS.map((tool) => [tool, gatedToolCopy(tool)?.key ?? null]),
    );

    expect(keysByTool).toEqual(GATED_TOOL_WIRE_NAMES);
  });

  it("resolves every registry wire name to that tool's own copy, the way the settings page does", () => {
    // The production read path: `ApprovalSettings` never looks a tool up by its
    // `GatedTool` variant, only by the backend's snake_case key. So a key the
    // copy table gets wrong is invisible to `gatedToolCopy` callers and hits
    // users here.
    //
    // Deep-equality against the by-tool lookup, deliberately — NOT
    // `.tool === tool`. The catch-all names `writeNote` as a placeholder for
    // keys it cannot map, so a `.tool` check would pass on the catch-all for
    // exactly the tool most likely to be renamed.
    const byKey = ALL_GATED_TOOLS.map((tool) => gatedToolCopyForKey(GATED_TOOL_WIRE_NAMES[tool]));
    const byTool = ALL_GATED_TOOLS.map((tool) => gatedToolCopy(tool));

    expect(byKey).toEqual(byTool);
  });

  it("still renders a key this build has no copy for instead of dropping the row", () => {
    // Pins the deliberate escape hatch. The backend's key set is authoritative
    // about what this build gates, so a row the settings page declined to draw
    // is an action the user cannot govern — an ugly row beats a missing one.
    // Tightening the assertions above must not tempt anyone into deleting it.
    const unknown = gatedToolCopyForKey("a_tool_from_a_newer_build");

    expect(unknown.key).toBe("a_tool_from_a_newer_build");
    expect(unknown.group).toBe("other");
  });
});
