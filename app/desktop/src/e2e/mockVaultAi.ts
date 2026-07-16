// The AI-provider / local-model / skills backend: a self-contained slice of the
// mock command surface with its own state (key config, provider selection,
// installed models, skill toggles). Wired into the dispatch table in
// `mockVault.ts`. Mirrors commands/ai.rs.

import type {
  AiStatus,
  ApiKeyStatus,
  InstalledModel,
  OpenRouterModelMenu,
  ProviderKind,
  PullEvent,
  SkillListing,
} from "../lib/types";
import {
  DEFAULT_CHAT_MODEL,
  fail,
  type CreateMockVaultOptions,
} from "./mockVaultTypes";
import {
  DEFAULT_HARDWARE,
  DEFAULT_LOCAL_CANDIDATES,
  DEFAULT_PULL_SCRIPT,
  DEFAULT_RECOMMENDATION,
  DEFAULT_SKILLS,
} from "./mockVaultDefaults";
import { emitToChannel } from "./mockVaultChannel";

type CommandHandler = (a: Record<string, unknown>) => unknown;

export interface AiBackend {
  handlers: Record<string, CommandHandler>;
}

export const createAiBackend = (opts: CreateMockVaultOptions): AiBackend => {
  // AI key state (mutated by save/clear, reported by api_key_status) + the
  // reasoning verdict. Per-test overridable via opts.
  const keyState = {
    hasKey: opts.apiKey?.hasKey ?? true,
    model: opts.apiKey?.model ?? DEFAULT_CHAT_MODEL,
    // Mirrors `ProviderConfig.reasoning`, whose serde default is false: reasoning
    // tokens are billed, so they are opt-in. Mutated by set_reasoning.
    reasoning: opts.apiKey?.reasoning ?? false,
    // Mirrors `ProviderConfig.cached_reasoning_support()`, which is "unknown"
    // until a model is probed — and "unknown" keeps the toggle enabled, so an
    // unprobed fixture fails open exactly as the real config does.
    reasoningSupported: opts.apiKey?.reasoningSupported ?? "unknown",
  };
  // The verdict the mount-time probe persists when it runs (see the option doc).
  const probedSupport = opts.apiKey?.probedSupport;

  // The built-in skill catalogue, deep-copied so `set_skill_enabled` mutates
  // backend state without aliasing the caller's fixture (mirrors the Rust
  // registry + `disabled_skills` config the real commands read and write).
  const skillsState: SkillListing[] = (opts.skills ?? DEFAULT_SKILLS).map(
    (s) => ({ ...s, requirements: s.requirements.map((r) => ({ ...r })) }),
  );

  // Local-AI provider state, mutated by set_active_provider / pull / delete and
  // reported by ai_status / list_local_models. `explicitProvider` mirrors the Rust
  // `ProviderConfig.active_provider`; `effectiveProvider` mirrors its
  // `effective_provider()` (a key with no explicit choice reads as OpenRouter).
  const aiState = {
    explicitProvider: (opts.activeProvider ?? null) as ProviderKind | null,
    localActiveTag: opts.localActiveTag ?? null,
    installed: [...(opts.installedModels ?? [])] as InstalledModel[],
  };
  const effectiveProvider = (): ProviderKind | null =>
    aiState.explicitProvider ?? (keyState.hasKey ? "openRouter" : null);

  /** Mirror of the core's `build_ai_status`: the effective provider (an explicit
   *  choice wins, else a stored key reads as "openRouter", else null — the
   *  first-run picker), plus each provider's own state. Shared by `ai_status` and
   *  `set_reasoning`, exactly as the Rust command pair shares the real one. */
  const buildAiStatus = (): AiStatus => ({
    activeProvider: effectiveProvider(),
    reasoningSupported: keyState.reasoningSupported,
    openrouter: {
      hasKey: keyState.hasKey,
      model: keyState.model,
      reasoning: keyState.reasoning,
    },
    local: { activeModelTag: aiState.localActiveTag },
  });

  const rankedOpenRouterModels = [
    ["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", 200_000],
    ["openai/gpt-5.2", "GPT-5.2", 400_000],
    ["google/gemini-2.5-pro", "Gemini 2.5 Pro", 1_048_576],
    ["anthropic/claude-opus-4.1", "Claude Opus 4.1", 200_000],
    ["openai/gpt-5-mini", "GPT-5 Mini", 400_000],
    ["deepseek/deepseek-v3.2", "DeepSeek V3.2", 163_840],
    ["x-ai/grok-4", "Grok 4", 256_000],
    ["qwen/qwen3-235b-a22b", "Qwen3 235B", 131_072],
    ["meta-llama/llama-4-maverick", "Llama 4 Maverick", 1_048_576],
    ["mistralai/mistral-large-2512", "Mistral Large", 262_144],
  ] as const;
  let offeredOpenRouterModels = new Set<string>();

  const buildOpenRouterMenu = (): OpenRouterModelMenu => {
    const models = rankedOpenRouterModels.map(([id, name, contextLength], index) => ({
      id,
      name,
      contextLength,
      rank: index + 1,
    }));
    offeredOpenRouterModels = new Set(models.map((model) => model.id));
    return {
      models,
      asOf: "2026-07-13",
      selectedModel: keyState.model,
      pinnedSelectedModel: offeredOpenRouterModels.has(keyState.model) ? null : keyState.model,
    };
  };

  const handlers: Record<string, CommandHandler> = {
    api_key_status: () =>
      ({ hasKey: keyState.hasKey, model: keyState.model } satisfies ApiKeyStatus),
    ai_status: () => buildAiStatus(),
    openrouter_model_menu: () => buildOpenRouterMenu(),
    select_openrouter_model: (a) => {
      const model = a.model as string;
      if (!offeredOpenRouterModels.has(model)) {
        return fail("invalidName", "model was not offered by the current OpenRouter menu");
      }
      keyState.model = model;
      return buildAiStatus();
    },
    open_openrouter_rankings: () => undefined,
    detect_hardware: () => opts.hardware ?? DEFAULT_HARDWARE,
    recommend_local_model: () => opts.recommendation ?? DEFAULT_RECOMMENDATION,
    local_candidates: () => opts.localCandidates ?? DEFAULT_LOCAL_CANDIDATES,
    // The command starts the sidecar in the shell; here it just reports state.
    list_local_models: () => aiState.installed,
    set_active_provider: (a) => {
      aiState.explicitProvider = a.provider as ProviderKind;
      if (a.localModelTag != null) aiState.localActiveTag = a.localModelTag as string;
      return undefined;
    },
    set_reasoning: (a) => {
      // Returns the persisted status, as the Rust command does — the toggle
      // renders this rather than re-reading, so a failed re-read can never show
      // "off" while the config says "on".
      keyState.reasoning = a.enabled as boolean;
      return buildAiStatus();
    },
    refresh_reasoning_support: () => {
      // The capability probe. The real command probes the selected model over
      // the network, PERSISTS the verdict, and returns the freshly persisted
      // status. Mirror that write: when `probedSupport` is set, the probe
      // overwrites the cached verdict (so a test can start at "unknown" and
      // observe the flip); otherwise it echoes the seeded verdict. Drive the
      // fail-open path with `backend.setFailure("refresh_reasoning_support", …)`.
      if (probedSupport !== undefined) keyState.reasoningSupported = probedSupport;
      return buildAiStatus();
    },
    hf_model_metadata: (a) => {
      const repo = a.hfRepo as string;
      const meta = (opts.hfMeta ?? {})[repo];
      // No entry → reject, exactly as an unreachable HF would; the UI treats it
      // as "no metadata" (non-fatal by contract).
      if (!meta) fail("localAi", `no Hugging Face metadata for ${repo}`);
      return meta;
    },
    delete_local_model: (a) => {
      const tag = a.tag as string;
      aiState.installed = aiState.installed.filter((m) => m.tag !== tag);
      if (aiState.localActiveTag === tag) aiState.localActiveTag = null;
      return undefined;
    },
    cancel_pull: () =>
      // The stream is delivered synchronously below, so there's nothing in-flight
      // to interrupt here; a cancel is exercised via a pullScript ending in an
      // error frame. No-op, matching the fire-and-forget command.
      undefined,
    pull_local_model: (a) => {
      const tag = a.tag as string;
      const script = opts.pullScript ?? DEFAULT_PULL_SCRIPT;
      emitToChannel(a.onEvent, script);
      // A successful pull leaves the model installed, exactly as Ollama would, so
      // the subsequent list_local_models / set_active_provider reflect it.
      const succeeded = script.some((e) => (e as PullEvent).type === "success");
      if (succeeded && !aiState.installed.some((m) => m.tag === tag)) {
        aiState.installed.push({
          tag,
          sizeBytes: 4_700_000_000,
          family: null,
          parameterSize: null,
          quantization: null,
        });
      }
      return undefined;
    },
    save_api_key: (a) => {
      // The key itself never crosses back; only presence + model are reported.
      keyState.hasKey = true;
      keyState.model = (a.model as string) || keyState.model;
      return undefined;
    },
    clear_api_key: () => {
      keyState.hasKey = false;
      return undefined;
    },
    list_skills: () =>
      // Fresh objects per call, exactly as serde would deserialise them —
      // callers must never end up sharing (or mutating) backend state.
      skillsState.map((s) => ({
        ...s,
        requirements: s.requirements.map((r) => ({ ...r })),
      })),
    set_skill_enabled: (a) => {
      // Mirrors `set_skill_enabled_in` (commands/ai.rs): an unknown id is an
      // invalidName rejection; a valid write persists and returns the state
      // READ BACK from the store — a fresh post-write lookup, never the
      // request echoed — so if the store ever normalises a write, a frontend
      // that renders the request instead of the response fails the e2e.
      const id = a.id as string;
      const skill = skillsState.find((s) => s.id === id);
      if (!skill) return fail("invalidName", `unknown skill '${id}'`);
      skill.enabled = a.enabled as boolean;
      return skillsState.find((s) => s.id === id)!.enabled;
    },
  };

  return { handlers };
};
