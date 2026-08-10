// The individual nodes that hang off the chat timeline rail: the reasoning
// disclosure, one node per dispatched tool call, the verify/dropped-citation
// steps, and a skill that could not be activated (with its install remedy when
// the backend named a binary we can actually fetch).
//
// Every node shares one anatomy — a fixed glyph gutter, a wrapping line, and the
// hairline spine that joins it to the node below — so run state reads from the
// glyph column alone, before any text. Presentational only: nothing here folds
// events, and no string here is matched against backend prose.

import type { ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  Brain,
  Check,
  ChevronRight,
  Download,
  Loader2,
  ShieldCheck,
  UserX,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import type { ToolStatus } from "../lib/types";
import { Markdown } from "./Markdown";
import { YoutubeRequirementCard } from "./ChatSkillChrome";
import type { SkillActivationFailure, ToolCallView } from "./chatMessage";

/** The disclosure summary idiom shared by every node that folds (matches the
 *  reasoning/activity disclosures the pane already uses). */
const FOLD_SUMMARY =
  "flex cursor-pointer list-none select-none items-center gap-1.5 font-medium text-muted-foreground/90 [&::-webkit-details-marker]:hidden";

/** Markdown inside a rail node: quiet, tight, and with the outer block margins
 *  collapsed so it sits flush under its summary rather than floating. */
const NODE_MARKDOWN =
  "mt-1.5 text-muted-foreground/80 [&_.nn-markdown>:first-child]:mt-0 [&_.nn-markdown>:last-child]:mb-0 [&_.nn-markdown_h1]:mt-2 [&_.nn-markdown_h1]:text-[0.75rem] [&_.nn-markdown_h2]:mt-2 [&_.nn-markdown_h2]:text-[0.6875rem] [&_.nn-markdown_h3]:mt-2 [&_.nn-markdown_h3]:text-[0.6875rem] [&_.nn-markdown_li]:leading-relaxed [&_.nn-markdown_ol]:my-1.5 [&_.nn-markdown_p]:my-1.5 [&_.nn-markdown_p]:leading-relaxed [&_.nn-markdown_pre]:my-1.5 [&_.nn-markdown_pre]:text-[0.625rem] [&_.nn-markdown_ul]:my-1.5";

/** One node on the rail.
 *
 *  The spine is drawn per node rather than once on the list: it starts *below*
 *  the glyph (so no opaque plate is needed to mask it) and runs to the node's
 *  bottom edge, which means it stretches over whatever a disclosure has
 *  expanded to. `--border` is invisible at 1px on this ground, so the rail
 *  borrows `muted-foreground` at low alpha — a deliberate, reviewed exception
 *  to the "hairlines are --border" convention (plan §1.3). */
export function TimelineNode({
  glyph,
  last,
  children,
}: Readonly<{ glyph: ReactNode; last: boolean; children: ReactNode }>) {
  return (
    <li
      className={cn(
        "relative flex items-start gap-2 text-[0.6875rem] leading-snug",
        last
          ? ""
          : "pb-2 after:absolute after:bottom-0 after:left-[0.4375rem] after:top-[1.125rem] after:w-px after:bg-muted-foreground/25",
      )}
    >
      <span className="grid size-3.5 shrink-0 translate-y-px place-items-center">
        {glyph}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** The streamed reasoning tokens, folded. Markdown, not a flat string: models
 *  emit headings, lists and code in their reasoning, and rendering that as one
 *  pre-wrapped blob made the most structured part of a turn the least legible. */
export function ThinkingNode({
  text,
  last,
}: Readonly<{ text: string; last: boolean }>) {
  return (
    <TimelineNode
      glyph={<Brain className="size-3.5 text-muted-foreground/70" aria-hidden />}
      last={last}
    >
      <details className="group">
        <summary className={FOLD_SUMMARY}>
          <ChevronRight
            className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          Reasoning
        </summary>
        <div className={NODE_MARKDOWN}>
          <Markdown body={text} />
        </div>
      </details>
    </TimelineNode>
  );
}

/** How one settled status reads. `rejected` and `denied` are deliberately
 *  different stories told in different words: the orchestrator refusing a call
 *  it could not safely run is not the user refusing to let it run, and a UI that
 *  blurred the two would misattribute a decision the user did or did not make.
 *  (`denied` has no producer until the approval gate lands, and `error` none yet
 *  — they are rendered correctly now so the wire contract has a consumer.) */
const SETTLED: Record<ToolStatus, { icon: LucideIcon; tone: string; label: string }> = {
  // The common case is calm: a call that did what it said is not news.
  ok: { icon: Check, tone: "text-muted-foreground/70", label: "" },
  error: { icon: AlertTriangle, tone: "text-destructive", label: "failed" },
  rejected: { icon: Ban, tone: "text-warning", label: "refused by NeuralNote" },
  denied: { icon: UserX, tone: "text-warning", label: "denied by you" },
};

/** The argument fields the tool schemas actually declare, in the order that
 *  makes the best one-line hint. Bulk fields (`content`, `options`) and numeric
 *  bounds are deliberately absent: a note body is not a label.
 *
 *  This reads the model's raw output, so it is parsed defensively and treated as
 *  untrusted — an unparseable or unrecognised payload yields no hint at all
 *  rather than a JSON blob on the rail. */
const HINT_FIELDS = [
  "query",
  "rel_path",
  "url",
  "playlist_url",
  "topic",
  "folder",
  "id",
  "message",
  "question",
] as const;

const MAX_HINT_CHARS = 120;

export function argumentHint(argumentsJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  for (const field of HINT_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") {
      const trimmed = value.trim();
      return trimmed.length > MAX_HINT_CHARS
        ? `${trimmed.slice(0, MAX_HINT_CHARS)}…`
        : trimmed;
    }
  }
  return null;
}

/** One dispatched tool call. The title comes from the Rust-side registry and the
 *  summary from the structured outcome — the UI composes neither and matches
 *  neither. While the call is in flight there is no summary yet, so the hint
 *  parsed out of its arguments is what says *what* is being done. */
export function ToolNode({
  call,
  last,
}: Readonly<{ call: ToolCallView; last: boolean }>) {
  const settled = call.status === null ? null : SETTLED[call.status];
  const summary = call.summary !== null && call.summary !== "" ? call.summary : null;
  const hint = argumentHint(call.arguments);
  // While a call is in flight its arguments are all there is to say what it is
  // doing; once it settles, the Rust-composed summary is the authoritative
  // account. Both show when they carry different facts ("Search notes · recall ·
  // 3 spans") and the hint stands down when the summary already opens with it
  // ("Read note · A.md:12–28", never "· A.md · A.md:12–28").
  const showHint = hint !== null && !(summary?.startsWith(hint) ?? false);
  const glyph =
    settled === null ? (
      <Loader2
        className="size-3.5 animate-spin text-primary motion-reduce:animate-none"
        aria-hidden
      />
    ) : (
      <settled.icon className={`size-3.5 ${settled.tone}`} aria-hidden />
    );
  return (
    <TimelineNode glyph={glyph} last={last}>
      <p className="min-w-0 break-words">
        <span className={settled === null ? "text-foreground/80" : "text-muted-foreground"}>
          {/* An unregistered name still arrives with a title we wrote, so this
              never renders a label the model invented. */}
          {call.title}
        </span>
        {showHint && (
          <span className="nn-mono text-muted-foreground/70"> · {hint}</span>
        )}
        {summary !== null && (
          <span className="nn-mono text-muted-foreground/70"> · {summary}</span>
        )}
        {settled !== null && settled.label !== "" && (
          <span className={settled.tone}> · {settled.label}</span>
        )}
      </p>
      {call.detail !== null && call.detail !== "" && (
        // A call that did not simply succeed opens itself: the reason has to be
        // on screen the moment it happens, not one click away. Passing a derived
        // (not state-mirrored) `open` keeps that automatic while still letting
        // the user collapse it — React only writes the prop when it changes.
        <details
          open={call.status !== null && call.status !== "ok"}
          className="group/detail mt-1"
        >
          <summary className={`${FOLD_SUMMARY} text-[0.625rem]`}>
            <ChevronRight
              className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-open/detail:rotate-90 motion-reduce:transition-none"
              aria-hidden
            />
            Details
          </summary>
          <p className="nn-mono mt-1 whitespace-pre-wrap break-words rounded-md bg-surface-sunken px-2 py-1.5 text-[0.625rem] leading-relaxed text-muted-foreground">
            {call.detail}
          </p>
        </details>
      )}
    </TimelineNode>
  );
}

/** The verification pass — the step that decides which citations survive. */
export function VerifyingNode({ last }: Readonly<{ last: boolean }>) {
  return (
    <TimelineNode
      glyph={<ShieldCheck className="size-3.5 text-muted-foreground/70" aria-hidden />}
      last={last}
    >
      <p className="text-muted-foreground">verifying citations</p>
    </TimelineNode>
  );
}

/** A citation the verifier threw away. Citation fidelity is the moat, so this is
 *  the one calm-trace step that earns the destructive register. */
export function DroppedNode({
  reason,
  last,
}: Readonly<{ reason: string; last: boolean }>) {
  return (
    <TimelineNode
      glyph={<AlertTriangle className="size-3.5 text-destructive" aria-hidden />}
      last={last}
    >
      <p className="min-w-0 break-words text-destructive">
        dropped a citation ({reason})
      </p>
    </TimelineNode>
  );
}

/** The only skill requirement this app can install for the user. The backend
 *  allowlist (`requirement_binaries.rs`) holds exactly this one, so any other
 *  missing binary gets the honest failure line and no button — offering to
 *  download something we cannot fetch would be a promise the app can't keep. */
const INSTALLABLE_BINARY = "yt-dlp";

/** A skill the user asked for that could not be activated.
 *
 *  Driven entirely by the structured `skillActivationFailed` event: `message` is
 *  display-only prose and `missingBinary` is the only remedy the backend offers.
 *  This replaces an exact-equality match against a full sentence composed in
 *  Rust — re-wording that sentence used to silently disable the install
 *  affordance, and no test could have caught it. */
export function ActivationFailureNode({
  failure,
  last,
}: Readonly<{ failure: SkillActivationFailure; last: boolean }>) {
  if (failure.missingBinary === INSTALLABLE_BINARY) {
    // The card names the problem and the fix, so the raw failure sentence above
    // it would just repeat the problem directly over its own explanation.
    return (
      <TimelineNode
        glyph={<Download className="size-3.5 text-warning" aria-hidden />}
        last={last}
      >
        <YoutubeRequirementCard requirement={INSTALLABLE_BINARY} />
      </TimelineNode>
    );
  }
  return (
    <TimelineNode
      glyph={<AlertTriangle className="size-3.5 text-destructive" aria-hidden />}
      last={last}
    >
      <p className="min-w-0 break-words text-destructive">{failure.message}</p>
    </TimelineNode>
  );
}
