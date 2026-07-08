// Typed wrappers around the Tauri vault commands. This is the single seam
// between the React UI and the Rust backend — components never call `invoke`
// directly, they call these. Command names + arg shapes match src-tauri/lib.rs.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ApiKeyStatus,
  Backlinks,
  ChatEvent,
  ChatTurn,
  CoreError,
  LinkGraph,
  NoteDoc,
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
  listen("vault://tree-changed", () => cb());

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
