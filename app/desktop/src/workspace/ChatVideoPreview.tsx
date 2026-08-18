// The card for the video a distil run is working on right now, shown under the
// live head while a playlist is in flight.
//
// Three things shape it, and all three are consequences of the state contract
// rather than taste:
//
//   1. **The text-only card is the real design, not a fallback.** The thumbnail
//      is fetched host-side, capped and timed out, so `thumbnailDataUri` is null
//      whenever that fetch is slow, oversized or refused — and until Phase 4
//      ships the fetch at all, it is null on every run. A card that only looked
//      composed with a picture in it would look broken for most of its life.
//   2. **The card is bound to the PLAYLIST, not to the preview.** The reducer
//      retires a preview the moment a beacon names a different item, so there is
//      a real gap between "video 2 finished" and "video 3's details arrived". A
//      card mounted on `videoPreview` would blink out and back in between every
//      item; one mounted on `playlist` holds its place and changes its contents.
//   3. **Its height is declared, not emergent.** The card is a fixed row and
//      every column is sized from it, so nothing here moves when a long title
//      wraps, when the details arrive, or when an image finally lands in the
//      plate that was already holding its footprint. Letting the taller of the
//      two columns win looked equivalent and was not: measured in a real
//      browser, a two-line title beat the plate by 0.625px.
//
// Presentational only: every field is host-read metadata handed down as props.

import { Film } from "lucide-react";
import { cn } from "../lib/cn";
import type { PlaylistPosition } from "../lib/types";
import type { VideoPreviewView } from "./chatMessage";

/** A video's length the way a video player writes one: `12:22`, and `1:02:15`
 *  once there is an hour to report. Minutes are only zero-padded when an hour
 *  sits in front of them, so a short video reads `4:07` rather than `04:07`. */
function formatVideoDuration(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

/** The one meta row: where this video sits in the run, who made it, how long it
 *  is. Each fact is dropped when it is not known rather than rendered empty, so
 *  an extractor that reported no channel leaves no dangling separator.
 *
 *  Truthiness rather than a null check, on purpose. It is the same rule the
 *  fields' own doc comments state: a duration of `0` must render as ABSENT,
 *  because `0:00` claims a measurement of a video with no length was taken. */
function metaLine(
  preview: VideoPreviewView | null,
  playlist: PlaylistPosition | null,
): string | null {
  const parts: string[] = [];
  if (playlist !== null) parts.push(`Video ${playlist.position} of ${playlist.total}`);
  if (preview?.channel) parts.push(preview.channel);
  if (preview?.durationSecs) parts.push(formatVideoDuration(preview.durationSecs));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The card's height, declared rather than emergent.
 *
 *  `4.375rem` (70px) is the plate at 16:9 plus the card's own `p-2`. Every other
 *  dimension follows from it: the plate takes the row's full height and derives
 *  its width from its aspect ratio, and the text column is clipped to the same
 *  height. Fixing the number here rather than letting the taller of the two
 *  columns win is what makes the no-reflow property structural — measured, a
 *  two-line title beat the plate by 0.625px, which is invisible on screen and
 *  is still the transcript moving under a live run. */
const CARD_HEIGHT = "h-[4.375rem]";

/** The 16:9 plate, sized from the card's declared height.
 *
 *  Empty, it is not a skeleton: a violet-tinted ground inside a violet hairline
 *  is a deliberate slot for a picture, and the film glyph says what kind of thing
 *  belongs in it. The glyph is `aria-hidden` and the image carries `alt=""`
 *  because the title beside them is the accessible content — exactly the
 *  treatment `ElicitCard` already gives an option's data-URI image, which is the
 *  same transport arriving on the same channel. */
function PreviewPlate({ thumbnailDataUri }: Readonly<{ thumbnailDataUri: string | null }>) {
  return (
    <div className="grid aspect-video h-full shrink-0 place-items-center overflow-hidden rounded-md bg-primary/10 ring-1 ring-inset ring-primary/60">
      {thumbnailDataUri === null ? (
        <Film className="size-4 text-muted-foreground/70" aria-hidden />
      ) : (
        <img src={thumbnailDataUri} alt="" className="size-full object-cover" />
      )}
    </div>
  );
}

/** What the run is working on, beside the head that says how far through it is.
 *
 *  Rendered from the first beacon that names a playlist item, which is before
 *  anything is known about the video itself. That opening state is spelled out
 *  rather than faked with a shimmer: the card says it is waiting for the details,
 *  in the muted register the real title will replace at full weight. */
export function VideoPreviewCard({
  preview,
  playlist,
}: Readonly<{ preview: VideoPreviewView | null; playlist: PlaylistPosition | null }>) {
  if (preview === null && playlist === null) return null;
  const meta = metaLine(preview, playlist);
  return (
    <div
      className={cn(
        "mt-2 flex items-start gap-2.5 rounded-lg border border-border/60 bg-card/50 p-2",
        CARD_HEIGHT,
      )}
    >
      <PreviewPlate thumbnailDataUri={preview?.thumbnailDataUri ?? null} />
      <div className="min-w-0 flex-1 overflow-hidden">
        {preview === null ? (
          <p className="truncate text-[0.75rem] leading-snug text-muted-foreground">
            Waiting for the video details
          </p>
        ) : (
          <p className="line-clamp-2 text-[0.75rem] font-medium leading-snug text-foreground">
            {preview.title}
          </p>
        )}
        {meta !== null && (
          <p className="mt-0.5 truncate text-[0.6875rem] leading-snug text-muted-foreground">
            {meta}
          </p>
        )}
      </div>
    </div>
  );
}
