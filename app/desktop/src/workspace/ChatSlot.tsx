// The chat pane's clipping slot: the element whose width IS the pane's share of
// the workspace, and the only place the two width states are expressed.
//
// It is its own component for two reasons. The first is that the slot carries
// three independent bits of layout state on one element — mounted-but-collapsed,
// widened, and inert — and reading them together is easier than finding them
// among WorkspacePanes' thirty-odd props. The second is that this is the seam a
// real-browser test can mount: the chain "click the header toggle → the layout
// hook flips `chatExpanded` → this attribute changes → the CSS token resolves →
// the pane is measurably wider" is geometric, and jsdom cannot see any of it.

import { ChatPane } from "./ChatPane";

export function ChatSlot({
  showChat,
  expanded,
  onToggleExpanded,
  openNoteAt,
  onOpenSettings,
  refreshSignal,
}: Readonly<{
  /** The pane is open. Collapsed, the slot clips to zero width. */
  showChat: boolean;
  /** The pane is widened to `--chat-width-expanded`. */
  expanded: boolean;
  onToggleExpanded: () => void;
  openNoteAt: (absPath: string) => void;
  onOpenSettings: () => void;
  refreshSignal: number;
}>) {
  return (
    // Keep ChatPane mounted and collapse only this clipping slot. Unmounting
    // would discard the transcript and abandon an in-flight streamed answer;
    // inert + aria-hidden remove the collapsed controls from interaction.
    <div
      className="nn-chat-slot"
      data-visible={showChat}
      data-expanded={expanded}
      aria-hidden={!showChat}
      inert={!showChat}
    >
      <ChatPane
        openNoteAt={openNoteAt}
        onOpenSettings={onOpenSettings}
        refreshSignal={refreshSignal}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
      />
    </div>
  );
}
