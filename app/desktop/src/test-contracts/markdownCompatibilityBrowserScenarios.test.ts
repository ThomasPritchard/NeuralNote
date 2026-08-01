import { describe, expect, it } from "vitest";

import { MARKDOWN_COMPATIBILITY_V1 } from "./markdownCompatibilityV1";
import { selectBrowserCompatibilityScenarios } from "./markdownCompatibilityBrowserScenarios";

function scenarioKey({
  execution,
  interaction,
}: {
  readonly execution: string;
  readonly interaction: string;
}): string {
  return `${execution}\u0000${interaction}`;
}

describe("MarkdownCompatibilityV1 browser scenarios", () => {
  it("selects one deterministic representative for every execution and interaction family", () => {
    const declared = MARKDOWN_COMPATIBILITY_V1.cases.flatMap((item) =>
      item.allowedInteractions.map((interaction) => ({
        item,
        interaction,
        execution: item.interactionExecutions[interaction]!,
      })),
    );
    const selected = selectBrowserCompatibilityScenarios(MARKDOWN_COMPATIBILITY_V1.cases);

    expect(selected.map(scenarioKey)).toEqual([
      ...new Set(declared.map(scenarioKey)),
    ]);
    expect(new Set(selected.map(scenarioKey)).size).toBe(selected.length);
    expect(selected.length).toBeLessThan(declared.length);
    expect(selectBrowserCompatibilityScenarios(MARKDOWN_COMPATIBILITY_V1.cases)).toEqual(selected);
  });

  it("fails explicitly when a compatibility interaction has no browser execution", () => {
    const item = MARKDOWN_COMPATIBILITY_V1.cases[0]!;

    expect(() => selectBrowserCompatibilityScenarios([
      { ...item, interactionExecutions: {} },
    ])).toThrow(`Markdown compatibility case ${JSON.stringify(item.id)} has no browser execution`);
  });
});
