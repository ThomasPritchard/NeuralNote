import {
  AlertTriangle,
  ArrowUpRight,
  FileText,
  GripHorizontal,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { errorMessage, readNote } from "../../lib/api";
import { useVault } from "../../lib/store";
import type { NoteDoc } from "../../lib/types";
import { withoutRepeatedLeadingTitle } from "../Reader";
import type { GalaxyNode } from "./graph";
import type { ClusterMap } from "./galaxyTypes";
import { plural } from "./galaxyText";
import { buildLocalNoteDigest, type NotePreviewMetrics } from "./notePreviewModel";
import "./galaxyNotePreview.css";

interface GalaxyNotePreviewProps {
  selected: GalaxyNode;
  clusters: ClusterMap;
  neighbours: { node: GalaxyNode; bridge: boolean }[];
  onNodeClick: (node: GalaxyNode) => void;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  metrics: NotePreviewMetrics;
}

type PreviewNoteState =
  | { phase: "loading"; noteId: string }
  | { phase: "ready"; noteId: string; note: NoteDoc }
  | { phase: "error"; noteId: string; message: string };

interface PreviewDragControls {
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

export function GalaxyNotePreview({
  selected,
  clusters,
  neighbours,
  onNodeClick,
  onClose,
  onOpenNote,
  metrics,
}: Readonly<GalaxyNotePreviewProps>) {
  const { vault } = useVault();
  const [retryRevision, setRetryRevision] = useState(0);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startBubbleX: number;
    startBubbleY: number;
  } | null>(null);
  const [state, setState] = useState<PreviewNoteState>({
    phase: "loading",
    noteId: selected.id,
  });
  const titleId = useId();

  useEffect(() => {
    const noteId = selected.id;
    if (!vault) {
      setState({
        phase: "error",
        noteId,
        message: "The vault is no longer open, so this note cannot be previewed.",
      });
      return;
    }

    let cancelled = false;
    setState({ phase: "loading", noteId });
    const vaultRoot = vault.path.replace(/\/$/, "");
    void readNote(`${vaultRoot}/${noteId}`).then(
      (note) => {
        if (!cancelled) setState({ phase: "ready", noteId, note });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ phase: "error", noteId, message: errorMessage(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selected.id, vault, retryRevision]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    delete layer.dataset.dragX;
    delete layer.dataset.dragY;
    delete layer.dataset.dragged;
  }, [selected.id]);

  const currentBubblePosition = () => {
    const layer = layerRef.current;
    if (!layer) return { x: 0, y: 0 };
    const style = getComputedStyle(layer);
    const x = Number.parseFloat(style.getPropertyValue("--nn-graph-preview-bubble-x"));
    const y = Number.parseFloat(style.getPropertyValue("--nn-graph-preview-bubble-y"));
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    };
  };
  const setDraggedPosition = (x: number, y: number) => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.dataset.dragX = `${x}`;
    layer.dataset.dragY = `${y}`;
    layer.dataset.dragged = "true";
  };
  const dragControls: PreviewDragControls = {
    onPointerDown: (event) => {
      const position = currentBubblePosition();
      dragRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startBubbleX: position.x,
        startBubbleY: position.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    onPointerMove: (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      setDraggedPosition(
        drag.startBubbleX + event.clientX - drag.startClientX,
        drag.startBubbleY + event.clientY - drag.startClientY,
      );
      event.preventDefault();
    },
    onPointerUp: (event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      dragRef.current = null;
    },
    onKeyDown: (event) => {
      const movement = event.shiftKey ? 32 : 12;
      const delta = {
        ArrowLeft: { x: -movement, y: 0 },
        ArrowRight: { x: movement, y: 0 },
        ArrowUp: { x: 0, y: -movement },
        ArrowDown: { x: 0, y: movement },
      }[event.key];
      if (!delta) return;
      const position = currentBubblePosition();
      setDraggedPosition(position.x + delta.x, position.y + delta.y);
      event.preventDefault();
      event.stopPropagation();
    },
  };

  const visibleState: PreviewNoteState =
    state.noteId === selected.id
      ? state
      : { phase: "loading", noteId: selected.id };
  const clusterLabel = clusters[selected.cluster]?.label ?? selected.cluster;
  const style = {
    "--nn-graph-preview-accent": selected.color,
    "--nn-graph-preview-width": `${metrics.width}px`,
    "--nn-graph-preview-height": `${metrics.height}px`,
  } as CSSProperties;

  return (
    <div
      ref={layerRef}
      className="nn-graph-preview-layer"
      data-compact={metrics.compact ? "true" : "false"}
      data-tight={metrics.tight ? "true" : "false"}
      style={style}
    >
      <p className="sr-only" aria-live="polite">
        Previewing {selected.title}
      </p>
      <PreviewTether />
      <aside
        className="nn-graph-preview"
        aria-labelledby={titleId}
        onKeyDown={(event) => closeOnEscape(event, onClose)}
      >
        <OrbitChrome />
        <header className="nn-graph-preview-header">
          <div className="min-w-0 text-center">
            <ClusterBadge label={clusterLabel} color={selected.color} />
            <p className="nn-mono mt-2 text-[0.5625rem] uppercase tracking-[0.18em] text-muted-foreground">
              Local digest
            </p>
            <h2
              id={titleId}
              className="nn-graph-preview-title nn-heading mt-1 text-xl font-semibold leading-tight text-foreground"
              title={selected.title}
            >
              {selected.title}
            </h2>
          </div>
          <PreviewControls dragControls={dragControls} onClose={onClose} />
        </header>
        <PreviewBody
          state={visibleState}
          title={selected.title}
          metrics={metrics}
          onRetry={() => setRetryRevision((revision) => revision + 1)}
        />
        <NeighbourDots
          neighbours={neighbours}
          onNodeClick={onNodeClick}
          limit={metrics.compact ? 6 : 8}
        />
        <div className="nn-graph-preview-actions">
          <button
            type="button"
            onClick={() => onOpenNote(selected.id)}
            className="nn-graph-preview-open-reader"
          >
            Open in reader
            <ArrowUpRight className="size-3.5" aria-hidden />
          </button>
        </div>
      </aside>
    </div>
  );
}

function OrbitChrome() {
  return (
    <div className="nn-graph-preview-constellation-ring" aria-hidden>
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function PreviewTether() {
  return (
    <div className="nn-graph-preview-tether" aria-hidden>
      <span />
    </div>
  );
}

function NeighbourDots({
  neighbours,
  onNodeClick,
  limit,
}: Readonly<{
  neighbours: { node: GalaxyNode; bridge: boolean }[];
  onNodeClick: (node: GalaxyNode) => void;
  limit: number;
}>) {
  const shown = neighbours.slice(0, limit);
  return (
    <section
      className="nn-graph-preview-neighbour-dots"
      aria-label={plural(neighbours.length, "connected note")}
    >
      <span className="nn-graph-preview-neighbour-label nn-mono text-[0.55rem] uppercase tracking-[0.12em] text-muted-foreground">
        {plural(neighbours.length, "connected note")}
      </span>
      <div className="nn-graph-preview-neighbour-targets flex items-center">
        {shown.map(({ node, bridge }) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onNodeClick(node)}
            className="nn-graph-preview-neighbour-target"
            aria-label={`Preview connected note ${node.title}${bridge ? ", cross-folder" : ""}`}
            title={`${node.title}${bridge ? " · Cross-folder" : ""}`}
          >
            <span
              className="nn-graph-preview-neighbour-dot"
              style={{ background: node.color }}
              aria-hidden
            />
          </button>
        ))}
        {neighbours.length > shown.length && (
          <span className="nn-mono text-[0.55rem] text-muted-foreground">
            +{neighbours.length - shown.length}
          </span>
        )}
      </div>
    </section>
  );
}

function PreviewBody({
  state,
  title,
  metrics,
  onRetry,
}: Readonly<{
  state: PreviewNoteState;
  title: string;
  metrics: NotePreviewMetrics;
  onRetry: () => void;
}>) {
  return (
    <div
      className="nn-graph-preview-body"
      role="region"
      aria-label={`Preview of ${title}`}
    >
      {state.phase === "loading" && (
        <div className="nn-graph-preview-state" role="status">
          <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
          Loading note…
        </div>
      )}
      {state.phase === "error" && (
        <div className="nn-graph-preview-state" role="alert">
          <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
          <div>
            <p>{state.message}</p>
            <button type="button" onClick={onRetry} className="nn-graph-preview-retry">
              <RotateCw className="size-3" aria-hidden /> Retry preview
            </button>
          </div>
        </div>
      )}
      {state.phase === "ready" && <LoadedNote note={state.note} metrics={metrics} />}
    </div>
  );
}

function LoadedNote({
  note,
  metrics,
}: Readonly<{ note: NoteDoc; metrics: NotePreviewMetrics }>) {
  if (note.exceedsEditableSize) {
    return (
      <PreviewNotice>
        This note is {formatBytes(note.sizeBytes)} and is too large for an inline preview. The file
        remains untouched; open it in the reader for the app&apos;s full size-limit guidance.
      </PreviewNotice>
    );
  }
  if (note.binary) {
    return <PreviewNotice>This graph node does not have a text preview.</PreviewNotice>;
  }

  const body = withoutRepeatedLeadingTitle(note.body, note.title);
  return (
    <>
      {(note.lossyText || note.frontmatterError) && (
        <div className="nn-graph-preview-warnings">
          {note.lossyText && (
            <PreviewWarning compactLabel="Lossy text">
              Some characters were decoded lossily.
            </PreviewWarning>
          )}
          {note.frontmatterError && (
            <PreviewWarning compactLabel="Frontmatter issue">
              Frontmatter could not be parsed.
            </PreviewWarning>
          )}
        </div>
      )}
      {body.trim() ? (
        <LocalDigest body={body} leadCharacterLimit={metrics.tight ? 96 : 132} />
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">This note has no body content yet.</p>
      )}
    </>
  );
}

function LocalDigest({
  body,
  leadCharacterLimit,
}: Readonly<{ body: string; leadCharacterLimit: number }>) {
  const content = buildLocalNoteDigest(body, leadCharacterLimit);
  return (
    <section className="nn-graph-preview-content-treatment" aria-label="Local digest">
      <div className="nn-graph-preview-digest-labels">
        <p className="nn-graph-preview-content-label nn-mono">Derived on this device</p>
        <span className="nn-graph-preview-no-model">No model called</span>
      </div>
      <p className="nn-graph-preview-digest-lead">{content.lead}</p>
      <dl className="nn-graph-preview-stats">
        <div>
          <dt>Words</dt>
          <dd>{content.wordCount}</dd>
        </div>
        <div>
          <dt>Read</dt>
          <dd>{content.readingMinutes} min</dd>
        </div>
        <div>
          <dt>Sections</dt>
          <dd>{content.sectionCount}</dd>
        </div>
      </dl>
    </section>
  );
}

function PreviewNotice({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="nn-graph-preview-notice">
      <FileText className="mb-2 size-4 text-primary" aria-hidden />
      {children}
    </div>
  );
}

function PreviewWarning({
  children,
  compactLabel,
}: Readonly<{ children: ReactNode; compactLabel: string }>) {
  return (
    <div className="nn-graph-preview-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="nn-graph-preview-warning-full">{children}</span>
      <span className="nn-graph-preview-warning-compact">{compactLabel}</span>
    </div>
  );
}

function ClusterBadge({ label, color }: Readonly<{ label: string; color: string }>) {
  return (
    <span
      className="nn-graph-preview-cluster-badge nn-mono inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[0.625rem] uppercase tracking-wider"
      style={{ borderColor: `${color}55`, background: `${color}16`, color }}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function PreviewControls({
  dragControls,
  onClose,
}: Readonly<{ dragControls: PreviewDragControls; onClose: () => void }>) {
  return (
    <div className="nn-graph-preview-controls">
      <button
        type="button"
        className="nn-graph-preview-drag-handle"
        aria-label="Move note preview. Drag, or use arrow keys; hold Shift for larger steps."
        title="Move preview"
        onPointerDown={dragControls.onPointerDown}
        onPointerMove={dragControls.onPointerMove}
        onPointerUp={dragControls.onPointerUp}
        onPointerCancel={dragControls.onPointerUp}
        onKeyDown={dragControls.onKeyDown}
      >
        <GripHorizontal className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close note preview"
        className="nn-graph-preview-icon-button"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

function closeOnEscape(event: KeyboardEvent<HTMLElement>, onClose: () => void) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  onClose();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
