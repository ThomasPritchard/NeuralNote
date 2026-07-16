// Shared constants, public types, and the option/handle surface for the
// in-memory mock vault backend. Split out of `mockVault.ts` so the fixture data
// and command handlers can live in cohesive sibling modules; `mockVault.ts`
// re-exports everything a test imports, so the public surface is unchanged.

import type {
  CandidateModel,
  ChatEvent,
  CoreError,
  HardwareSpec,
  HfModelMeta,
  InstalledModel,
  ProviderKind,
  PullEvent,
  ReasoningSupport,
  Recommendation,
  RecentVault,
  SkillListing,
  UndoReport,
} from "../lib/types";

export const VAULT_ROOT = "/vault";
export const NEW_VAULT_PARENT = "/parent";

/** The model `api_key_status` reports when a test doesn't override it — mirrors
 *  the core's locked default (`DEFAULT_MODEL`, neuralnote-core ai/orchestrator.rs).
 *  The frontend holds no copy: it takes the id solely from the `aiStatus` echo. */
export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4.5";

/** A thrown backend error, shaped exactly as a serialised `CoreError`. */
export interface CoreErrorLike {
  kind: CoreError["kind"];
  message: string;
}

/** Throw a `CoreError`-shaped rejection (never returns). */
export const fail = (kind: CoreErrorLike["kind"], message: string): never => {
  throw { kind, message } satisfies CoreErrorLike;
};

/** A markdown note handed to the search/graph mirrors. */
export interface MdFile {
  path: string;
  rel: string;
  content: string;
  unreadable?: boolean;
}

/** An in-memory vault entry: a folder, or a file with its full raw contents. */
export type Entry =
  | { kind: "folder" }
  | { kind: "file"; content: string; unreadable?: boolean };

/** Seed nodes use vault-relative, `/`-joined paths (the UI's stable id). */
export type SeedEntry =
  | { kind: "folder"; relPath: string }
  | { kind: "file"; relPath: string; content?: string; unreadable?: boolean };

export interface CreateMockVaultOptions {
  /** Initial tree contents. Ancestor folders are auto-created. */
  seed?: SeedEntry[];
  /** Recent vaults shown on the welcome screen. */
  recents?: RecentVault[];
  /** What the "open existing" folder picker returns (null = cancelled). */
  pickFolder?: string | null;
  /** What the "new vault location" folder picker returns (null = cancelled). */
  pickNewLocation?: string | null;
  /** The AI key status `api_key_status`/`ai_status` report. Defaults to a key
   *  present so a test lands straight in the chat view; pass `{ hasKey: false }`
   *  to exercise the first-run provider picker (and, through it, guided key
   *  setup). `model` defaults to {@link DEFAULT_CHAT_MODEL};
   *  `reasoningSupported` defaults to `"unknown"` (never probed → fail open). */
  apiKey?: {
    hasKey: boolean;
    model?: string;
    reasoning?: boolean;
    reasoningSupported?: ReasoningSupport;
    /** The verdict the `refresh_reasoning_support` probe *discovers and
     *  persists* when it runs, mirroring the real command (probe → persist →
     *  return). When set, the mount-time probe overwrites `reasoningSupported`
     *  with this — so a test can seed an initial `"unknown"` (chip fails open)
     *  and prove the probe is what drives it to `"unsupported"`. Left unset,
     *  the probe is a pure echo of the seeded verdict. */
    probedSupport?: ReasoningSupport;
  };
  /** The `ChatEvent` sequence the `chat` command streams to its Channel, in
   *  order, exactly as the Rust core would (searching → … → done | error).
   *  A script containing an `elicit` event pauses THERE, exactly as the Rust
   *  run parks on `UserPrompt::ask`: the remainder streams only after a valid
   *  `answer_elicitation`, and the `chat` invoke resolves (with its run id)
   *  once the script is drained. */
  chatScript?: ChatEvent[];
  /** Pause a scripted chat after this many frames until `cancel_chat_run`.
   *  The optional tail is then streamed as the backend's honest wind-down. */
  cancelChatAfterEvents?: number;
  cancelChatTail?: ChatEvent[];
  /** Test-only mirror of the implementation-authored folder picker that writes
   *  the selected route to `.neuralnote/profile.json`. */
  profileFolderElicitationId?: string;
  /** What `undo_skill_run` reports. Defaults to every note the run wrote
   *  deleting cleanly; seed explicit per-file outcomes (kept-edited, failed…)
   *  to exercise the report card's honesty about partial undos. */
  undoReport?: UndoReport;
  /** Fixed clock for template rendering. Defaults to the Rust test fixture time. */
  now?: Date;
  // ── Local-AI provider (ai_status / detect_hardware / recommend / pull / …) ──
  /** Explicit `active_provider` for `ai_status`. Defaults to the keyState
   *  derivation (`effective_provider`: key → "openRouter", else null). */
  activeProvider?: ProviderKind | null;
  /** The local model tag `ai_status` reports as active (drives the status pill). */
  localActiveTag?: string | null;
  /** What `detect_hardware` returns. Defaults to a capable Apple-Silicon spec. */
  hardware?: HardwareSpec;
  /** What `recommend_local_model` returns. Defaults to a "supported" verdict. */
  recommendation?: Recommendation;
  /** The curated catalogue `local_candidates` returns. Defaults to two models. */
  localCandidates?: CandidateModel[];
  /** Models already installed (`list_local_models`). Defaults to none. */
  installedModels?: InstalledModel[];
  /** The `PullEvent` stream `pull_local_model` replays (progress → success|error).
   *  Defaults to a short progress→success run; a successful run also marks the
   *  model installed, exactly as Ollama would. */
  pullScript?: PullEvent[];
  /** The streamed frames for the allowlisted skill-requirement installer. */
  requirementDownloadScript?: PullEvent[];
  /** HF metadata by hfRepo for `hf_model_metadata`. A repo with no entry makes the
   *  command reject, which the UI treats as "no metadata" (non-fatal by contract). */
  hfMeta?: Record<string, HfModelMeta>;
  /** The built-in skill catalogue `list_skills` reports (and `set_skill_enabled`
   *  mutates). Defaults to the fixture skill, enabled, with no requirements —
   *  mirroring the compiled-in registry. */
  skills?: SkillListing[];
}

/** One `chat` invoke as the backend received it — lets a journey assert the
 *  picker/chips actually fed `activeSkills` across the IPC boundary. */
export interface ChatCallRecord {
  prompt: string;
  activeSkills: readonly string[];
}

export interface MockVault {
  /** Install the IPC + window mocks. Call before rendering <App/>. */
  install: () => void;
  /** Force a command to reject with the given error (until cleared). */
  setFailure: (cmd: string, error: CoreErrorLike) => void;
  clearFailure: (cmd: string) => void;
  /** End the parked run as the shell's elicitation TIMEOUT would — per spec
   *  §3.4 the timeout ends the RUN, not the QUESTION. The question is retired
   *  unanswered (a late `answer_elicitation` on its id rejects notFound,
   *  exactly like the real dead-id path) and the script's remainder — the
   *  run-end tail the test scripted, e.g. an honest wind-down answer plus
   *  `done` — streams so the pending `chat` invoke resolves with its run id.
   *  The card must then render dormant-but-clickable. Throws if no
   *  elicitation is parked (a mis-scripted test must fail loudly). */
  expireElicitation: () => void;
  /** Whether the OS window was actually destroyed (close path). */
  wasDestroyed: () => boolean;
  /** Ordered log of every command the app issued (for assertions/debugging). */
  readonly calls: readonly string[];
  /** Every `chat` invoke, with the `activeSkills` it carried. */
  readonly chatCalls: readonly ChatCallRecord[];
  /** Folder persisted by the scripted unknown-scheme picker, if answered. */
  readonly profileFolder: string | null;
  /** Native YouTube timestamp opens, after the real frontend wrapper. */
  readonly openedYoutubeUrls: readonly string[];
}
