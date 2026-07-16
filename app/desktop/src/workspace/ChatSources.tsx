// The turn's cited-source chips: each shows the note path + line and the quoted
// snippet, opens the note on click, and — for a YouTube timestamp citation —
// offers a "Watch" affordance that jumps to the moment in the source. Citation
// fidelity is the moat, so the exact path:line is always preserved in the title.
// Presentational only.

import { useState } from "react";
import { FileText, Loader2, Play } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { parseYoutubeTimestampJump } from "./youtubeTimestamp";
import type { CitationView } from "./chatMessage";

function SourceChip({
  citation,
  onOpen,
}: Readonly<{ citation: CitationView; onOpen: () => void }>) {
  const [openingTimestamp, setOpeningTimestamp] = useState(false);
  const [timestampError, setTimestampError] = useState<string | null>(null);
  const timestampJump = parseYoutubeTimestampJump(citation.text);
  const openTimestamp = async () => {
    if (timestampJump === null || openingTimestamp) return;
    setOpeningTimestamp(true);
    setTimestampError(null);
    try {
      await api.openYoutubeTimestamp(timestampJump.href);
    } catch (error) {
      setTimestampError(errorMessage(error));
    } finally {
      setOpeningTimestamp(false);
    }
  };
  const sourceBody = (
    <>
      <span
        className="nn-mono flex min-w-0 max-w-full items-center gap-1.5 text-[0.625rem] text-primary/90"
        title={`${citation.relPath}:${citation.startLine}`}
      >
        <FileText className="size-3 shrink-0 opacity-80" aria-hidden />
        <span className="min-w-0 truncate">
          {citation.relPath}:{citation.startLine}
        </span>
      </span>
      <span className="line-clamp-2 break-words border-l border-border pl-2 text-[0.6875rem] italic leading-snug text-muted-foreground">
        “{citation.text}”
      </span>
    </>
  );
  return (
    <li>
      {timestampJump === null ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full flex-col items-start gap-1 rounded-lg border border-border/80 bg-card/40 px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-card/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          {sourceBody}
        </button>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/80 bg-card/40 transition-colors hover:border-primary/40 hover:bg-card/70">
          <button
            type="button"
            onClick={onOpen}
            className="flex w-full flex-col items-start gap-1 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
          >
            {sourceBody}
          </button>
          <button
            type="button"
            onClick={() => void openTimestamp()}
            disabled={openingTimestamp}
            aria-label={`Watch at ${timestampJump.label} on YouTube`}
            className="nn-mono flex w-full items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5 text-left text-[0.625rem] font-medium text-primary/90 transition-colors hover:bg-primary/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary disabled:text-muted-foreground"
          >
            {openingTimestamp ? (
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Play className="size-3 fill-current" aria-hidden />
            )}
            Watch {timestampJump.label}
          </button>
          {timestampError !== null && (
            <p
              role="alert"
              className="break-words border-t border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[0.625rem] leading-snug text-destructive"
            >
              {timestampError}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function Sources({
  citations,
  onOpen,
}: Readonly<{
  citations: CitationView[];
  onOpen: (citation: CitationView) => void;
}>) {
  if (citations.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
        Sources
      </p>
      <ul aria-label="Cited sources" className="flex flex-col gap-1.5">
        {citations.map((c) => (
          <SourceChip key={c.id} citation={c} onOpen={() => onOpen(c)} />
        ))}
      </ul>
    </div>
  );
}
