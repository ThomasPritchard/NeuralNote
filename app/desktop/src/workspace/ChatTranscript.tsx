// The scrolling conversation region: the transcript's empty state, the message
// list, and the jump-to-latest affordance. Owns `useStickyScroll` so the hook
// always mounts with a scroll port already in the DOM — the pane's other
// provider states (loading / picker / setup / disconnected) never render one,
// and an effect that finds a null ref on mount would never run again.
//
// The port is a labelled, focusable region: a scrollable container that cannot
// be reached by keyboard is a WCAG 2.1.1 failure, and WebKit — the engine this
// app actually ships on — does not make one focusable on its own the way
// Chromium and Firefox do.

import { ArrowDown, Sparkles } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "../lib/cn";
import { ChatMessages } from "./ChatMessages";
import type { ChatMessage, CitationView } from "./chatMessage";
import { useStickyScroll } from "./useStickyScroll";

function EmptyTranscript() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
        <Sparkles className="size-5" aria-hidden />
      </span>
      <div className="flex flex-col gap-1.5">
        <p className="text-[0.8125rem] font-medium text-foreground/90">
          Ask anything across your vault
        </p>
        <p className="mx-auto max-w-[15rem] text-[0.75rem] leading-relaxed text-muted-foreground">
          Watch the answer get searched, read and citation-checked live.
        </p>
      </div>
    </div>
  );
}

export function ChatTranscript({
  messages,
  onOpenCitation,
  onOpenNote,
  onSendFollowUp,
  busy,
  runIds,
}: Readonly<{
  messages: ChatMessage[];
  onOpenCitation: (citation: CitationView) => void;
  onOpenNote: (relPath: string) => void;
  /** Issues an ordinary chat turn — a dormant elicitation's late answer. */
  onSendFollowUp: (text: string) => void;
  /** A run is currently streaming (late elicitation sends must wait). */
  busy: boolean;
  /** Run ids by message index, resolved as each run settles — Undo's handle. */
  runIds: Readonly<Record<number, string>>;
}>) {
  const { containerRef, contentRef, showJump, jumpToLatest } = useStickyScroll({
    turnCount: messages.length,
  });
  return (
    // The jump control anchors to this wrapper, not to the port: inside the
    // scroll port it would scroll away with the content it points at.
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        role="region"
        aria-label="Conversation"
        /* `no-noninteractive-tabindex` exists to stop content being made
           focusable for no reason. A SCROLLABLE region is the standing
           exception: scrolling is functionality, so WCAG 2.1.1 requires a
           keyboard path to it. Chromium's auto-focusable-scroller heuristic
           does not cover this one (it applies only to scrollers with NO
           focusable children, and this has citation chips and disclosures),
           and WebKit — the engine this app ships on — has no such heuristic. */
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {/* The growing element the observer watches. `min-h-full` keeps the
            empty state centred in the port now that the padding lives here. */}
        <div ref={contentRef} className="flex min-h-full flex-col px-4 py-4">
          {messages.length === 0 ? (
            <EmptyTranscript />
          ) : (
            <ChatMessages
              messages={messages}
              onOpenCitation={onOpenCitation}
              onOpenNote={onOpenNote}
              onSendFollowUp={onSendFollowUp}
              busy={busy}
              runIds={runIds}
            />
          )}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="Jump to latest"
          className={cn(
            buttonVariants({ tone: "quiet", size: "sm" }),
            "absolute bottom-3 right-4 gap-1.5 rounded-full pl-2.5 pr-3 shadow-lg shadow-background/70",
          )}
        >
          <ArrowDown className="size-3.5" aria-hidden />
          Latest
        </button>
      )}
    </div>
  );
}
