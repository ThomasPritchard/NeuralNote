import { Component, useState, type RefObject } from "react";
import { cn } from "../lib/cn";
import { useNoteTailFollow } from "./useNoteTailFollow";

export interface ChatNoteViewportProps {
  readonly activityId: string;
  readonly body: string;
  readonly streaming?: boolean;
  readonly status?: string;
  readonly className?: string;
}

interface SelectionSnapshot {
  anchor: number;
  focus: number;
}

function textOffset(root: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function textPosition(root: Node, requestedOffset: number): [Node, number] | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = requestedOffset;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return [node, remaining];
    remaining -= length;
  }
  return null;
}

function captureSelection(content: HTMLPreElement | null): SelectionSnapshot | null {
  const selection = window.getSelection();
  if (
    content === null ||
    selection === null ||
    selection.anchorNode === null ||
    selection.focusNode === null ||
    !content.contains(selection.anchorNode) ||
    !content.contains(selection.focusNode)
  ) {
    return null;
  }
  return {
    anchor: textOffset(content, selection.anchorNode, selection.anchorOffset),
    focus: textOffset(content, selection.focusNode, selection.focusOffset),
  };
}

function restoreSelection(
  content: HTMLPreElement | null,
  snapshot: SelectionSnapshot | null,
  bodyLength: number,
): void {
  if (content === null || snapshot === null) return;
  const anchor = textPosition(content, Math.min(snapshot.anchor, bodyLength));
  const focus = textPosition(content, Math.min(snapshot.focus, bodyLength));
  const selection = window.getSelection();
  if (anchor !== null && focus !== null && selection !== null) {
    selection.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);
  }
}

interface NoteBodyProps {
  readonly body: string;
  readonly streaming: boolean;
  readonly contentRef: RefObject<HTMLPreElement | null>;
}

/** getSnapshotBeforeUpdate is React's pre-mutation DOM snapshot boundary. It
 * keeps a reader's native selection when streamed text replaces the text node. */
class SelectionPreservingNoteBody extends Component<NoteBodyProps> {
  private content: HTMLPreElement | null = null;

  private readonly setContent = (content: HTMLPreElement | null) => {
    this.content = content;
    this.props.contentRef.current = content;
  };

  getSnapshotBeforeUpdate(previous: NoteBodyProps): SelectionSnapshot | null {
    return previous.body === this.props.body ? null : captureSelection(this.content);
  }

  componentDidUpdate(
    _previous: NoteBodyProps,
    _previousState: unknown,
    snapshot: SelectionSnapshot | null,
  ): void {
    restoreSelection(this.content, snapshot, this.props.body.length);
  }

  componentWillUnmount(): void {
    this.props.contentRef.current = null;
  }

  render() {
    const { body, streaming } = this.props;
    return (
      <pre
        ref={this.setContent}
        className="nn-mono min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] px-3 py-2 pb-10 text-[0.6875rem] leading-relaxed text-muted-foreground"
      >
        {body}
        <span
          data-testid="note-tail-cursor"
          aria-hidden="true"
          className={cn(
            "ml-px inline-block h-[0.75rem] w-1 translate-y-px bg-primary align-middle motion-reduce:transform-none motion-reduce:animate-none",
            streaming ? "animate-pulse opacity-100" : "opacity-0",
          )}
        />
      </pre>
    );
  }
}

/** The one live note preview selected by the journal. Content is deliberately
 * plain text and deliberately not live: the turn's current-action line owns
 * announcements, while this region remains readable and selectable. */
export function ChatNoteViewport({
  activityId,
  body,
  streaming = true,
  status,
  className,
}: Readonly<ChatNoteViewportProps>) {
  const follow = useNoteTailFollow({ activityId, content: body });
  const [acknowledgedActivity, setAcknowledgedActivity] = useState<string | null>(
    null,
  );
  const visibleStatus = status ?? (streaming ? "Composing note" : "Note preview ready");
  const retainingJumpFocus =
    !follow.paused && acknowledgedActivity === activityId;

  return (
    <section
      className={cn(
        "min-w-0 rounded-lg border border-border/60 bg-background/30 p-2.5",
        className,
      )}
    >
      <div className="mb-1.5 flex min-h-5 min-w-0 items-center justify-between gap-2 text-[0.6875rem] text-muted-foreground">
        <span className="font-medium text-foreground/80">Note draft</span>
        <span className="min-w-0 truncate text-right">{visibleStatus}</span>
      </div>
      <div className="relative min-w-0">
        <div
          ref={follow.viewportRef}
          role="region"
          aria-label="Note draft content"
          /* Overflow makes this region operable: WebKit does not provide a
             keyboard path to a generic scrollport, so the same narrow lint
             exception as ChatTranscript applies only while scrolling exists. */
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={follow.overflowing ? 0 : undefined}
          className="h-52 min-h-52 max-h-52 min-w-0 max-w-full overflow-x-hidden overflow-y-auto overscroll-contain rounded-md bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <SelectionPreservingNoteBody
            body={body}
            streaming={streaming}
            contentRef={follow.contentRef}
          />
        </div>
        {(follow.paused || retainingJumpFocus) && (
          <button
            type="button"
            aria-label={
              retainingJumpFocus ? "Latest note content shown" : undefined
            }
            aria-disabled={retainingJumpFocus}
            onClick={() => {
              if (!follow.paused) return;
              setAcknowledgedActivity(activityId);
              follow.jumpToLatest();
            }}
            onBlur={() => {
              if (retainingJumpFocus) setAcknowledgedActivity(null);
            }}
            className="absolute bottom-2 right-2 min-h-6 rounded-md border border-border bg-surface-raised px-2 py-1 text-[0.6875rem] font-medium text-foreground shadow-sm transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            {retainingJumpFocus ? "Latest" : "Jump to latest"}
          </button>
        )}
      </div>
    </section>
  );
}
