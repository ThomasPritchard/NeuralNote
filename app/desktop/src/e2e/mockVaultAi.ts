// The AI-provider / local-model / skills backend: a self-contained slice of the
// mock command surface with its own state (key config, provider selection,
// installed models, skill toggles). Wired into the dispatch table in
// `mockVault.ts`. Mirrors commands/ai.rs.

import type {
  AiStatus,
  ApprovalMode,
  ApiKeyStatus,
  InstalledModel,
  OpenRouterModelMenu,
  ProviderKind,
  PullEvent,
  ReasoningControl,
  SkillListing,
} from "../lib/types";
import {
  DEFAULT_CHAT_MODEL,
  fail,
  type ApiKeySaveAttempt,
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
import type { MockScheduler } from "./mockScheduler";
import type { MockScheduledTask } from "./mockScheduler";
import { ALWAYS_ASK_APPROVAL_STATUS } from "../lib/approvalStatusFixture";

type CommandHandler = (a: Record<string, unknown>) => unknown;

export interface AiBackend {
  handlers: Record<string, CommandHandler>;
  readonly apiKeySaveAttempts: readonly ApiKeySaveAttempt[];
}

export const createAiBackend = (
  opts: CreateMockVaultOptions,
  scheduler: MockScheduler,
): AiBackend => {
  // AI key state (mutated by save/clear, reported by api_key_status) + the
  // reasoning verdict. Per-test overridable via opts.
  const keyState = {
    hasKey: opts.apiKey?.hasKey ?? true,
    model: opts.apiKey?.model ?? DEFAULT_CHAT_MODEL,
    // Mirrors `ProviderConfig.reasoning`, whose serde default is false: reasoning
    // tokens are billed, so they are opt-in. Mutated by set_reasoning.
    reasoning: opts.apiKey?.reasoning ?? false,
    // Mirrors `ProviderConfig.reasoning_preference.effort`: only ever a value the
    // model's own menu offered, and cleared whenever the model changes.
    reasoningEffort: opts.apiKey?.reasoningEffort ?? null,
    // Mirrors the shell's `cached_openrouter_reasoning_control`: what the
    // catalogue published for this model, or `undefined` for "it has not
    // answered", which is what makes the control `pending`.
    catalogueControl: opts.apiKey?.catalogueControl,
    // Mirrors `ProviderConfig.cached_reasoning_support()`, which is "unknown"
    // until a model is probed — and "unknown" keeps the toggle enabled, so an
    // unprobed fixture fails open exactly as the real config does.
    reasoningSupported: opts.apiKey?.reasoningSupported ?? "unknown",
  };
  // The verdict the mount-time probe persists when it runs (see the option doc).
  const probedSupport = opts.apiKey?.probedSupport;
  const apiKeySaveAttempts: ApiKeySaveAttempt[] = [];

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
  /** Mirror of the shell's `reasoning_control_for`. The verdict leads: an
   *  unanswered probe is `pending` (never a guessed menu), a model known not to
   *  reason is `hidden`, the local lane is a plain switch because Ollama
   *  publishes no menu, and a capable hosted model gets whatever the catalogue
   *  published — with a listed-but-silent one falling back to a switch, since it
   *  reasons and simply named no efforts. */
  const reasoningControlFor = (): ReasoningControl => {
    const provider = effectiveProvider();
    if (provider === null) return { kind: "hidden" };
    if (keyState.reasoningSupported === "unsupported") return { kind: "hidden" };
    if (keyState.reasoningSupported === "unknown") return { kind: "pending" };
    if (provider === "local") return { kind: "toggle", defaultOn: false };
    const published = keyState.catalogueControl;
    if (published === undefined) return { kind: "pending" };
    return published.kind === "hidden"
      ? { kind: "toggle", defaultOn: false }
      : published;
  };

  const buildAiStatus = (): AiStatus => ({
    activeProvider: effectiveProvider(),
    reasoningSupported: keyState.reasoningSupported,
    reasoningControl: reasoningControlFor(),
    openrouter: {
      hasKey: keyState.hasKey,
      model: keyState.model,
      reasoning: keyState.reasoning,
      reasoningEffort: keyState.reasoningEffort,
    },
    local: { activeModelTag: aiState.localActiveTag },
    approval: buildApprovalStatus(),
  });

  // Mirror of the Rust `ApprovalStatus`: the stored mode and overrides, plus the
  // EFFECTIVE mode per tool, which the shell computes by clamping each stored (or
  // compiled-in) preference against the global ceiling. Mirrored here rather than
  // echoed back so a journey can prove the clamp survives the IPC round trip —
  // the UI must never derive a security value for itself.
  const approvalState = {
    mode: ALWAYS_ASK_APPROVAL_STATUS.mode,
    overrides: { ...ALWAYS_ASK_APPROVAL_STATUS.toolOverrides } as Record<
      string,
      ApprovalMode
    >,
  };
  const RESTRICTIVENESS: readonly ApprovalMode[] = ["alwaysAsk", "approveForMe", "yolo"];
  /** `min` in the Rust ordering: the more restrictive of the two wins. */
  const moreRestrictive = (a: ApprovalMode, b: ApprovalMode): ApprovalMode =>
    RESTRICTIVENESS.indexOf(a) <= RESTRICTIVENESS.indexOf(b) ? a : b;
  const buildApprovalStatus = (): AiStatus["approval"] => ({
    mode: approvalState.mode,
    toolOverrides: { ...approvalState.overrides },
    effectiveModes: Object.fromEntries(
      Object.keys(ALWAYS_ASK_APPROVAL_STATUS.effectiveModes).map((tool) => [
        tool,
        moreRestrictive(
          approvalState.mode,
          // The compiled-in default: always-ask for the tool that spawns a host
          // process, unconstrained for the rest.
          approvalState.overrides[tool] ??
            (tool === "transcribe_audio" ? "alwaysAsk" : "yolo"),
        ),
      ]),
    ),
    // The mock has no cloud judge, matching a local-lane run.
    classifierAvailable: false,
    irreversibleActions: [...ALWAYS_ASK_APPROVAL_STATUS.irreversibleActions],
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
  let pendingPullTasks: MockScheduledTask[] = [];
  let finishPendingPull: (() => void) | null = null;

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
    set_reasoning_effort: (a) => {
      // Mirror of the real command: clearing is always allowed and leaves the
      // opt-in alone, while naming an effort is REFUSED unless the currently
      // published menu offers it — the shell never coerces a value the user did
      // not pick — and naming one opts them in.
      const effort = a.effort as string | null;
      if (effort === null) {
        keyState.reasoningEffort = null;
        return buildAiStatus();
      }
      const control = reasoningControlFor();
      if (control.kind !== "efforts" || !control.options.includes(effort)) {
        throw { kind: "invalidContent", message: effort };
      }
      keyState.reasoning = true;
      keyState.reasoningEffort = effort;
      return buildAiStatus();
    },
    set_approval_mode: (a) => {
      approvalState.mode = a.mode as ApprovalMode;
      return buildAiStatus();
    },
    set_tool_approval_override: (a) => {
      const tool = a.tool as string;
      if (!(tool in ALWAYS_ASK_APPROVAL_STATUS.effectiveModes)) {
        // The real command refuses a tool this build does not gate rather than
        // storing an entry the next read would drop.
        throw { kind: "invalidName", message: tool };
      }
      const mode = a.mode as ApprovalMode | null;
      if (mode === null) {
        delete approvalState.overrides[tool];
      } else {
        approvalState.overrides[tool] = mode;
      }
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
    cancel_pull: () => {
      pendingPullTasks.forEach((task) => scheduler.cancel(task));
      pendingPullTasks = [];
      finishPendingPull?.();
      finishPendingPull = null;
      return undefined;
    },
    pull_local_model: (a) => {
      const tag = a.tag as string;
      const script = opts.pullScript ?? DEFAULT_PULL_SCRIPT;
      pendingPullTasks.forEach((task) => scheduler.cancel(task));
      finishPendingPull?.();
      return new Promise<void>((resolve) => {
        finishPendingPull = resolve;
        pendingPullTasks = emitToChannel(a.onEvent, script, scheduler, (message) => {
          const event = message as PullEvent;
          if (event.type === "success" && !aiState.installed.some((m) => m.tag === tag)) {
            aiState.installed.push({
              tag,
              sizeBytes: 4_700_000_000,
              family: null,
              parameterSize: null,
              quantization: null,
            });
          }
          if (event.type === "success" || event.type === "error") {
            pendingPullTasks = [];
            finishPendingPull?.();
            finishPendingPull = null;
          }
        });
      });
    },
    save_api_key: (a) => {
      // The key itself never crosses back; only presence + model are reported.
      const model = (a.model as string) || keyState.model;
      apiKeySaveAttempts.push({
        keyMatchesExpected:
          typeof a.key === "string" && a.key === opts.expectedApiKey,
        model,
      });
      keyState.hasKey = true;
      keyState.model = model;
      // Shaped like the real command, which returns `KeyChangeOutcome` rather
      // than nothing (`commands/ai.rs:55`, `:117`). A mock answering `undefined`
      // agreed both with a frontend that read the outcome and with one that
      // discarded it, so the journey tier stayed green through the whole period
      // `api.ts` typed these as `invoke<void>` and dropped a failed revocation
      // notice on the floor.
      return { revisionPublished: opts.keyRevisionPublished ?? true };
    },
    clear_api_key: () => {
      keyState.hasKey = false;
      return { revisionPublished: opts.keyRevisionPublished ?? true };
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

  return { handlers, apiKeySaveAttempts };
};
