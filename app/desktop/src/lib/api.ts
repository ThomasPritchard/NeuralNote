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
  ApiKeyStatus,
  Backlinks,
  CandidateModel,
  ChatEvent,
  ChatTurn,
  CoreError,
  HardwareSpec,
  HfModelMeta,
  InstalledModel,
  LinkGraph,
  NoteDoc,
  ProviderKind,
  PullEvent,
  Recommendation,
  RecentVault,
  SearchResponse,
  TemplateInfo,
  TreeNode,
  Vault,
} from "./types";

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

/**
 * Tell the native menu whether a note is open in edit mode, so it can enable the
 * Format items only when they'd actually do something (the Editor that handles
 * them is mounted only in edit mode). Best-effort — the enabled state is cosmetic.
 */
export const setMenuEditing = (editing: boolean) =>
  invoke<void>("set_menu_editing", { editing });

/**
 * Tell the native menu whether the cited-recall chat panel is shown, so it can
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

/** Every action the native menu can emit. Kept in lockstep with the Rust menu's
 *  item ids (src-tauri/src/menu.rs `CUSTOM_ACTIONS`) except `open-recent`, which
 *  is in this union but deliberately not that list: Rust synthesizes it from the
 *  `open-recent:` prefix in `parse_menu_id`. Reconciling the lists naively is a
 *  trap — adding `open-recent` to `CUSTOM_ACTIONS` is inert, and deleting it here
 *  breaks Open Recent. Predefined items (undo/copy/quit…) are handled natively by
 *  the OS and never reach here. */
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
  | "close-vault"
  | "save"
  | "search"
  | "view-files"
  | "view-search"
  | "toggle-graph"
  | "toggle-mode"
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
export const saveApiKey = (key: string, model: string) =>
  invoke<void>("save_api_key", { key, model });

/** Remove the stored API key. */
export const clearApiKey = () => invoke<void>("clear_api_key");

/** Run one cited-chat turn. `onEvent` fires for each streamed `ChatEvent`
 *  (searching / reading / verifying / answer / citation / coverage) as it
 *  happens; the returned promise resolves when the run ends (after its `done` or
 *  `error` event). The API key stays Rust-side — only the prompt + prior turns
 *  cross the boundary. */
export const chat = (
  prompt: string,
  history: ChatTurn[],
  onEvent: (event: ChatEvent) => void,
): Promise<void> => {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("chat", { prompt, history, onEvent: channel });
};

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
) => invoke<void>("set_active_provider", { provider, localModelTag });

/** Opt into (or out of) OpenRouter's billed reasoning tokens on the answer turn.
 *  Persisted to the non-secret AI config; OpenRouter-only (the local path never
 *  requests reasoning). Returns the freshly persisted status — render that, rather
 *  than following up with `aiStatus()`: a read that failed after the write landed
 *  would show "off" while the config says "on", billing the user silently. */
export const setReasoning = (enabled: boolean) =>
  invoke<AiStatus>("set_reasoning", { enabled });

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

/** Remove an installed local model (frees its disk). Starts the sidecar if
 *  needed. */
export const deleteLocalModel = (tag: string) =>
  invoke<void>("delete_local_model", { tag });
