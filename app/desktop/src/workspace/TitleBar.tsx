// The integrated titlebar (macOS overlay style). The webview extends
// under the native traffic lights, so this bar draws the window chrome around
// them: a traffic-light spacer clears the lights, then the navigation toggle,
// horizontally scrolling document tabs, and quiet window actions.
//
// Dragging: a dedicated absolutely-positioned layer BEHIND the interactive
// clusters carries `data-tauri-drag-region`; the clusters sit above it (z-10)
// so clicks land on buttons while empty gaps between clusters fall through to
// the drag layer and move the window. Native traffic-light clicks are OS-handled;
// the spacer is padding on the left cluster, so it does not fall through.
//
// Pure presentation, prop-driven. Vault identity and actions live in Ribbon.

import {
  AlertTriangle,
  LoaderCircle,
  Network,
  PanelLeft,
  Settings,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { IconButton } from "@/components/ui/icon-button";
import { extFromPath, iconForFile } from "./fileMeta";

export interface TitleBarTabSummary {
  id: string;
  title: string;
  path: string;
  dirty: boolean;
  loading: boolean;
  error: string | null;
}

export type TitleBarView = "note" | "graph";

export const GRAPH_TAB_ID = "nn-graph-tab";
export const GRAPH_PANEL_ID = "nn-graph-panel";

export function noteTabTriggerId(tabId: string): string {
  return `nn-note-tab-${encodeURIComponent(tabId)}`;
}

export function noteTabPanelId(tabId: string): string {
  return `nn-note-panel-${encodeURIComponent(tabId)}`;
}

export interface TitleBarProps {
  /** The user's navigation preference after responsive constraints. */
  navigationExpanded: boolean;
  onToggleNavigation: () => void;
  /** Whether the cited-recall chat panel is showing. */
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenSettings: () => void;
  /** Presentation-only summaries. Drafts and note bodies remain in Workspace. */
  tabs: readonly TitleBarTabSummary[];
  activeTabId: string | null;
  activeView: TitleBarView;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseGraph: () => void;
}

export function TitleBar({
  navigationExpanded,
  onToggleNavigation,
  chatOpen,
  onToggleChat,
  onOpenSettings,
  tabs,
  activeTabId,
  activeView,
  onActivateTab,
  onCloseTab,
  onCloseGraph,
}: Readonly<TitleBarProps>) {
  const macOSFullscreenState = useMacOSFullscreenState();
  // Named for what they select, not for what they know: `useTightOffset` is true
  // only when fullscreen is *confirmed*, so "unknown" falls to the windowed
  // offset and is hidden by `holdOffsetDecision` rather than painted.
  const useTightOffset = macOSFullscreenState === "fullscreen";
  const holdOffsetDecision = macOSFullscreenState === "unknown";

  return (
    <header
      className={`nn-titlebar ${useTightOffset ? "nn-titlebar-toggle-clearance-fullscreen" : "nn-titlebar-toggle-clearance-windowed"} relative grid h-(--titlebar-height) shrink-0 border-b border-border bg-titlebar`}
      data-navigation-expanded={navigationExpanded}
      data-chat-open={chatOpen}
    >
      {/* Drag layer — behind the z-10 clusters. If a button click ever moves
          the window instead of firing, this layering is what broke. */}
      <div data-tauri-drag-region aria-hidden className="absolute inset-0" />

      {/* Left: traffic-light spacer (pl), then navigation toggle. While macOS
          fullscreen is still "unknown", this cluster is held `invisible`
          (not `display: none`) — see useMacOSFullscreenState for why. */}
      <div
        className={`relative z-10 flex min-w-0 items-center gap-1 self-stretch pr-2 ${useTightOffset ? "pl-[12px]" : "pl-[74px]"} ${holdOffsetDecision ? "invisible" : ""}`}
      >
        <TitleBarButton
          icon={PanelLeft}
          label="Toggle navigation sidebar"
          pressed={navigationExpanded}
          onClick={onToggleNavigation}
        />
      </div>

      <TabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        activeView={activeView}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onCloseGraph={onCloseGraph}
      />

      {/* Right: cited-recall chat toggle, then settings. */}
      <div className="relative z-10 flex shrink-0 items-center justify-end gap-1 self-stretch pr-3">
        <TitleBarButton
          icon={Sparkles}
          label="Toggle chat panel"
          pressed={chatOpen}
          onClick={onToggleChat}
        />
        <TitleBarButton icon={Settings} label="Settings" onClick={onOpenSettings} />
      </div>
    </header>
  );
}

function isMacOSRuntime(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Macintosh|Mac OS X/.test(navigator.userAgent)
  );
}

type MacOSFullscreenState = "unknown" | "windowed" | "fullscreen";

function useMacOSFullscreenState(): MacOSFullscreenState {
  // Fullscreen is genuinely UNKNOWN until the async native query answers —
  // isFullscreen() is IPC-only, so there is no synchronous signal to read
  // before the first paint. Modelling that gap as a boolean (the old
  // `useState(false)`) silently means "windowed" for the whole gap: an app
  // launched already in native fullscreen painted the 74px traffic-light
  // offset on frame one — an empty gap with no traffic lights under it,
  // since macOS hides them in fullscreen — and then visibly snapped shut to
  // 12px once the query answered.
  //
  // Picking the opposite default (guess fullscreen) doesn't fix this: macOS
  // restores a window's fullscreen state across launches, so this is not a
  // rare-vs-common split. A user who works fullscreen quits fullscreen and
  // relaunches fullscreen — the original bug hits *every* launch for them.
  // A user who works windowed hits it on *none*. Defaulting "unknown" to
  // either offset just moves the total-failure population from one type of
  // user to the other; there is no guess that is "usually right".
  //
  // So don't guess — hold. While `state === "unknown"`, the offset-dependent
  // left cluster renders `invisible` (visibility: hidden, not display:
  // none) so its box still reserves its own layout space, but nothing
  // wrong is ever painted there: no control sits at an offset that turns
  // out to be false. The header's traffic-light-clearance class (which also
  // sizes the grid column carrying this cluster — see .nn-titlebar's
  // `max(nav+sidebar+splitter, clearance)` in styles.css) stays pinned to
  // "windowed" throughout "unknown", matching non-macOS's synchronous
  // default below, so a windowed launch never moves at all: the cluster is
  // simply invisible-then-visible at the position it already occupies. A
  // fullscreen launch still corrects once the query answers — the toggle
  // appears and the tab strip snaps to its tighter position in that one
  // update (neither `--titlebar-toggle-clearance` nor `.nn-titlebar` is
  // transitioned, so it is a snap, not an ease) — but nothing incorrect was
  // ever shown first, which is the part that read as broken. Non-macOS
  // resolves straight to "windowed" synchronously (isMacOSRuntime() is a
  // plain UA check, no IPC needed) and paints the cluster visible
  // immediately — no held/invisible frame there at all.
  //
  // The catch block resolves a *rejected* initial query to "windowed". That
  // is rejection, not a query that never settles: there is no deadline here,
  // so a hung IPC would hold "unknown" and leave the toggle `visibility:
  // hidden` — out of hit-testing and out of the tab order. No path is known
  // that produces a hang, and the native app menu still reaches the sidebar
  // if one ever did, so this is recorded rather than defended against.
  const [state, setState] = useState<MacOSFullscreenState>(() =>
    isMacOSRuntime() ? "unknown" : "windowed",
  );

  useEffect(() => {
    if (!isMacOSRuntime()) return;

    const appWindow = getCurrentWindow();
    let cancelled = false;
    let requestVersion = 0;
    let unlisten: (() => void) | undefined;

    const syncFullscreen = async () => {
      const request = ++requestVersion;
      try {
        const next = await appWindow.isFullscreen();
        if (!cancelled && request === requestVersion) {
          setState(next ? "fullscreen" : "windowed");
        }
      } catch (error) {
        console.error("failed to read native fullscreen state:", error);
        if (!cancelled && request === requestVersion) {
          // Resolve an unconfirmed "unknown" to the safe windowed fallback.
          // A failure on a later resync (state already definite) is left
          // alone — keep the last confirmed geometry rather than discarding
          // it over a transient IPC hiccup.
          setState((prev) => (prev === "unknown" ? "windowed" : prev));
        }
      }
    };

    void syncFullscreen();
    void appWindow
      .onResized(() => void syncFullscreen())
      .then((stopListening) => {
        if (cancelled) stopListening();
        else unlisten = stopListening;
      })
      .catch((error) => {
        console.error("failed to subscribe to native window resize:", error);
      });

    return () => {
      cancelled = true;
      requestVersion += 1;
      unlisten?.();
    };
  }, []);

  return state;
}

interface TabStripProps {
  tabs: readonly TitleBarTabSummary[];
  activeTabId: string | null;
  activeView: TitleBarView;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseGraph: () => void;
}

function TabStrip({
  tabs,
  activeTabId,
  activeView,
  onActivateTab,
  onCloseTab,
  onCloseGraph,
}: Readonly<TabStripProps>) {
  const selectedTabRef = useRef<HTMLButtonElement>(null);
  const selectedNoteId = tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : (tabs[0]?.id ?? null);

  useEffect(() => {
    selectedTabRef.current?.scrollIntoView?.({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeView, selectedNoteId]);

  return (
    <div
      role="tablist"
      aria-label="Open notes"
      className="nn-tab-strip relative z-10 flex min-w-0 self-end overflow-x-auto"
    >
      {tabs.map((tab) => {
        const selected = activeView === "note" && tab.id === selectedNoteId;
        return (
          <NoteTab
            key={tab.id}
            tab={tab}
            selected={selected}
            triggerRef={selected ? selectedTabRef : undefined}
            onActivate={() => onActivateTab(tab.id)}
            onClose={() => onCloseTab(tab.id)}
          />
        );
      })}
      {activeView === "graph" && (
        <DocumentTab
          selected
          triggerId={GRAPH_TAB_ID}
          panelId={GRAPH_PANEL_ID}
          title="Graph"
          accessibleName="Graph"
          icon={Network}
          triggerRef={selectedTabRef}
          onActivate={() => undefined}
          onClose={onCloseGraph}
        />
      )}
    </div>
  );
}

interface NoteTabProps {
  tab: TitleBarTabSummary;
  selected: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  onActivate: () => void;
  onClose: () => void;
}

function NoteTab({
  tab,
  selected,
  triggerRef,
  onActivate,
  onClose,
}: Readonly<NoteTabProps>) {
  const TabIcon = noteTabIcon(tab);
  const status = [
    tab.dirty ? "unsaved changes" : null,
    tab.loading ? "loading" : null,
    tab.error ? "failed to load" : null,
  ].filter(Boolean);
  const accessibleName = [tab.title, ...status].join(", ");

  return (
    <DocumentTab
      selected={selected}
      triggerId={noteTabTriggerId(tab.id)}
      panelId={noteTabPanelId(tab.id)}
      title={tab.title}
      accessibleName={accessibleName}
      icon={TabIcon}
      iconSpins={tab.loading}
      dirty={tab.dirty}
      error={Boolean(tab.error)}
      triggerRef={triggerRef}
      onActivate={onActivate}
      onClose={onClose}
    />
  );
}

/** Loading and failure states override the file-type icon, in that order. */
function noteTabIcon(tab: TitleBarTabSummary): LucideIcon {
  if (tab.loading) return LoaderCircle;
  if (tab.error) return AlertTriangle;
  return iconForFile(extFromPath(tab.path));
}

interface DocumentTabProps {
  selected: boolean;
  triggerId: string;
  panelId: string;
  title: string;
  accessibleName: string;
  icon: LucideIcon;
  iconSpins?: boolean;
  dirty?: boolean;
  error?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  onActivate: () => void;
  onClose: () => void;
}

function DocumentTab({
  selected,
  triggerId,
  panelId,
  title,
  accessibleName,
  icon: Icon,
  iconSpins = false,
  dirty = false,
  error = false,
  triggerRef,
  onActivate,
  onClose,
}: Readonly<DocumentTabProps>) {
  return (
    // Layout-only wrapper: the positioning context for the absolute close
    // action. Keep it role-free — a plain div adds no semantics between the
    // tablist and its tabs, which is what role="presentation" was spelling out.
    <div
      className="nn-note-tab relative flex h-[36px] min-w-[144px] max-w-[256px] shrink-0 items-center"
      data-selected={selected}
      data-error={error || undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        role="tab"
        id={triggerId}
        aria-label={accessibleName}
        aria-selected={selected}
        aria-controls={panelId}
        tabIndex={selected ? 0 : -1}
        title={title}
        onClick={onActivate}
        onKeyDown={(event) => handleTabKeyDown(event, onClose)}
        className="nn-note-tab-trigger flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-8 text-left text-[0.8125rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon
          className={`size-3.5 shrink-0 ${error ? "text-destructive" : "text-primary"} ${iconSpins ? "animate-spin motion-reduce:animate-none" : ""}`}
          aria-hidden
        />
        <span className="truncate">{title}</span>
        {dirty && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-primary"
            aria-label="Unsaved changes"
          />
        )}
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Close ${title}`}
        title={`Close ${title}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="nn-tab-close absolute right-1 grid size-[24px] place-items-center rounded-md text-muted-foreground opacity-80 transition-colors hover:bg-surface-hover hover:text-foreground hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

function handleTabKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  onClose: () => void,
): void {
  // Cmd-W is owned by the native File menu. Handling it here as well can make
  // one keypress close two tabs when WKWebView delivers both accelerator paths.
  if (event.key === "Delete") {
    event.preventDefault();
    onClose();
    return;
  }

  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tablist = event.currentTarget.closest('[role="tablist"]');
  const triggers = Array.from(tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
  const currentIndex = triggers.indexOf(event.currentTarget);
  if (currentIndex < 0 || triggers.length === 0) return;

  event.preventDefault();
  const lastIndex = triggers.length - 1;
  let nextIndex = currentIndex;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = lastIndex;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + triggers.length) % triggers.length;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % triggers.length;

  const next = triggers[nextIndex];
  next?.focus();
  next?.click();
}

interface TitleBarButtonProps {
  icon: LucideIcon;
  label: string;
  /** Present for toggles (surfaced as aria-pressed); absent for plain actions. */
  pressed?: boolean;
  onClick: () => void;
}

/** Icon button following the RibbonButton conventions, sized for a 40px bar. */
function TitleBarButton({
  icon: Icon,
  label,
  pressed,
  onClick,
}: Readonly<TitleBarButtonProps>) {
  return (
    <IconButton
      label={label}
      pressed={pressed}
      onClick={onClick}
      className="nn-titlebar-action size-8 bg-transparent text-muted-foreground"
    >
      <Icon className="size-4" aria-hidden />
    </IconButton>
  );
}
