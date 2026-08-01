import type {
  MarkdownAllowedInteractionV1,
  MarkdownBrowserExecutionV1,
  MarkdownCompatibilityCaseV1,
} from "./markdownCompatibilityV1";

export interface MarkdownCompatibilityBrowserScenarioV1 {
  readonly item: MarkdownCompatibilityCaseV1;
  readonly interaction: MarkdownAllowedInteractionV1;
  readonly execution: MarkdownBrowserExecutionV1;
}

function scenarioKey(
  execution: MarkdownBrowserExecutionV1,
  interaction: MarkdownAllowedInteractionV1,
): string {
  return `${execution}\u0000${interaction}`;
}

export function selectBrowserCompatibilityScenarios(
  cases: readonly MarkdownCompatibilityCaseV1[],
): readonly MarkdownCompatibilityBrowserScenarioV1[] {
  // The contract tier covers every case. Real engines need one fixture per
  // execution and interaction pair so each browser path runs without repeating
  // the same edit/copy journey for every supported construct.
  const selected = new Map<string, MarkdownCompatibilityBrowserScenarioV1>();

  for (const item of cases) {
    for (const interaction of item.allowedInteractions) {
      const execution = item.interactionExecutions[interaction];
      if (!execution) {
        throw new Error(
          `Markdown compatibility case ${JSON.stringify(item.id)} has no browser execution for ${JSON.stringify(interaction)}`,
        );
      }

      const key = scenarioKey(execution, interaction);
      if (!selected.has(key)) selected.set(key, { item, interaction, execution });
    }
  }

  return [...selected.values()];
}
