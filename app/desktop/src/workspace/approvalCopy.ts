// The approval gate's user-facing vocabulary, in one place: what each gated tool
// is called in plain language, what each mode costs you, and how every way a
// request can settle reads.
//
// **Nothing here is composed from a tool identifier.** `resolve_distil_route`
// means nothing to anyone, so every string a user sees is written out longhand
// and the identifier only ever survives as a lookup key. The one exception is
// deliberate: a gated tool this build has no entry for still renders, with its
// raw key, in an "Other" group — because a gated action the settings page
// silently omitted would be worse than an ugly one it admitted to.
//
// Glyph, tone and line live together per state on purpose. They are read as one
// signal (the rail's whole thesis is that state reads from the glyph column
// before any text), and holding them in three parallel tables is how a state
// ends up wearing another state's colour.

import {
  Check,
  KeyRound,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Square,
  TimerOff,
  UserX,
  type LucideIcon,
} from "lucide-react";
import type {
  ApprovalDegradedReason,
  ApprovalMode,
  ApprovalReason,
  ApprovalResolution,
  ApprovalRule,
  GatedTool,
} from "../lib/types";
import type { ToolApprovalView } from "./chatMessage";

// ── The seven gated tools ────────────────────────────────────────────────────

/** What the user is actually deciding. The grouping is the point (§9.6.6):
 *  three of the seven are YouTube-pipeline internals, and a flat list of tool
 *  names would make the page read like a debug panel. */
export type ApprovalGroupId = "vault" | "grant" | "network" | "process" | "other";

export const APPROVAL_GROUPS: ReadonlyArray<{ id: ApprovalGroupId; title: string }> = [
  { id: "vault", title: "Writes to your vault" },
  { id: "grant", title: "Changes what the agent may do" },
  { id: "network", title: "Reaches the internet" },
  { id: "process", title: "Runs a program on your machine" },
  // Only ever reached by a tool this build gates but this table has not been
  // taught about — a newer config, or a table someone forgot to extend.
  { id: "other", title: "Other actions this build asks about" },
];

export interface GatedToolCopy {
  /** The persisted key: the `TOOL_*` constant `toolOverrides` /
   *  `effectiveModes` are keyed by. Never shown to the user. */
  key: string;
  tool: GatedTool;
  /** The settings row's name — a gerund, because the row is about a habit. */
  title: string;
  /** The sheet's verb phrase, completing "Allow NeuralNote to …?" */
  action: string;
  group: ApprovalGroupId;
}

const GATED_TOOLS: readonly GatedToolCopy[] = [
  {
    key: "write_note",
    tool: "writeNote",
    title: "Creating and changing notes",
    action: "create or change a note in your vault",
    group: "vault",
  },
  {
    key: "use_skill",
    tool: "useSkill",
    title: "Turning on a skill",
    action: "turn on a skill, which widens what it is allowed to do",
    group: "grant",
  },
  {
    key: "select_playlist_videos",
    tool: "selectPlaylistVideos",
    title: "Choosing videos from a playlist",
    action: "choose which videos from a playlist to work through",
    group: "grant",
  },
  {
    key: "resolve_distil_route",
    tool: "resolveDistilRoute",
    title: "Saving how it files your notes",
    action: "save how it files your notes, which steers future runs too",
    group: "grant",
  },
  {
    key: "fetch_video_info",
    tool: "fetchVideoInfo",
    title: "Looking up a video",
    action: "look up a video over the internet",
    group: "network",
  },
  {
    key: "fetch_captions",
    tool: "fetchCaptions",
    title: "Fetching captions",
    action: "fetch captions for a video over the internet",
    group: "network",
  },
  {
    key: "transcribe_audio",
    tool: "transcribeAudio",
    title: "Transcribing audio",
    action: "transcribe audio here, which runs a program on your machine",
    group: "process",
  },
];

const BY_TOOL = new Map(GATED_TOOLS.map((entry) => [entry.tool, entry]));
const BY_KEY = new Map(GATED_TOOLS.map((entry) => [entry.key, entry]));

/** The copy for one `GatedTool`, or `null` when this build does not know it. */
export function gatedToolCopy(tool: GatedTool | null): GatedToolCopy | null {
  return tool === null ? null : (BY_TOOL.get(tool) ?? null);
}

/** The copy for one persisted override key. An unknown key gets an entry that
 *  shows the raw key in the catch-all group rather than disappearing — the
 *  backend's key set is authoritative about what this build gates, and a row
 *  the UI declined to render is an action the user cannot govern. */
export function gatedToolCopyForKey(key: string): GatedToolCopy {
  return (
    BY_KEY.get(key) ?? {
      key,
      // No `GatedTool` value can be invented for an unknown key, and the sheet
      // only ever looks tools up by their wire variant, so this is unreachable
      // there. It exists so the settings row is renderable.
      tool: "writeNote",
      title: key,
      action: key,
      group: "other",
    }
  );
}

// ── The three modes ──────────────────────────────────────────────────────────

export interface ApprovalModeCopy {
  mode: ApprovalMode;
  label: string;
  /** The one-line consequence. Every mode states its cost, because YOLO being
   *  the CHEAPEST mode as well as the most permissive is exactly the fact
   *  somebody could otherwise pick it for the wrong reason (§9.5.3). */
  consequence: string;
}

export const APPROVAL_MODES: readonly ApprovalModeCopy[] = [
  {
    mode: "alwaysAsk",
    label: "Ask me every time",
    consequence: "Nothing runs until you say yes. No extra cost.",
  },
  {
    mode: "approveForMe",
    label: "Approve routine actions for me",
    consequence:
      "A model checks each action first. Anything it cannot take back still comes to you. Costs a little per check.",
  },
  {
    mode: "yolo",
    label: "YOLO — never ask",
    consequence:
      "Everything runs without asking, including things it cannot take back. No extra cost, and the fastest.",
  },
];

/** How an effective mode reads as a badge, next to the control that set it. */
export const APPROVAL_MODE_BADGE: Record<ApprovalMode, string> = {
  alwaysAsk: "Asks you",
  approveForMe: "Checked for you",
  yolo: "Never asks",
};

/** Why "Approve for me" cannot be chosen on the local lane (§9.5.2). The stored
 *  preference is NOT rewritten to match — switching back to a cloud provider
 *  restores it. */
export const CLASSIFIER_UNAVAILABLE_REASON =
  "Needs a cloud provider. Local models cannot yet judge this reliably, so NeuralNote will always ask.";

// ── The node states (§9.5.1) ─────────────────────────────────────────────────

/** Every way an approval request can settle without the call running. Four
 *  outcomes, four accounts: they are separate on the wire precisely because
 *  collapsing them once told users they had denied something they never saw. */
export type ApprovalRefusal = Exclude<ApprovalResolution, "approved">;

export interface ApprovalTone {
  icon: LucideIcon;
  tone: string;
  line: string;
  /** The pane's one attention signal. Exactly one state may carry it. */
  ping?: true;
  /** A breathing glyph — motion without alarm. */
  pulse?: true;
  /** Draw the glyph solid. Declared here rather than sniffed from the icon at
   *  render time, because an icon's identity is not a styling instruction. */
  filled?: true;
}

/** The four refusals, each attributed to the party responsible.
 *
 *  `cancelled` stays in the calm register on purpose: nobody refused anything,
 *  the run simply went away underneath the question, so a warning colour would
 *  be blaming someone for a non-event. `unavailable` is a pause being explained,
 *  never a terminal verdict — the gate emits it BEFORE falling through to the
 *  prompt, so it is always superseded by one of the other three. */
export const APPROVAL_REFUSAL: Record<ApprovalRefusal, ApprovalTone> = {
  denied: { icon: UserX, tone: "text-warning", line: "You said no. Nothing ran." },
  timedOut: {
    icon: TimerOff,
    tone: "text-warning",
    line: "Nobody answered in time. Nothing ran.",
  },
  cancelled: {
    // The pane's Stopped notice already draws a solid square for "this run
    // ended", so the glyph a user has learned there means the same thing here.
    icon: Square,
    filled: true,
    tone: "text-muted-foreground/70",
    line: "The run ended before this was answered. Nothing ran.",
  },
  unavailable: {
    icon: ShieldAlert,
    tone: "text-warning",
    line: "Automatic checking could not answer — asking you instead.",
  },
};

export const APPROVAL_CHECKING: ApprovalTone = {
  icon: Shield,
  // Deliberately neither the warning tone nor the ping. This state is not
  // asking the user for anything, and a pane that pings three times a turn for
  // something you cannot act on trains you to ignore the one ping that matters.
  tone: "text-muted-foreground",
  line: "Checking this action…",
  pulse: true,
};

export const APPROVAL_AWAITING: ApprovalTone = {
  icon: KeyRound,
  tone: "text-warning",
  line: "Waiting for your approval",
  ping: true,
};

/** The user said yes at the sheet. Distinct from `autoApproved`, which nobody
 *  was asked about — telling someone the app decided for them when they made
 *  the decision themselves is the same class of false account as the four
 *  refusals collapsing into one. */
export const APPROVAL_BY_YOU: ApprovalTone = {
  icon: Check,
  tone: "text-muted-foreground/70",
  line: "You allowed this",
};

/** Which compiled-in rule an automatic approval ran under. The rule set is
 *  closed, so the judge can only NAME a rule — it can never write this text. */
export const APPROVAL_RULE: Record<ApprovalRule, string> = {
  yolo: "YOLO",
  newNoteInVault: "new note in your vault",
  cachedAllow: "same as one you already allowed",
};

export function autoApprovedTone(rule: ApprovalRule | null): ApprovalTone {
  const suffix = rule === null ? "" : ` (${APPROVAL_RULE[rule]})`;
  return {
    icon: ShieldCheck,
    tone: "text-muted-foreground/55",
    line: `Approved automatically${suffix}`,
  };
}

/** Automatic checking gave up for the rest of the run. One node per turn, not
 *  one per call — the whole point of the degraded event is that the timeline
 *  says it once. */
export const APPROVAL_DEGRADED: Record<ApprovalDegradedReason, ApprovalTone> = {
  providerUnsupported: {
    icon: ShieldOff,
    tone: "text-warning",
    line: "Automatic checking is off for the rest of this turn — this provider cannot run it.",
  },
  judgeUnreliable: {
    icon: ShieldOff,
    tone: "text-warning",
    line: "Automatic checking is off for the rest of this turn — it failed twice.",
  },
};

export type ApprovalNodeState =
  | { kind: "checking" }
  | { kind: "awaitingYou" }
  | { kind: "autoApproved"; rule: ApprovalRule | null }
  | { kind: "approvedByYou" }
  | { kind: "refused"; refusal: ApprovalRefusal };

/** Which of the node states one folded approval is in.
 *
 *  Settlement is tested FIRST: a node that has settled has settled, and reading
 *  a stale `checking` flag ahead of it is how `checking` becomes terminal — the
 *  one thing §9.5.1 says it must never be. */
export function approvalNodeState(approval: ToolApprovalView): ApprovalNodeState {
  const { resolution } = approval;
  if (resolution !== null && resolution !== "approved") {
    return { kind: "refused", refusal: resolution };
  }
  if (resolution === "approved") {
    return approval.autoApprovedRule === null
      ? { kind: "approvedByYou" }
      : { kind: "autoApproved", rule: approval.autoApprovedRule };
  }
  if (approval.checking) return { kind: "checking" };
  return { kind: "awaitingYou" };
}

export function approvalTone(state: ApprovalNodeState): ApprovalTone {
  switch (state.kind) {
    case "checking":
      return APPROVAL_CHECKING;
    case "awaitingYou":
      return APPROVAL_AWAITING;
    case "autoApproved":
      return autoApprovedTone(state.rule);
    case "approvedByYou":
      return APPROVAL_BY_YOU;
    case "refused":
      return APPROVAL_REFUSAL[state.refusal];
  }
}

// ── The sheet ────────────────────────────────────────────────────────────────

/** Why the user is being asked. A closed enum on the wire, so this is a closed
 *  table here: the prompt's wording is compiled in on both sides and can never
 *  be model-authored. */
export const APPROVAL_REASON: Record<ApprovalReason, string> = {
  modeAlwaysAsk: "You asked to be checked with before every action.",
  irreversible: "This one cannot be undone.",
  notEligible: "This is not something NeuralNote can approve on your behalf.",
  judgeAsked: "Automatic checking passed this one to you.",
  judgeUnavailable: "Automatic checking could not answer, so this came to you.",
  providerUnsupported:
    "This provider cannot run automatic checking, so this came to you.",
  previouslyDenied: "You already said no to this once.",
};

/** How long the request stays live, in the units a person thinks in. Rendered
 *  once and never ticked: a counting-down security prompt manufactures urgency,
 *  and Rust is the expiry authority regardless of what the sheet says. */
export function expiryLine(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  if (seconds < 90) {
    return `This expires in ${seconds} seconds if you do not answer.`;
  }
  const minutes = Math.round(seconds / 60);
  return `This expires in ${minutes} minute${minutes === 1 ? "" : "s"} if you do not answer.`;
}

// ── The YOLO entry confirmation (§9.6.5) ─────────────────────────────────────

/** Join a generated list the way a person writes one. Serial comma from three
 *  items up; two items take a bare "and".
 *
 *  This is the ONLY hand-written part of the YOLO warning's irreversible
 *  sentence — the items themselves come from
 *  `aiStatus.approval.irreversibleActions`, which Rust generates from the same
 *  reversibility table the gate consults. Classify a new tool as irreversible
 *  and this sentence changes on its own; the golden test on the assembled
 *  paragraph is what makes that change impossible to ship unnoticed. */
export function listSentence(items: readonly string[]): string | null {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export const YOLO_CONFIRM = {
  title: "Turn on YOLO mode?",
  intro:
    "NeuralNote will stop asking before it acts. It will create and change notes in your vault and run skills without checking with you first.",
  /** The lead-in to the generated list. Split from the list so the list can be
   *  bolded — it is the sentence that has to survive a skim. */
  irreversibleLead: "That includes things it cannot take back:",
  reassurance:
    "You will still see everything it did in the chat, and you can still undo any note it writes.",
  reversible: "You can turn this off at any time in Settings.",
  confirm: "Turn on YOLO mode",
  cancel: "Cancel",
} as const;
