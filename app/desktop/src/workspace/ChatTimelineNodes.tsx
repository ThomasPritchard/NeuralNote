// The individual nodes that hang off the chat timeline rail: the reasoning
// disclosure, one node per dispatched tool call, the verify/dropped-citation
// steps, and a skill that could not be activated (with its install remedy when
// the backend named a binary we can actually fetch).
//
// Every node shares one anatomy — a fixed glyph gutter, a wrapping line, and the
// hairline spine that joins it to the node below — so run state reads from the
// glyph column alone, before any text. Presentational only: nothing here folds
// events, and no string here is matched against backend prose.
//
// A tool node adds one more row to that anatomy, and the two things that can
// occupy it SHARE it rather than stacking: while the call runs it holds what the
// tool is saying about itself, and once the call settles it holds the disclosure
// of what it said. Neither can move the node, because the row is there either
// way — see `ProgressLine`.

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
  Square,
  TimerOff,
  UserX,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import type { ToolStatus } from "../lib/types";
import { Markdown } from "./Markdown";
import { YoutubeRequirementCard } from "./ChatSkillChrome";
import type {
  ReasoningSource,
  SkillActivationFailure,
  ToolCallView,
} from "./chatMessage";

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

/** Which turn of the run one train of thought came from, in the vocabulary the
 *  live head already uses for the same fact ("round 2 of 8").
 *
 *  This label is the entire reason a turn now contributes one node per train of
 *  thought instead of one blob: three identical `Reasoning` folds in a row say
 *  the model thought three times and nothing about *when*, which is the one
 *  thing that tells round 2's reasoning from round 3's and from the reasoning it
 *  did just before answering.
 *
 *  `unattributed` is deliberately unlabelled rather than guessed at. Nothing on
 *  the wire produces it — the planning beacon precedes the first model request —
 *  so in practice it is a turn assembled by hand, and an unlabelled fold is
 *  exactly how this node read before boundaries existed. */
function reasoningLabel(source: ReasoningSource): string | null {
  switch (source.kind) {
    case "round":
      return `round ${source.round}`;
    // Named by when it happened, like the round beside it, rather than by what
    // it is: "final" would be a claim about the run's shape that a stopped or
    // failed turn breaks.
    case "answer":
      return "before answering";
    case "unattributed":
      return null;
  }
}

/** One train of thought, folded, labelled with the turn that produced it.
 *  Markdown, not a flat string: models emit headings, lists and code in their
 *  reasoning, and rendering that as one pre-wrapped blob made the most
 *  structured part of a turn the least legible. */
export function ThinkingNode({
  text,
  source,
  last,
}: Readonly<{ text: string; source: ReasoningSource; last: boolean }>) {
  const label = reasoningLabel(source);
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
          {/* A qualifier, not a second heading: quieter and lighter than the
              word it qualifies, so a rail of folds still reads as one thing
              said several times rather than as several different things. */}
          {label !== null && (
            <span className="font-normal text-muted-foreground/60">· {label}</span>
          )}
        </summary>
        <div className={NODE_MARKDOWN}>
          <Markdown body={text} />
        </div>
      </details>
    </TimelineNode>
  );
}

/** How one settled status reads. Each label names *who* stopped the call, because
 *  that is the whole story and the one thing a user cannot recover from being
 *  told wrongly: the orchestrator refusing a call it could not safely run is not
 *  the user refusing to let it run, and neither is a prompt nobody answered.
 *
 *  `denied`, `timedOut` and `cancelled` are three statuses rather than one for
 *  exactly that reason. The gate distinguishes them on the wire and the
 *  orchestrator now carries the distinction through, so a request that expired
 *  while the user was away no longer reports itself as something they refused.
 *  (`error` is a fourth, and it is the one that is not about *who* stopped the
 *  call: `ToolOutcome::Failed` means the call ran and broke. Keep it distinct
 *  from `denied` — telling a user NeuralNote refused something it actually
 *  attempted and failed at is the same lie in the opposite direction.)
 *
 *  The glyph column reads before any text, so each of the three now carries its
 *  own, matching the approval node's vocabulary in `approvalCopy` (one act, two
 *  rows — they must not disagree about what happened):
 *
 *  • `denied` — a person icon refusing. The user is the party who acted.
 *  • `timedOut` — an expired timer. The window closed, nobody acted.
 *  • `cancelled` — the pane's own solid Stop square, the glyph this UI already
 *    uses for "this run ended", in the calm register: nobody refused anything.
 *    A warning tone here would blame someone for a non-event.
 *
 *  `rejected` keeps `Ban` and the warning tone: NeuralNote itself refused, which
 *  is the one of the four that IS a refusal by a party with a reason.
 *
 *  Exported because a previewed write's node stands down in favour of
 *  `ChatNoteEditCard`, which then owes the user the same account in the same
 *  words. Two hand-written copies of this vocabulary would eventually disagree
 *  about what "rejected" means. */
export const TOOL_SETTLEMENT: Record<
  ToolStatus,
  { icon: LucideIcon; tone: string; label: string; filled?: true }
> = {
  // The common case is calm: a call that did what it said is not news.
  ok: { icon: Check, tone: "text-muted-foreground/70", label: "" },
  error: { icon: AlertTriangle, tone: "text-destructive", label: "failed" },
  rejected: { icon: Ban, tone: "text-warning", label: "refused by NeuralNote" },
  denied: { icon: UserX, tone: "text-warning", label: "denied by you" },
  timedOut: { icon: TimerOff, tone: "text-warning", label: "expired unanswered" },
  cancelled: {
    icon: Square,
    tone: "text-muted-foreground/70",
    label: "run ended first",
    filled: true,
  },
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

/** How much of the argument the rail will show.
 *
 *  This is the rail's only restraint now that every dispatched node stays on it,
 *  so it has to do real work. The hint is mono at 11px in a ~320px column — call
 *  it 45 characters a line at the shipped pane width, fewer in a narrow window —
 *  and a model that writes its own search queries will happily write two hundred
 *  characters of them. At the old 120 one query wrapped over seven lines and
 *  became the tallest thing in the timeline; at 64 it costs a line or two, which
 *  is what a hint is worth beside the title it qualifies. Nothing is lost by
 *  cutting it: the hint only says what a call is DOING, and the moment it
 *  settles the Rust-composed summary beside it becomes the authoritative
 *  account. */
const MAX_HINT_CHARS = 64;

/** The widened disclosure's column heading. Quiet enough to be furniture. */
const COLUMN_LABEL =
  "text-[0.5625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60";

/** A block of preformatted, untrusted-but-escaped text inside a disclosure —
 *  bounded in height, because a model can put a whole document in one argument
 *  and a fold that grows without limit is the rail's old wrapping bug again. */
const DETAIL_BODY =
  "nn-mono max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface-sunken px-2 py-1.5 text-[0.625rem] leading-relaxed text-muted-foreground";

/** The raw argument payload, indented if it happens to parse.
 *
 *  Best-effort by design: this is raw model output, so anything that is not
 *  valid JSON is shown exactly as it arrived rather than being repaired into
 *  something the model did not send. */
export function formatArguments(argumentsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argumentsJson), null, 2);
  } catch {
    return argumentsJson;
  }
}

/** The node's second row, in both of the states a node has.
 *
 *  A node is one line plus one: the title line, and beneath it either what the
 *  running tool is saying about itself or the disclosure holding what it
 *  eventually said. The two never coexist — `progress` only arrives while
 *  `status` is null, and `detail` only exists once it is not — so they share one
 *  slot of one declared line, and the node therefore holds its footprint from
 *  dispatch through settlement.
 *
 *  That is not a nicety. Before this, an in-flight node was one row and a
 *  settled one was two, so every single settlement grew the rail a line under a
 *  live run. Sharing the slot removes that, and it is what makes a progress line
 *  arriving four minutes into a transcription cost nothing at all. */
function ProgressLine({ text }: Readonly<{ text: string | undefined }>) {
  return (
    // `min-h` because an empty block has no line box and would reserve nothing.
    // `1.375em` is `leading-snug`'s own ratio against this element's font size —
    // the same reservation the stall notice makes, and no pixel value to drift.
    //
    // One line, clipped, with the whole sentence kept in the DOM (so assistive
    // tech and a hover both get it). Two lines would read better for the longest
    // string a tool sends and would cost the footprint guarantee above; the run
    // clock in the head is the better answer to "how much longer" anyway.
    //
    // NOT a live region and NOT `aria-hidden`. Nothing here announces, because
    // nothing wraps it in one — a tool narrating itself every few seconds must
    // not interrupt a screen reader (`ChatMessages.tsx:95`). It stays readable
    // on the node for anyone who navigates to it, which for a four-minute call
    // is the only account of what is happening.
    <p
      className="mt-1 min-h-[1.375em] truncate text-[0.625rem] leading-snug text-muted-foreground/80"
      title={text}
    >
      {text}
    </p>
  );
}

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
 *  parsed out of its arguments is what says *what* is being done, and
 *  `progress` — when the tool sends any — says what it is doing about it.
 *
 *  **A call's own retrieval cues are deliberately not shown here**, and that is
 *  a decision rather than an omission — the reducer no longer even keeps them
 *  per call, only on the turn's activity trace. The orchestrator raises at most
 *  one `Searching`/`Retrieved` pair per `search_notes` call and at most one
 *  `Reading` per `read_note_span` call (`orchestrator/collect.rs`), and both of
 *  that cue's facts are already on this line: the query IS the argument hint
 *  (`HINT_FIELDS` leads with `query`), and the hit count and the note's line
 *  range ARE the Rust-composed summary ("12 spans", "A.md:12–28"). Showing them
 *  again would put one act on one node twice, which is the rule `showHint` and
 *  `railCalls` already enforce elsewhere. What that leaves genuinely out of
 *  reach is a query longer than `MAX_HINT_CHARS`, and the answer to that is the
 *  disclosure below — which is why the arguments column no longer hides itself
 *  at the shipped pane width. */
export function ToolNode({
  call,
  last,
}: Readonly<{ call: ToolCallView; last: boolean }>) {
  const settled = call.status === null ? null : TOOL_SETTLEMENT[call.status];
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
      <settled.icon
        className={cn("size-3.5", settled.tone, settled.filled && "fill-current")}
        aria-hidden
      />
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
      {settled === null && <ProgressLine text={call.progress} />}
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
          {/* What was asked, then what came back. The container query decides
              only whether the two sit SIDE BY SIDE, never whether the first one
              exists: it used to hide the arguments outright below 30rem, and
              since the turn is ~388px at the shipped pane width, the raw
              payload was unreachable at the width almost everyone runs — not
              deprioritised, gone. Stacked below the threshold, two columns
              above; both headed either way, because two unlabelled blobs in a
              column are worse than none. */}
          <div className="mt-1 grid gap-1.5 @[30rem]:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <p className={COLUMN_LABEL}>
                Arguments
                {/* The wire name of the call the model actually made, kept in
                    the machine register beside the machine payload rather than
                    on the rail — `Search notes` and `search_notes` on one glance
                    line is the same fact twice. It earns its place here because
                    of the one node where the title cannot identify the call: an
                    unregistered name renders under a Rust-authored "Unrecognised
                    tool", and this fold — which opens itself for a rejected
                    call — is then the only place the invented name appears. */}
                <span className="nn-mono ml-1.5 font-normal normal-case tracking-normal text-muted-foreground/50">
                  {call.name}
                </span>
              </p>
              <p className={DETAIL_BODY}>{formatArguments(call.arguments)}</p>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <p className={COLUMN_LABEL}>Result</p>
              <p className={DETAIL_BODY}>{call.detail}</p>
            </div>
          </div>
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
