// Typed wrappers around the Tauri vault commands. This is the single seam
// between the React UI and the Rust backend — components never call `invoke`
// directly, they call these. Command names + arg shapes match src-tauri/lib.rs.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CoreError,
  LinkGraph,
  NoteDoc,
  RecentVault,
  SearchResponse,
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

// ── Events ───────────────────────────────────────────────────────────────────
/** Subscribe to on-disk vault changes (external edits, e.g. from Obsidian).
 *  Returns an unlisten function. */
export const onTreeChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("vault://tree-changed", () => cb());
