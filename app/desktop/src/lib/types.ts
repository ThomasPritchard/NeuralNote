// The Rust→TypeScript type contract. This is a thin FAÇADE: the mirrored types are
// generated from the Rust source by the `ts-rs` crate during `cargo test` and live
// in `./bindings/` — this file just re-exports them under the import path the rest
// of the app already uses (`./types`), so no call site had to change.
//
// DO NOT hand-edit the mirrored types here; edit the Rust type and re-run the
// generator (see `scripts/rust-quality-gate.sh` / `npm run gen:bindings`). The
// drift check fails the build if `bindings/` is stale. Only the TS-only types at
// the bottom — which have no Rust counterpart — are hand-written here.

// ── Generated: vault domain (crates/neuralnote-core/src/model.rs) ─────────────
export type { Vault } from "./bindings/Vault";
export type { EntryKind } from "./bindings/EntryKind";
export type { TreeNode } from "./bindings/TreeNode";
export type { NoteDoc } from "./bindings/NoteDoc";
export type { RecentVault } from "./bindings/RecentVault";
export type { TemplateInfo } from "./bindings/TemplateInfo";
export type { SearchMatch } from "./bindings/SearchMatch";
export type { FileHit } from "./bindings/FileHit";
export type { SearchResponse } from "./bindings/SearchResponse";
export type { GraphNode } from "./bindings/GraphNode";
export type { GraphLink } from "./bindings/GraphLink";
export type { LinkGraph } from "./bindings/LinkGraph";
export type { Backlink } from "./bindings/Backlink";
export type { UnlinkedMention } from "./bindings/UnlinkedMention";
export type { Backlinks } from "./bindings/Backlinks";
export type { RichEditBlock } from "./bindings/RichEditBlock";
export type { RichEditDisposition } from "./bindings/RichEditDisposition";
export type { RichEditDocument } from "./bindings/RichEditDocument";
export type { RichEditFallback } from "./bindings/RichEditFallback";
export type { RichEditFallbackCode } from "./bindings/RichEditFallbackCode";
export type { RichEditPatch } from "./bindings/RichEditPatch";

// ── Generated: global preferences + vault template settings ────────────────
export type { AppPreferences } from "./bindings/AppPreferences";
export type { AppPreferencesLoad } from "./bindings/AppPreferencesLoad";
export type { ThemeId } from "./bindings/ThemeId";
export type { FontScale } from "./bindings/FontScale";
export type { FontFamily } from "./bindings/FontFamily";
export type { TemplateSettings } from "./bindings/TemplateSettings";
export type { TemplateSettingsStatus } from "./bindings/TemplateSettingsStatus";
export type { TemplateSettingsSource } from "./bindings/TemplateSettingsSource";
export type { WorkspaceState } from "./bindings/WorkspaceState";
export type { WorkspaceStateLoad } from "./bindings/WorkspaceStateLoad";

// ── Generated: error contract (crates/neuralnote-core/src/error.rs) ───────────
// A discriminated union over `kind` — the exact adjacently-tagged wire shape, so
// `e.kind === "conflict"` narrows and every member carries `message`.
export type { CoreError } from "./bindings/CoreError";

// ── Generated: AI cited chat (events.rs + desktop ai.rs) ──────────────────────
export type { ApiKeyStatus } from "./bindings/ApiKeyStatus";
export type { ChatEvent } from "./bindings/ChatEvent";
export type { CancelChatRunOutcome } from "./bindings/CancelChatRunOutcome";
export type { CancelChatRunStatus } from "./bindings/CancelChatRunStatus";
export type { Elicitation } from "./bindings/Elicitation";
export type { ElicitOption } from "./bindings/ElicitOption";
export type { NoteKind } from "./bindings/NoteKind";
export type { UndoReport } from "./bindings/UndoReport";
export type { UndoFileResult } from "./bindings/UndoFileResult";
export type { UndoFileStatus } from "./bindings/UndoFileStatus";

// ── Generated: AI built-in skills (skills.rs) ───────────────────────────────
export type { Requirement } from "./bindings/Requirement";
export type { RequirementStatus } from "./bindings/RequirementStatus";
export type { SkillRequirement } from "./bindings/SkillRequirement";
export type { SkillListing } from "./bindings/SkillListing";

// ── Generated: AI provider selection (provider_config.rs + ai/local/*.rs) ─────
export type { ProviderKind } from "./bindings/ProviderKind";
export type { AiStatus } from "./bindings/AiStatus";
export type { OpenRouterStatus } from "./bindings/OpenRouterStatus";
export type { OpenRouterModelChoice } from "./bindings/OpenRouterModelChoice";
export type { OpenRouterModelMenu } from "./bindings/OpenRouterModelMenu";
export type { ReasoningSupport } from "./bindings/ReasoningSupport";
export type { LocalStatus } from "./bindings/LocalStatus";
export type { HardwareSpec } from "./bindings/HardwareSpec";
export type { CandidateModel } from "./bindings/CandidateModel";
export type { Recommendation } from "./bindings/Recommendation";
export type { HfModelMeta } from "./bindings/HfModelMeta";
export type { InstalledModel } from "./bindings/InstalledModel";
export type { PullEvent } from "./bindings/PullEvent";

// ── Hand-written: TS-only types with no Rust counterpart ──────────────────────
// These stay hand-written because there is nothing to generate them from.

/** The two conversation roles the chat composer sends. The Rust `ChatTurn.role`
 *  is a plain `String` that the core coerces server-side (anything other than
 *  `"assistant"` becomes a user turn), so there is no Rust enum to mirror — this
 *  union is a frontend-side narrowing of what we ever construct. */
export type ChatRole = "user" | "assistant";

/** One prior turn of the conversation, sent back with the next question so the
 *  model has context. System/tool turns are assembled in the Rust core. Mirrors
 *  the desktop shell's `ChatTurn` (whose `role` is a coerced `String`); the
 *  `ChatRole` narrowing above is the only field that has no direct generated
 *  counterpart, so this stays hand-written. */
export interface ChatTurn {
  role: ChatRole;
  content: string;
}
