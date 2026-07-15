// Typed wrappers around the Tauri vault commands. This is the single seam
// between the React UI and the Rust backend — components never call `invoke`
// directly, they call these. Command names + arg shapes match src-tauri/lib.rs.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
// Event names are generated from the Rust `event_names.rs` constants (same
// `cargo test` step as the type bindings), so the string is defined in exactly one
// place and can't drift between the emit (Rust) and the listen (here).
import { MENU_ACTION, TREE_CHANGED } from "./bindings/events";
import type {
  AiStatus,
  AppPreferences,
  AppPreferencesLoad,
  ApiKeyStatus,
  Backlinks,
  CandidateModel,
  CancelChatRunOutcome,
  ChatEvent,
  ChatTurn,
  CoreError,
  HardwareSpec,
  HfModelMeta,
  InstalledModel,
  LinkGraph,
  NoteDoc,
  OpenRouterModelMenu,
  ProviderKind,
  PullEvent,
  Recommendation,
  RecentVault,
  SearchResponse,
  SkillListing,
  TemplateInfo,
  TemplateSettings,
  TemplateSettingsStatus,
  TreeNode,
  UndoReport,
  Vault,
  WorkspaceState,
  WorkspaceStateLoad,
} from "./types";

// ── Global preferences + per-vault template settings ──────────────────────
export const loadAppPreferences = () =>
  invoke<AppPreferencesLoad>("load_app_preferences");

export const saveAppPreferences = (preferences: AppPreferences) =>
  invoke<void>("save_app_preferences", { preferences });

export const loadTemplateSettings = () =>
  invoke<TemplateSettingsStatus>("load_template_settings");

export const saveTemplateSettings = (settings: TemplateSettings) =>
  invoke<TemplateSettingsStatus>("save_template_settings", { settings });

export const resetTemplateSettings = () =>
  invoke<TemplateSettingsStatus>("reset_template_settings");

export const pickTemplateFolder = () =>
  invoke<string | null>("pick_template_folder");

/** Normalise a thrown Tauri error (a serialised CoreError, or anything) to a
 *  message string the UI can show. Failures are surfaced, never swallowed. */
export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as CoreError).message);
  }
  return typeof e === "string" ? e : "Something went wrong.";
}

/** True when a thrown Tauri error is a write conflict (file changed on disk). */
export function isConflict(e: unknown): boolean {
  return (
    !!e &&
    typeof e === "object" &&
    "kind" in e &&
    (e as CoreError).kind === "conflict"
  );
}

/** True when a thrown Tauri error is a not-found — e.g. answering an
 *  elicitation whose question already timed out or whose run ended. */
export function isNotFound(e: unknown): boolean {
  return (
    !!e &&
    typeof e === "object" &&
    "kind" in e &&
    (e as CoreError).kind === "notFound"
  );
}

// ── Vault lifecycle ────────────────────────────────────────────────────────
export const listRecentVaults = () =>
  invoke<RecentVault[]>("list_recent_vaults");

export const pickVaultFolder = () => invoke<string | null>("pick_vault_folder");

export const pickNewVaultLocation = () =>
  invoke<string | null>("pick_new_vault_location");

export const openVault = (path: string) => invoke<Vault>("open_vault", { path });

export const createVault = (parentDir: string, name: string) =>
  invoke<Vault>("create_vault", { parentDir, name });

export const closeVault = () => invoke<void>("close_vault");

/** Complete a user-confirmed application quit. Native Quit requests are first
 *  intercepted by Rust and routed through the unsaved-edit guard; only that
 *  guard (or the welcome/loading shell, where no drafts exist) calls this. */
export const quitApp = () => invoke<void>("quit_app");

export const loadWorkspaceState = () =>
  invoke<WorkspaceStateLoad>("load_workspace_state");

export const saveWorkspaceState = (state: WorkspaceState) =>
  invoke<void>("save_workspace_state", { state });

export const resetWorkspaceState = () =>
  invoke<WorkspaceStateLoad>("reset_workspace_state");

/**
 * Tell the native menu whether an editable text note is open, so it can enable
 * Format items only while the source editor can handle them. Best-effort — the
 * enabled state is cosmetic.
 */
export const setMenuEditing = (editing: boolean) =>
  invoke<void>("set_menu_editing", { editing });

/**
 * Tell the native menu whether the Neural Assistant AI panel is shown, so it can
 * paint the View-menu checkmark. The webview owns this state; this call only keeps
 * the menu's checkmark in agreement. Best-effort — the checkmark is cosmetic.
 */
export const setChatVisible = (visible: boolean) =>
  invoke<void>("set_chat_visible", { visible });

// ── Tree + notes ────────────────────────────────────────────────────────────
export const readTree = () => invoke<TreeNode[]>("read_tree");

export const readNote = (path: string) => invoke<NoteDoc>("read_note", { path });

/** Save a note. Pass the NoteDoc.contentHash as `expectedHash` for optimistic
 *  concurrency (rejects with a conflict if the file changed on disk); pass null
 *  to force the overwrite. Returns the fresh NoteDoc built from the saved bytes. */
export const writeNote = (
  path: string,
  content: string,
  expectedHash: string | null = null,
) => invoke<NoteDoc>("write_note", { path, content, expectedHash });

// ── File / folder operations ─────────────────────────────────────────────────
export const createFolder = (parentPath: string, name: string) =>
  invoke<TreeNode>("create_folder", { parentPath, name });

export const createNote = (parentPath: string, name: string) =>
  invoke<TreeNode>("create_note", { parentPath, name });

export const renameEntry = (path: string, newName: string) =>
  invoke<TreeNode>("rename_entry", { path, newName });

export const deleteEntry = (path: string) =>
  invoke<void>("delete_entry", { path });

export const moveEntry = (path: string, newParentPath: string) =>
  invoke<TreeNode>("move_entry", { path, newParentPath });

// ── Search + link graph ──────────────────────────────────────────────────────
/** Full-text search across the vault's markdown notes (on-demand scan). */
export const searchVault = (query: string) =>
  invoke<SearchResponse>("search_vault", { query });

/** The wikilink/markdown-link graph over every markdown note in the vault. */
export const readLinkGraph = () => invoke<LinkGraph>("read_link_graph");

/** Directional backlinks and unlinked title mentions for one target note. */
export const readBacklinks = (path: string) =>
  invoke<Backlinks>("read_backlinks", { path });

/** Markdown templates in the inferred Obsidian-compatible template folder. */
export const listTemplates = () => invoke<TemplateInfo[]>("list_templates");

/** Create a note and optionally seed it with a rendered vault template. */
export const createNoteFromTemplate = (
  parentPath: string,
  name: string,
  template: string | null,
) =>
  invoke<TreeNode>("create_note_from_template", {
    parentPath,
    name,
    template,
  });

// ── Events ───────────────────────────────────────────────────────────────────
/** Subscribe to on-disk vault changes (external edits, e.g. from Obsidian).
 *  Returns an unlisten function. */
export const onTreeChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen(TREE_CHANGED, () => cb());

/** Every action the native shell can emit. Kept in lockstep with the Rust menu's
 *  item ids (src-tauri/src/menu.rs `CUSTOM_ACTIONS`) except `open-recent` and
 *  `quit-app`: Rust synthesizes the former from the recent-path prefix and the
 *  latter when a predefined native Quit reaches `RunEvent::ExitRequested`.
 *  Other predefined items (undo/copy/etc.) stay entirely native. */
// TODO(menu-action-bindings): parity with Rust's `CUSTOM_ACTIONS` is
// hand-maintained and unenforced while sibling event names are generated
// (`event_names.rs` -> `bindings/events.ts`, gated by `rust-quality-gate.sh`).
// Deferred until that generator can emit the action vocabulary too; a Rust-only
// action falls through `switch (e.action)`'s `default: break` as a dead, silent
// no-op menu item.
export type MenuAction =
  | "new-note"
  | "new-folder"
  | "open-vault"
  | "open-recent"
  | "close-tab"
  | "close-window"
  | "quit-app"
  | "close-vault"
  | "save"
  | "search"
  | "view-files"
  | "view-search"
  | "toggle-graph"
  | "toggle-chat"
  | "toggle-sidebar"
  | "format-bold"
  | "format-italic"
  | "format-h1"
  | "format-h2"
  | "format-h3"
  | "format-link";

export interface MenuActionEvent {
  action: MenuAction;
  /** Set only for `open-recent` — the vault path to open. */
  path?: string;
}

/** Subscribe to native-menu clicks/accelerators. One event bus for every custom
 *  menu item; the Rust side owns the ids. Returns an unlisten function. */
export const onMenu = (
  cb: (event: MenuActionEvent) => void,
): Promise<UnlistenFn> =>
  listen<MenuActionEvent>(MENU_ACTION, (e) => cb(e.payload));

// ── AI: cited chat (chat / api_key_* commands) ───────────────────────────────
/** Whether an API key is configured + the model that will be used. The key
 *  itself never crosses to the webview — only its presence is reported. */
export const apiKeyStatus = () => invoke<ApiKeyStatus>("api_key_status");

/** Store the OpenRouter API key (OS keychain, Rust-side) and the chosen model. */
let aiConfigMutationTail: Promise<void> = Promise.resolve();

function sequenceAiConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = aiConfigMutationTail.then(operation, operation);
  aiConfigMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export const saveApiKey = (key: string, model: string) =>
  sequenceAiConfigMutation(() => invoke<void>("save_api_key", { key, model }));

/** Remove the stored API key. */
export const clearApiKey = () =>
  sequenceAiConfigMutation(() => invoke<void>("clear_api_key"));

/** Run one cited-chat turn. `onEvent` fires for each streamed `ChatEvent`
 *  (searching / reading / verifying / answer / citation / coverage) as it
 *  happens; the returned promise resolves when the run ends (after its `done` or
 *  `error` event) with the run id used by Undo. The API key stays Rust-side —
 *  only the prompt, prior turns, and explicitly selected skills cross the
 *  boundary. */
export const chat = (
  turnId: string,
  prompt: string,
  history: ChatTurn[],
  onEvent: (event: ChatEvent) => void,
  activeSkills: string[] = [],
): Promise<string> => {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("chat", {
    turnId,
    prompt,
    history,
    onEvent: channel,
    activeSkills,
  });
};

/** Stop only the exact caller-owned turn. The typed outcome distinguishes a
 *  stop that won from a run that had already settled or was never current. */
export const cancelChatRun = (turnId: string) =>
  invoke<CancelChatRunOutcome>("cancel_chat_run", { turnId });

/** Resolve one live elicitation with option ids validated by the Rust shell. */
export const answerElicitation = (id: string, choices: string[]) =>
  invoke<void>("answer_elicitation", { id, choices });

/** Open a core-validated YouTube timestamp through the native shell. External
 *  navigation never bypasses the shell's URL policy from the webview. */
export const openYoutubeTimestamp = (url: string) =>
  invoke<void>("open_youtube_timestamp", { url });

/** Undo one completed skill run. Each file reports whether it was safely deleted
 *  or retained because it changed, disappeared, or could not be removed. */
export const undoSkillRun = (runId: string) =>
  invoke<UndoReport>("undo_skill_run", { runId });

// ── AI: provider selection (OpenRouter vs local Ollama) ──────────────────────

/** Provider-aware AI status: which provider is active (or null when nothing is
 *  set up yet), plus OpenRouter key/model and the chosen local model. A pure
 *  config read — it never starts the sidecar or unlocks the keychain, so it's
 *  cheap to poll on first-run and when opening Settings. */
export const aiStatus = () => invoke<AiStatus>("ai_status");

/** Choose the active provider (and, for local, the model tag to chat against).
 *  Persisted to the non-secret AI config; the OpenRouter key stays in the OS
 *  keychain, Rust-side. */
export const setActiveProvider = (
  provider: ProviderKind,
  localModelTag?: string,
) =>
  sequenceAiConfigMutation(async () => {
    await invoke<void>("set_active_provider", { provider, localModelTag });
    return aiStatus();
  });

/** Opt into (or out of) OpenRouter's billed reasoning tokens on the answer turn.
 *  Persisted to the non-secret AI config; OpenRouter-only (the local path never
 *  requests reasoning). Returns the freshly persisted status — render that, rather
 *  than following up with `aiStatus()`: a read that failed after the write landed
 *  would show "off" while the config says "on", billing the user silently. */
export const setReasoning = (enabled: boolean) =>
  sequenceAiConfigMutation(() => invoke<AiStatus>("set_reasoning", { enabled }));

/** Probe the selected model over the network or loopback for reasoning support.
 *  This is async I/O, not a cheap config read like `aiStatus()`, so never call it
 *  on every render. It deliberately does not occupy the config-mutation queue:
 *  the native persistence gate resolves write races, while callers use their
 *  status generation to ignore an obsolete response. An un-probed or failed
 *  model stays "unknown", keeping the toggle enabled (fail open); failure never
 *  reports "unsupported". */
export const refreshReasoningSupport = () =>
  invoke<AiStatus>("refresh_reasoning_support");

/** Load today's native-validated OpenRouter ranking. The shell owns provider
 *  traffic, response limits, validation, and the daily cache. */
export const openRouterModelMenu = (forceRefresh = false) =>
  invoke<OpenRouterModelMenu>("openrouter_model_menu", { forceRefresh });

/** Persist one exact model from the last native-validated menu and return the
 *  fresh provider status. */
export const selectOpenRouterModel = (model: string) =>
  sequenceAiConfigMutation(() => invoke<AiStatus>("select_openrouter_model", { model }));

/** Open the fixed OpenRouter rankings attribution page through the native
 *  external-navigation policy. The webview cannot supply a URL. */
export const openOpenRouterRankings = () =>
  invoke<void>("open_openrouter_rankings");

/** Detect host hardware (RAM/CPU/arch/OS) for the local-model recommendation and
 *  the Settings hardware readout. Infallible on the Rust side. */
export const detectHardware = () => invoke<HardwareSpec>("detect_hardware");

/** The curated, tool-calling-capable local-model catalogue — the source of truth
 *  for what may be installed. Enrich each entry with `hfModelMetadata`. */
export const localCandidates = () =>
  invoke<CandidateModel[]>("local_candidates");

/** Which curated model this machine should safely run, or an explicit
 *  "unsupported" verdict (weak specs / unsupported platform). */
export const recommendLocalModel = () =>
  invoke<Recommendation>("recommend_local_model");

/** Live Hugging Face metadata (downloads / licence / updated) for a model repo,
 *  shown for transparency. HF being unreachable is non-fatal — the promise
 *  rejects and the caller treats it as "no metadata", never a hard failure. */
export const hfModelMetadata = (hfRepo: string) =>
  invoke<HfModelMeta>("hf_model_metadata", { hfRepo });

/** Models currently installed in the app-owned Ollama store. Starts the bundled
 *  sidecar if it isn't running yet. */
export const listLocalModels = () =>
  invoke<InstalledModel[]>("list_local_models");

/** Download a local model, streaming `PullEvent`s to `onEvent` as they happen
 *  (progress → terminal success/error). The returned promise resolves when the
 *  run ends. Exactly one terminal event fires, so a failure is never silent.
 *  Starts the sidecar if needed. Cancel an in-flight pull with `cancelPull`. */
export const pullLocalModel = (
  tag: string,
  onEvent: (event: PullEvent) => void,
): Promise<void> => {
  const channel = new Channel<PullEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("pull_local_model", { tag, onEvent: channel });
};

/** Cancel the in-flight local-model download, if any. */
export const cancelPull = () => invoke<void>("cancel_pull");

/** Download one allowlisted skill requirement into the app-owned binary folder,
 *  forwarding progress and the single terminal event over a Tauri channel. */
export const downloadRequirement = (
  name: string,
  onEvent: (event: PullEvent) => void,
): Promise<void> => {
  const channel = new Channel<PullEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("download_requirement", { name, onEvent: channel });
};

/** Cancel the active skill-requirement download, if any. */
export const cancelRequirementDownload = () =>
  invoke<void>("cancel_requirement_download");

/** Remove an installed local model (frees its disk). Starts the sidecar if
 *  needed. */
export const deleteLocalModel = (tag: string) =>
  invoke<void>("delete_local_model", { tag });

/** Every built-in skill, including disabled entries, with static requirement
 *  status detected by the Rust backend. */
export const listSkills = () => invoke<SkillListing[]>("list_skills");

/** Enable or disable a built-in skill. Returns the freshly persisted enabled
 *  state, so callers render what landed on disk rather than assuming the write
 *  succeeded. */
export const setSkillEnabled = (id: string, enabled: boolean) =>
  sequenceAiConfigMutation(() => invoke<boolean>("set_skill_enabled", { id, enabled }));
