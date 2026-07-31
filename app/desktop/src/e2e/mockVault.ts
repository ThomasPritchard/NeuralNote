// A stateful, in-memory stand-in for the Rust vault backend, driven through the
// real Tauri IPC boundary via `@tauri-apps/api/mocks`'s `mockIPC`. The whole
// point: render the REAL <App/> and let the genuine `src/lib/api.ts`,
// `src/lib/store.tsx`, and component tree run end-to-end, with this model
// mutating exactly as the real filesystem-backed core would across a multi-step
// journey (create → tree updates → open → edit → save → rename → move → delete).
//
// Every command name, argument shape (camelCase, as the JS side sends it), and
// return shape is mirrored 1:1 from the real seam:
//   - command names + arg keys ............ src/lib/api.ts / src-tauri/src/lib.rs
//   - TreeNode / NoteDoc / Vault shapes ... src/lib/types.ts (camelCase serde)
//   - create_note appends `.md`, rename keeps a markdown ext, folders-first sort,
//     title = frontmatter.title → first H1 → file stem ... crates/neuralnote-core
//   - search_vault (code-point offsets, snippet windows, caps) + read_link_graph
//     (wikilink/md-link resolution) ... specs/search-and-graph-view.md §Contract
//
// Events (`vault://tree-changed`, the window `tauri://close-requested`) and the
// window `destroy` are wired too: `mockIPC(..., { shouldMockEvents: true })`
// makes the built-in listener registry handle `plugin:event|*`, so `emit(...)`
// dispatches to the app's real subscriptions; `plugin:window|destroy` is the
// only window command the app issues and is recorded here.
//
// The command surface is split across cohesive sibling modules: pure note/path
// infrastructure (mockVaultNotes), Rust-generated analytical command replays,
// and two self-contained
// stateful sub-backends — AI/provider/skills (mockVaultAi) and chat/skill-run
// (mockVaultChatRuntime) — wired into the one dispatch table below.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type {
  NoteDoc,
  TreeNode,
  Vault,
  WorkspaceState,
  WorkspaceStateLoad,
} from "../lib/types";
import {
  fail,
  NEW_VAULT_PARENT,
  VAULT_ROOT,
} from "./mockVaultTypes";
import type {
  CoreErrorLike,
  CreateMockVaultOptions,
  Entry,
  MockVault,
} from "./mockVaultTypes";
import {
  basename,
  ensureMd,
  extOf,
  hashContent,
  isMarkdownExt,
  MAX_EDITABLE_NOTE_BYTES,
  normalizeAbsPath,
  parentOf,
  parseFrontmatter,
  stemOf,
  titleFrom,
} from "./mockVaultNotes";
import { createAiBackend } from "./mockVaultAi";
import { createChatRuntime } from "./mockVaultChatRuntime";
import {
  createMockIpcReplay,
  MOCK_IPC_CONTRACT_V1,
  validateMockCoreErrorV1,
} from "./mockIpcContract";
import { MockScheduler } from "./mockScheduler";

export {
  DEFAULT_CHAT_MODEL,
  NEW_VAULT_PARENT,
  VAULT_ROOT,
} from "./mockVaultTypes";
export type {
  ChatCallRecord,
  CoreErrorLike,
  CreateMockVaultOptions,
  MockVault,
  SeedEntry,
} from "./mockVaultTypes";

/** Mirror of core `tree.rs` DIR_LISTING_CAP (issue #40): the per-directory
 *  breadth cap for the DISPLAY `list_dir` path only. A folder with more than this
 *  many entries returns the first CAP plus a truncation count. */
const DIR_LISTING_CAP = 5_000;

export function createMockVault(opts: CreateMockVaultOptions = {}): MockVault {
  let root = VAULT_ROOT;
  const entries = new Map<string, Entry>();
  const recents = opts.recents ?? [];
  const pickFolder = opts.pickFolder === undefined ? VAULT_ROOT : opts.pickFolder;
  const pickNewLocation =
    opts.pickNewLocation === undefined ? NEW_VAULT_PARENT : opts.pickNewLocation;
  const failures = new Map<string, CoreErrorLike>();
  const calls: string[] = [];
  let destroyed = false;
  let workspaceState: WorkspaceState = opts.workspaceState ?? {
    openPaths: [],
    activePath: null,
  };
  const openedYoutubeUrls: string[] = [];
  const scheduler = opts.scheduler ?? new MockScheduler();

  // The two self-contained stateful sub-backends. Each owns its slice of state
  // and returns a command→handler map that the dispatch table below merges.
  const aiBackend = createAiBackend(opts, scheduler);
  const chatRuntime = createChatRuntime(opts, scheduler);
  const delegatedHandlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    ...aiBackend.handlers,
    ...chatRuntime.handlers,
  };

  const relOf = (p: string): string => p.slice(root.length + 1);

  const ensureAncestors = (absPath: string): void => {
    let parent = parentOf(absPath);
    while (parent.length > root.length) {
      if (!entries.has(parent)) entries.set(parent, { kind: "folder" });
      parent = parentOf(parent);
    }
  };

  for (const s of opts.seed ?? []) {
    const abs = `${root}/${s.relPath}`;
    ensureAncestors(abs);
    entries.set(
      abs,
      s.kind === "folder"
        ? { kind: "folder" }
        : { kind: "file", content: s.content ?? "", unreadable: s.unreadable },
    );
  }

  const resolveVaultPath = (path: string): string => {
    const abs = normalizeAbsPath(path.startsWith("/") ? path : `${root}/${path}`);
    if (abs !== root && !abs.startsWith(`${root}/`)) {
      fail("outsideVault", path);
    }
    return abs;
  };

  // ── TreeNode serialisation (folders-first, then case-insensitive by name) ──
  const toNode = (path: string): TreeNode => {
    const entry = entries.get(path);
    if (entry?.kind === "folder") {
      return {
        kind: "folder",
        name: basename(path),
        path,
        relPath: relOf(path),
        ext: null,
        children: childrenOf(path),
      };
    }
    return {
      kind: "file",
      name: basename(path),
      path,
      relPath: relOf(path),
      ext: extOf(path),
      children: null,
    };
  };

  const childrenOf = (parent: string): TreeNode[] => {
    const nodes = [...entries.keys()]
      .filter((p) => parentOf(p) === parent)
      .map(toNode);
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      // Mirror of core tree.rs: `name.to_lowercase().cmp(...)` — plain
      // code-unit order on the lowercased names, NOT locale collation
      // (localeCompare ranks punctuation differently, e.g. "b-dir" vs "banana").
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (an < bn) return -1;
      return an > bn ? 1 : 0;
    });
    return nodes;
  };

  /** Mirror of core `list_dir` (issue #40): one directory's immediate children,
   *  non-recursively — folders come back with `children: null` (unloaded), same
   *  folders-first case-insensitive sort as `childrenOf`. */
  const shallowChildrenOf = (parent: string): TreeNode[] =>
    childrenOf(parent).map((node) =>
      node.kind === "folder" ? { ...node, children: null } : node,
    );

  const buildDoc = (path: string, raw: string): NoteDoc => {
    const parsed = parseFrontmatter(raw);
    return {
      path,
      relPath: relOf(path),
      title: titleFrom(parsed.frontmatter, parsed.body, stemOf(path)),
      frontmatter: parsed.frontmatter,
      frontmatterRaw: parsed.frontmatterRaw,
      frontmatterError: parsed.frontmatterError,
      body: parsed.body,
      raw,
      contentHash: hashContent(raw),
      binary: false,
      lossyText: false,
      exceedsEditableSize: false,
      sizeBytes: 0,
    };
  };

  /** Mirror of core `note.rs` build_oversized_doc (issue #82): past the
   *  editable byte limit the read returns a flagged doc with NO content —
   *  the editor would freeze mounting it. Nothing is written; the file's
   *  bytes stay exactly as seeded. */
  const buildOversizedDoc = (path: string, sizeBytes: number): NoteDoc => ({
    path,
    relPath: relOf(path),
    title: stemOf(path),
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body: "",
    raw: "",
    contentHash: "",
    binary: false,
    lossyText: false,
    exceedsEditableSize: true,
    sizeBytes,
  });

  /** Re-key `from` (and, for a folder, every descendant) to `to`, content intact. */
  const rekey = (from: string, to: string): void => {
    // eslint-disable-next-line unicorn/no-useless-spread -- snapshot keys before the loop mutates `entries`, avoiding mutate-during-iteration.
    for (const key of [...entries.keys()]) {
      if (key === from) {
        entries.set(to, entries.get(key)!);
        entries.delete(key);
      } else if (key.startsWith(`${from}/`)) {
        entries.set(`${to}${key.slice(from.length)}`, entries.get(key)!);
        entries.delete(key);
      }
    }
  };

  const requireFile = (path: string): Entry & { kind: "file" } => {
    const e = entries.get(path);
    if (!e) return fail("notFound", `${path} not found`);
    if (e.kind !== "file") {
      return fail("notFound", `${path} not found`);
    }
    if (e.unreadable) fail("io", `${path} unreadable`);
    return e;
  };

  const createNoteNode = (parentPath: string, name: string): TreeNode => {
    const fileName = ensureMd(name.trim());
    const target = `${parentPath}/${fileName}`;
    if (entries.has(target)) fail("alreadyExists", `${fileName} already exists`);
    entries.set(target, { kind: "file", content: "" });
    return toNode(target);
  };

  const contract = MOCK_IPC_CONTRACT_V1;
  const replay = opts.mockIpcScenario
    ? createMockIpcReplay(contract, opts.mockIpcScenario, (mutation) => {
        const write = (mutation as { write?: { relPath?: unknown; content?: unknown } } | null)?.write;
        const relPath = write?.relPath;
        const content = write?.content;
        if (typeof relPath !== "string" || typeof content !== "string") {
          return fail("io", "MockIpcContractV1 supplied an invalid filesystem mutation");
        }
        const path = resolveVaultPath(relPath);
        ensureAncestors(path);
        entries.set(path, { kind: "file", content });
      })
    : null;

  // ── The IPC handler: one stateful backend for the whole journey ───────────
  const handler = (cmd: string, payload?: InvokeArgs): unknown => {
    calls.push(cmd);

    if (cmd === "plugin:window|destroy") {
      destroyed = true;
      return null;
    }

    const a = (payload ?? {}) as Record<string, unknown>;

    // A selected Rust scenario owns every command named anywhere in its
    // exchange sequence, including already-consumed and not-yet-reached ones.
    // Validate those invocations before any fallible override or semantic
    // handler. An explicit scripted failure may replace the exact next
    // exchange without consuming it, allowing a later retry to replay Rust.
    // Bootstrap and other commands not owned by the scenario continue below.
    if (replay?.ownsCommand(cmd)) {
      replay.assertNextInvocation(cmd, a);
      const failure = failures.get(cmd);
      if (failure) throw failure;
      return replay.invoke(cmd, a);
    }

    const failure = failures.get(cmd);
    if (failure) throw failure;

    // The AI/provider and chat/skill-run commands live in their own backends;
    // they see the same pre-dispatch `calls`/`setFailure` treatment as the
    // cases below, then run against their own encapsulated state.
    const delegated = delegatedHandlers[cmd];
    if (delegated) return delegated(a);

    switch (cmd) {
      case "list_recent_vaults":
        return recents;
      case "pick_vault_folder":
        return pickFolder;
      case "pick_new_vault_location":
        return pickNewLocation;
      case "open_vault": {
        root = a.path as string;
        return { name: basename(root), path: root } satisfies Vault;
      }
      case "create_vault": {
        root = `${a.parentDir as string}/${a.name as string}`;
        return { name: a.name as string, path: root } satisfies Vault;
      }
      case "close_vault":
        return undefined;
      case "load_workspace_state":
        return {
          state: {
            openPaths: [...workspaceState.openPaths],
            activePath: workspaceState.activePath,
          },
          recoveredFromCorrupt: false,
          recoveryMessage: null,
        } satisfies WorkspaceStateLoad;
      case "save_workspace_state": {
        const next = a.state as WorkspaceState;
        workspaceState = {
          openPaths: [...next.openPaths],
          activePath: next.activePath,
        };
        return undefined;
      }
      case "reset_workspace_state":
        workspaceState = { openPaths: [], activePath: null };
        return {
          state: { openPaths: [], activePath: null },
          recoveredFromCorrupt: false,
          recoveryMessage: null,
        } satisfies WorkspaceStateLoad;
      case "set_menu_editing":
      case "set_chat_visible":
        return undefined;
      case "read_tree":
        return childrenOf(root);
      case "list_dir": {
        // The lazy DISPLAY path (issue #40): one directory's immediate children,
        // capped, with a truncation count — never a recursive walk. `path` is the
        // vault-relative folder ("" = root).
        const target = resolveVaultPath((a.path as string) ?? "");
        const all = shallowChildrenOf(target);
        return {
          entries: all.slice(0, DIR_LISTING_CAP),
          truncated: all.length > DIR_LISTING_CAP ? all.length - DIR_LISTING_CAP : null,
        };
      }
      case "read_note": {
        const path = a.path as string;
        const file = requireFile(path);
        // Mirror of the core read-side cap (issue #82): over the editable
        // limit, the flagged size-limit doc goes out instead of the content.
        const sizeBytes = new TextEncoder().encode(file.content).length;
        if (sizeBytes > MAX_EDITABLE_NOTE_BYTES) {
          return buildOversizedDoc(path, sizeBytes);
        }
        return buildDoc(path, file.content);
      }
      case "write_note": {
        const path = a.path as string;
        const content = a.content as string;
        const expected = (a.expectedHash ?? null) as string | null;
        // Mirror of the core write-side cap (note.rs write_note): past the
        // editable byte limit the write is refused BEFORE any mutation, with
        // the same CoreError kind — so a journey can't pass here while the
        // production backend would reject the same write.
        const contentBytes = new TextEncoder().encode(content).length;
        if (contentBytes > MAX_EDITABLE_NOTE_BYTES) {
          fail(
            "invalidContent",
            `note is ${contentBytes} bytes; editable notes are limited to ${MAX_EDITABLE_NOTE_BYTES} bytes`,
          );
        }
        const file = requireFile(path);
        if (expected !== null && hashContent(file.content) !== expected) {
          fail("conflict", "this note changed on disk since you opened it");
        }
        file.content = content;
        return buildDoc(path, content);
      }
      case "create_folder": {
        const target = `${a.parentPath as string}/${(a.name as string).trim()}`;
        if (entries.has(target)) fail("alreadyExists", `${basename(target)} already exists`);
        entries.set(target, { kind: "folder" });
        return toNode(target);
      }
      case "create_note": {
        return createNoteNode(a.parentPath as string, a.name as string);
      }
      case "rename_entry": {
        const path = a.path as string;
        const entry = entries.get(path);
        if (!entry) fail("notFound", `${path} not found`);
        const hadMd = entry!.kind === "file" && isMarkdownExt(extOf(path));
        const finalName = hadMd ? ensureMd((a.newName as string).trim()) : (a.newName as string).trim();
        const target = `${parentOf(path)}/${finalName}`;
        if (target !== path && entries.has(target)) fail("alreadyExists", `${finalName} already exists`);
        rekey(path, target);
        return toNode(target);
      }
      case "delete_entry": {
        const path = a.path as string;
        if (!entries.has(path)) fail("notFound", `${path} not found`);
        // eslint-disable-next-line unicorn/no-useless-spread -- snapshot keys before the loop mutates `entries`, avoiding mutate-during-iteration.
        for (const key of [...entries.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) entries.delete(key);
        }
        return undefined;
      }
      case "search_vault":
        return { hits: [], truncated: false, skippedFiles: 0 };
      case "read_link_graph":
        return { nodes: [], links: [], skippedFiles: 0 };
      case "read_backlinks":
        return { linked: [], unlinked: [], skippedFiles: 0 };
      case "list_templates":
        return [];
      case "create_note_from_template":
        return fail("io", "create_note_from_template requires a MockIpcContractV1 scenario");
      case "open_youtube_timestamp": {
        const value = a.url as string;
        const parsed = new URL(value);
        if (
          parsed.protocol !== "https:" ||
          parsed.hostname !== "youtu.be" ||
          !/^\/[A-Za-z0-9_-]{11}$/.test(parsed.pathname) ||
          !/^\d+$/.test(parsed.searchParams.get("t") ?? "")
        ) {
          return fail("invalidName", "YouTube timestamp URL is invalid");
        }
        openedYoutubeUrls.push(value);
        return undefined;
      }
      case "move_entry": {
        const path = a.path as string;
        const newParent = a.newParentPath as string;
        if (!entries.has(path)) fail("notFound", `${path} not found`);
        if (newParent === path || newParent.startsWith(`${path}/`)) {
          fail("invalidName", "cannot move a folder into itself");
        }
        const target = `${newParent}/${basename(path)}`;
        if (entries.has(target)) fail("alreadyExists", `${basename(path)} already exists`);
        rekey(path, target);
        return toNode(target);
      }
      default:
        // Failures are never silent: an unmocked command must reject loudly,
        // not resolve undefined (which reads as silent empty success).
        // `plugin:event|*` never lands here — mockIPC({ shouldMockEvents })
        // intercepts those before this handler.
        return fail("io", `unknown command: ${cmd}`);
    }
  };

  return {
    install() {
      mockWindows("main");
      mockIPC(handler, { shouldMockEvents: true });
    },
    setFailure(cmd, error) {
      failures.set(
        cmd,
        validateMockCoreErrorV1(contract, error, `scripted failure for '${cmd}'`),
      );
    },
    clearFailure(cmd) {
      failures.delete(cmd);
    },
    applyExternalEdit(relPath, content) {
      requireFile(resolveVaultPath(relPath)).content = content;
    },
    applyExternalDelete(relPath) {
      const abs = resolveVaultPath(relPath);
      if (!entries.has(abs)) fail("notFound", `${abs} not found`);
      // eslint-disable-next-line unicorn/no-useless-spread -- snapshot keys before the loop mutates `entries`, avoiding mutate-during-iteration.
      for (const key of [...entries.keys()]) {
        if (key === abs || key.startsWith(`${abs}/`)) entries.delete(key);
      }
    },
    expireElicitation() {
      chatRuntime.expireElicitation();
    },
    wasDestroyed() {
      return destroyed;
    },
    calls,
    chatCalls: chatRuntime.chatCalls,
    apiKeySaveAttempts: aiBackend.apiKeySaveAttempts,
    get profileFolder() {
      return chatRuntime.profileFolder;
    },
    openedYoutubeUrls,
    remainingContractExchanges() {
      return replay?.remaining() ?? 0;
    },
    assertContractConsumed() {
      const remaining = replay?.remaining() ?? 0;
      if (remaining > 0) {
        throw new Error(
          `MockIpcContractV1 scenario '${opts.mockIpcScenario}' left ${remaining} exchange(s) unconsumed; next expected command is '${replay?.nextCommand()}'`,
        );
      }
    },
    scheduler,
  };
}
