// The live note-write card: a note the model is composing, rendered as the
// arguments arrive and upgraded IN PLACE into the settled write.
//
// Four things carry the design, and three of them are contracts that are easy to
// render backwards:
//
//   1. The preview arrives BEFORE its tool call. Previews stream during the turn;
//      tool calls are announced when the turn settles. So `call` is routinely
//      `undefined` for a live card, and the card must be complete without it —
//      never "waiting for the call to know what to draw". The rail's tool node
//      stands down for a previewed id instead (see `ChatTimeline`), which makes
//      this card the ONLY surface carrying that call's failure detail.
//   2. A rejected write is NOT abandoned. When a preview completes and dispatch
//      then rejects it, no `noteEditAbandoned` follows — the rejection is only
//      readable off the tool call's `status`. A card that does not look there
//      leaves a refused write sitting on screen looking committed.
//   3. An abandoned preview clears the body and says so. A half-written note left
//      looking committed is the same class of failure as a wrong citation, and it
//      is the COMMON path: a provider error mid-turn truncates the last call.
//   4. The body is a tail, not a diff. `write_note` only ever creates
//      (`write_policy.rs` — a collision either returns `Existing` or writes to a
//      suffixed name), so there is no baseline on the wire and every line is an
//      addition. Tinting them `+` green would restate what "writing a note"
//      already says, so the lines render plain and the only count is the running
//      `+N` in the header.
//
// Presentational only: every field comes from the reducer's `NoteEditView` /
// `ToolCallView`, no string here is matched against backend prose, and the card
// composes no path of its own — see `ChatNoteEdits` for why it never offers the
// written path as a link.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Check, FilePen, Loader2 } from "lucide-react";
import { cn } from "../lib/cn";
import type { AssistantMessage, NoteEditView, ToolCallView } from "./chatMessage";
import { TOOL_SETTLEMENT } from "./ChatTimelineNodes";
import { PathLabel } from "./SkillReportCard";

/** How many lines of a still-composing note stay on screen. The window IS the
 *  clip: rendering only the newest lines keeps the newest text in view without
 *  an overflow container, so nothing depends on how an engine resolves
 *  `justify-content: flex-end` against overflowing flex content. */
const TAIL_LINES = 12;

/** The cap once the write has settled and the fold can be opened. Still a tail —
 *  one windowing path for both states — with the elided count stated. */
const FULL_LINES = 400;

/** How often the composing body is re-rendered.
 *
 *  Content arrives roughly 12 characters at a time and a single note is
 *  comfortably hundreds of updates, each of which re-splits the body and
 *  re-renders a dozen rows inside a scroll container that re-pins on every
 *  commit. At ~12 fps the tail still reads as live typing and the work drops by
 *  more than an order of magnitude. The last value is never dropped: a settled,
 *  abandoned or complete body bypasses the throttle entirely. */
export const THROTTLE_MS = 80;

/** The top fade. Set as arbitrary properties rather than a `mask-*` utility so
 *  it cannot silently emit nothing, and duplicated with the `-webkit-` prefix
 *  for the WKWebView versions that still want it. */
const TOP_FADE =
  "[mask-image:linear-gradient(to_bottom,transparent_0,#000_2.25rem)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,#000_2.25rem)]";

/** The header row, shared by the folding and the abandoned anatomies.
 *
 *  `flex-wrap` is load-bearing at the shipped pane width: the path is `flex-1`
 *  with a zero basis, so it never forces a break, but "refused by NeuralNote"
 *  beside a kind chip and a count can exceed a ~330px content box on its own.
 *  Without the wrap those `shrink-0` chips push the row into horizontal
 *  overflow — which the pane must never do. */
const HEADER_ROW = "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5";

/** Where a previewed write has got to. Derived from the edit and the tool call
 *  that owns its id — never from arrival order, which is the opposite of what it
 *  looks like (contract 1 above). */
export type NoteEditOutcome =
  /** Arguments still arriving. */
  | { state: "composing" }
  /** The arguments closed and parsed. Nothing has been written yet: the tool
   *  still has to be dispatched, and can still be refused. */
  | { state: "pending" }
  /** The call settled `ok` — the note landed. */
  | { state: "written" }
  /** The call settled anything else. `detail` is the only account of why, and
   *  the rail's node has stood down, so this card owes the user that string. */
  | { state: "refused"; label: string; tone: string; detail: string | null }
  /** The preview was retired: the model never finished the call, the run was
   *  cancelled, or the arguments never became valid JSON. */
  | { state: "abandoned"; reason: string };

export function noteEditOutcome(
  edit: NoteEditView,
  call: ToolCallView | undefined,
): NoteEditOutcome {
  // Abandonment wins over everything: it says the body on screen is a fragment,
  // which is the one thing that must never be left reading as committed. The
  // backend never previews a call it has already abandoned, so this cannot
  // suppress a later legitimate success.
  if (edit.abandoned !== null) return { state: "abandoned", reason: edit.abandoned };
  // A settled status only exists on a call, so the two are narrowed together —
  // `call` is routinely absent here (contract 1), and that is "not settled yet",
  // never "settled, detail unknown".
  if (call !== undefined && call.status !== null) {
    if (call.status === "ok") return { state: "written" };
    // "refused by NeuralNote" / "denied by you" / "failed" — the rail's own
    // vocabulary, imported rather than re-typed so the two cannot drift. Only
    // `ok` carries an empty label there, and it has already returned.
    const settled = TOOL_SETTLEMENT[call.status];
    return {
      state: "refused",
      label: settled.label,
      tone: settled.tone,
      detail: call.detail,
    };
  }
  return edit.complete ? { state: "pending" } : { state: "composing" };
}

/** The rendered tail of a body, and the added-line count, from ONE split.
 *
 *  The count is the same number the rows are drawn from by construction. Deriving
 *  it separately is how a header ends up claiming `+14` over thirteen visible
 *  lines. It is a live count on purpose: the settled total only arrives with the
 *  write, so a header reading it off a completion field shows `+0` for the whole
 *  composition — the entire span the user is watching. */
export interface NoteEditBody {
  /** Lines added so far — every line, since a create has no baseline. */
  added: number;
  /** Lines elided above the window. */
  hidden: number;
  /** The windowed lines, oldest first. */
  lines: string[];
}

export function noteEditBody(body: string, max: number): NoteEditBody {
  if (body === "") return { added: 0, hidden: 0, lines: [] };
  // A body ending in `\n` splits to a trailing `""`. Dropping exactly one keeps
  // the count off by nothing and stops a phantom blank row appearing under the
  // caret on every newline the model emits.
  const all = body.replace(/\n$/, "").split("\n");
  const hidden = Math.max(0, all.length - max);
  return { added: all.length, hidden, lines: all.slice(hidden) };
}

/** Sample a fast-changing value at most once every `ms`.
 *
 *  Leading edge, so the first fragment is on screen immediately; trailing, so the
 *  last one is never dropped; and `now` bypasses it entirely for any state where
 *  the value has stopped moving and the render must be exact. */
export function useThrottled<T>(value: T, ms: number, now: boolean): T {
  const [shown, setShown] = useState(value);
  const lastAt = useRef(0);
  useEffect(() => {
    if (now) {
      setShown(value);
      return;
    }
    const wait = ms - (Date.now() - lastAt.current);
    if (wait <= 0) {
      lastAt.current = Date.now();
      setShown(value);
      return;
    }
    const timer = window.setTimeout(() => {
      lastAt.current = Date.now();
      setShown(value);
    }, wait);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, ms, now]);
  return shown;
}

/** The composed body. Plain mono lines: with no baseline to diff against, every
 *  line is an addition and a `+` gutter would only restate the header. */
function NoteEditBodyView({
  body,
  live,
}: Readonly<{ body: NoteEditBody; live: boolean }>) {
  const { hidden, lines } = body;
  return (
    <div className="mt-1.5 overflow-hidden rounded-md bg-surface-sunken">
      <div
        className={cn(
          "flex flex-col px-2 py-1.5",
          // Live: the fade is what says "there is more above", so no fold row —
          // a number that churns on every fragment is noise beside a caret.
          // Settled: the fold row states the elision exactly, so no fade.
          live ? TOP_FADE : "max-h-72 overflow-y-auto",
        )}
      >
        {!live && hidden > 0 && (
          <p className="mb-1 border-b border-dashed border-border pb-1 text-[0.625rem] leading-[1.5] text-muted-foreground/70">
            {`${hidden} earlier ${hidden === 1 ? "line" : "lines"}`}
          </p>
        )}
        {lines.map((line, i) => (
          // Keyed by absolute line number: the window slides as the body grows,
          // so the index within it is not an identity but `hidden + i` is.
          <p
            key={hidden + i}
            className="nn-mono min-h-[0.9375rem] whitespace-pre-wrap break-words text-[0.625rem] leading-[1.5] text-muted-foreground"
          >
            {line}
            {live && i === lines.length - 1 && (
              <span
                className="ml-px inline-block h-[0.6875rem] w-1 translate-y-px animate-pulse bg-primary align-middle motion-reduce:animate-none"
                aria-hidden
              />
            )}
          </p>
        ))}
      </div>
    </div>
  );
}

/** The glyph and the state affix, per outcome. One place, so the collapsed
 *  header always agrees with the body below it. */
function outcomeChrome(outcome: NoteEditOutcome): {
  glyph: ReactNode;
  affix: string;
  tone: string;
} {
  switch (outcome.state) {
    case "composing":
    case "pending":
      return {
        glyph: (
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden
          />
        ),
        affix: outcome.state === "composing" ? "writing" : "waiting to write",
        tone: "text-muted-foreground",
      };
    case "written":
      return {
        glyph: <Check className="size-3.5 shrink-0 text-healthy" aria-hidden />,
        affix: "written",
        tone: "text-muted-foreground",
      };
    case "refused":
      return {
        glyph: (
          <AlertTriangle className={cn("size-3.5 shrink-0", outcome.tone)} aria-hidden />
        ),
        affix: outcome.label,
        tone: outcome.tone,
      };
    case "abandoned":
      return {
        glyph: <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden />,
        affix: "not written",
        tone: "text-warning",
      };
  }
}

/** One previewed write.
 *
 *  `call` is the tool call that owns this edit's id, or `undefined` — which is
 *  the NORMAL live state, not a missing-data case (contract 1). */
export function ChatNoteEditCard({
  edit,
  call,
}: Readonly<{ edit: NoteEditView; call: ToolCallView | undefined }>) {
  const outcome = noteEditOutcome(edit, call);
  const live = outcome.state === "composing";
  // A body still being composed is a fragment; anything else is final, so it is
  // rendered exactly rather than up to a throttle interval late.
  const shown = useThrottled(edit.body, THROTTLE_MS, !live);
  const body = noteEditBody(shown, live ? TAIL_LINES : FULL_LINES);
  const { glyph, affix, tone } = outcomeChrome(outcome);
  // Nothing landed, so a `+N` here would be a claim about the vault that is
  // false. The body stays (for a refusal it is exactly what was refused); only
  // the count goes.
  const counted = outcome.state !== "refused" && outcome.state !== "abandoned";
  // Settled writes fold themselves away: the answer is the live focus once a
  // write is done, and the pane has room for one big thing at a time. Derived,
  // never mirrored in state — React writes the DOM prop only when the value
  // changes, so a user who re-opens it keeps it open.
  const settled = outcome.state === "written" || outcome.state === "refused";

  const header = (
    <>
      {glyph}
      {edit.relPath === null ? (
        <span className="min-w-0 flex-1 text-[0.6875rem] text-muted-foreground/70">
          naming the note…
        </span>
      ) : (
        <PathLabel relPath={edit.relPath} />
      )}
      {edit.kind !== null && (
        <span className="nn-mono shrink-0 rounded-full bg-muted/40 px-1.5 py-px text-[0.5625rem] uppercase tracking-[0.08em] text-muted-foreground ring-1 ring-inset ring-border">
          {edit.kind}
        </span>
      )}
      {counted && (
        <span className="nn-mono shrink-0 text-[0.625rem] text-muted-foreground">
          {`+${body.added}`}
        </span>
      )}
      <span className={cn("shrink-0 text-[0.625rem]", tone)}>{affix}</span>
    </>
  );

  return (
    <section
      aria-label={
        edit.relPath === null ? "Note write" : `Note write: ${edit.relPath}`
      }
      className="flex min-w-0 flex-col rounded-lg border border-border/60 bg-background/30 px-3 py-2.5"
    >
      {outcome.state === "abandoned" ? (
        // No fold and no body: the fragment is gone, and what replaces it is the
        // reason it is gone. Leaving the half-written note behind a disclosure
        // would still leave it on screen, one click from reading as committed.
        <>
          <div className={HEADER_ROW}>
            <FilePen className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
            {header}
          </div>
          <p className="mt-1.5 min-w-0 break-words text-[0.625rem] leading-snug text-warning">
            {`This note was never written — ${outcome.reason}`}
          </p>
        </>
      ) : (
        <details open={!settled} className="min-w-0">
          <summary
            className={cn(
              HEADER_ROW,
              "cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden",
            )}
          >
            <FilePen className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
            {header}
          </summary>
          <NoteEditBodyView body={body} live={live} />
        </details>
      )}
      {outcome.state === "refused" && outcome.detail !== null && outcome.detail !== "" && (
        // The rail's node stood down for this id, so this is the only place the
        // refusal's reason can appear. It is never folded away.
        <p className="nn-mono mt-1.5 min-w-0 whitespace-pre-wrap break-words rounded-md bg-surface-sunken px-2 py-1.5 text-[0.625rem] leading-relaxed text-muted-foreground">
          {outcome.detail}
        </p>
      )}
    </section>
  );
}

/** Every previewed write of a turn, paired with the call that owns its id.
 *
 *  The path shown is the one the model ASKED for, and it is deliberately not a
 *  link: `write_note` writes to a suffixed name when the requested one is taken
 *  (`write_policy.rs`), so the requested path can name a file that does not
 *  exist. The run's report card below is the authority on what landed — it
 *  carries the resolved path, the openable row, and the run-scoped Undo that
 *  becomes available the moment a write settles. */
export function ChatNoteEdits({ turn }: Readonly<{ turn: AssistantMessage }>) {
  if (turn.noteEdits.length === 0) return null;
  const calls = new Map(turn.toolCalls.map((call) => [call.id, call]));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {turn.noteEdits.map((edit) => (
        <ChatNoteEditCard key={edit.id} edit={edit} call={calls.get(edit.id)} />
      ))}
    </div>
  );
}
