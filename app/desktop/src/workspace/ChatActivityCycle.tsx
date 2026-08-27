import type { JournalActivity, JournalCycle } from "./activityJournal";
import type { JournalCurrentAction } from "./activityJournalSelectors";
import type { ToolApprovalView, VideoPreviewView } from "./chatMessage";
import type { PlaylistPosition } from "../lib/types";
import { ChatActionsAudit } from "./ChatActionsAudit";
import { ChatCurrentAction } from "./ChatCurrentAction";
import { ChatNoteViewport } from "./ChatNoteViewport";
import { ChatThinkingDisclosure } from "./ChatThinkingDisclosure";
import { VideoPreviewCard } from "./ChatVideoPreview";

export function ChatActivityCycle({
  cycle,
  activities,
  currentAction,
  currentActivity,
  settled,
  failures,
  approvals,
  preview,
  playlist,
  onOpenNote,
}: Readonly<{
  cycle: JournalCycle;
  activities: JournalActivity[];
  currentAction: JournalCurrentAction | null;
  currentActivity: JournalActivity | null;
  settled: boolean;
  failures: number;
  approvals: ReadonlyMap<string, ToolApprovalView>;
  preview: VideoPreviewView | null;
  playlist: PlaylistPosition | null;
  onOpenNote: (relPath: string) => void;
}>) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <ChatThinkingDisclosure text={cycle.thinking.text} />
      {cycle.summary !== null && (
        <p className="whitespace-pre-wrap text-[0.8125rem] leading-relaxed text-foreground/90">
          {cycle.summary.message}
        </p>
      )}
      {currentAction !== null && <ChatCurrentAction action={currentAction} />}
      {currentActivity?.preview !== null && currentActivity?.preview !== undefined && (
        <ChatNoteViewport
          activityId={currentActivity.id}
          body={currentActivity.preview.body}
          streaming
          status={currentActivity.progress ?? undefined}
        />
      )}
      {(preview !== null || playlist !== null) && (
        <VideoPreviewCard preview={preview} playlist={playlist} />
      )}
      {settled && (
        <ChatActionsAudit
          activities={activities}
          failures={failures}
          protocolIssues={cycle.summary?.protocolIssues ?? []}
          approvals={approvals}
          onOpenNote={onOpenNote}
        />
      )}
    </section>
  );
}
