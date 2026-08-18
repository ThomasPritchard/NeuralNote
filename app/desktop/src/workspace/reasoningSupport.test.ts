// The two derivations the reasoning affordances share. `reasoningCapability`
// answers "may the send path ask for reasoning" from the probe verdict;
// `reasoningAlwaysOn` answers "can the user turn it off" from the control the
// backend computed — the fact both the composer chip and Settings render, and
// which they used to answer differently.

import { describe, expect, it } from "vitest";
import type { ReasoningControl } from "../lib/types";
import { reasoningAlwaysOn, reasoningCapability } from "./reasoningSupport";

describe("reasoningCapability", () => {
  it("disables only on a verified unsupported verdict, naming the model", () => {
    expect(reasoningCapability("unsupported", "acme/no-thoughts")).toEqual({
      disabled: true,
      reason: "acme/no-thoughts can't return reasoning.",
    });
  });

  it("fails open on an unanswered probe", () => {
    expect(reasoningCapability("unknown", "acme/one")).toEqual({
      disabled: false,
      reason: null,
    });
  });

  it("enables a verified supported model", () => {
    expect(reasoningCapability("supported", "acme/one")).toEqual({
      disabled: false,
      reason: null,
    });
  });
});

describe("reasoningAlwaysOn", () => {
  it("is true for a model whose reasoning is mandatory", () => {
    expect(reasoningAlwaysOn({ kind: "locked" })).toBe(true);
  });

  it("is true for an effort menu with no off position", () => {
    // `mandatory: true` alongside a menu: the user picks how hard the model
    // thinks without being able to stop it thinking.
    expect(
      reasoningAlwaysOn({
        kind: "efforts",
        options: ["high", "low"],
        defaultEffort: "high",
        canDisable: false,
      }),
    ).toBe(true);
  });

  it("is false for an effort menu that can be switched off", () => {
    expect(
      reasoningAlwaysOn({
        kind: "efforts",
        options: ["high", "low"],
        defaultEffort: null,
        canDisable: true,
      }),
    ).toBe(false);
  });

  it("is false for a plain toggle, whatever the model's own default", () => {
    expect(reasoningAlwaysOn({ kind: "toggle", defaultOn: true })).toBe(false);
    expect(reasoningAlwaysOn({ kind: "toggle", defaultOn: false })).toBe(false);
  });

  it("is false while the probe has not answered", () => {
    // "Not yet known" must never render as "always on" — that is the guessed
    // control spec §4.2 fails closed against.
    expect(reasoningAlwaysOn({ kind: "pending" })).toBe(false);
  });

  it("is false for a model that cannot reason at all", () => {
    expect(reasoningAlwaysOn({ kind: "hidden" })).toBe(false);
  });

  it("names every variant, so a new control has to answer this question", () => {
    // Compile-time, really: the implementation switches without a `default:`
    // arm, so adding a variant is a type error rather than a silent `false`.
    // This case only pins that the union it switches over is the whole union.
    const every: ReasoningControl[] = [
      { kind: "hidden" },
      { kind: "pending" },
      { kind: "toggle", defaultOn: false },
      { kind: "locked" },
      { kind: "efforts", options: [], defaultEffort: null, canDisable: true },
    ];
    expect(every.map(reasoningAlwaysOn)).toEqual([false, false, false, true, false]);
  });
});
