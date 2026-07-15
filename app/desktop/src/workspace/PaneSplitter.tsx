import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

interface PaneSplitterProps {
  paneId: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function PaneSplitter({
  paneId,
  width,
  minWidth,
  maxWidth,
  onResize,
}: Readonly<PaneSplitterProps>) {
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const previousWidthRef = useRef(width);

  useEffect(() => {
    if (width > minWidth) previousWidthRef.current = width;
  }, [minWidth, width]);

  const resize = (nextWidth: number) => {
    onResize(clamp(nextWidth, minWidth, maxWidth));
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    resize(drag.startWidth + event.clientX - drag.startX);
  };

  const finishPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    let nextWidth: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        nextWidth = width - step;
        break;
      case "ArrowRight":
        nextWidth = width + step;
        break;
      case "Home":
        nextWidth = minWidth;
        break;
      case "End":
        nextWidth = maxWidth;
        break;
      case "Enter":
        if (width <= minWidth) {
          // Preserve the user's previous preference even when the responsive
          // maximum is temporarily smaller. The controlled parent derives the
          // effective width and can restore the preference when space returns.
          event.preventDefault();
          onResize(previousWidthRef.current);
          return;
        } else {
          previousWidthRef.current = width;
          nextWidth = minWidth;
        }
        break;
      default:
        return;
    }
    event.preventDefault();
    resize(nextWidth);
  };

  return (
    // ARIA slider pattern: a focusable resize control selecting the pane width
    // within [min, max]. Arrow keys move along the horizontal value axis, so
    // the slider is horizontal even though the bar it drags is vertical.
    <div
      role="slider"
      aria-label="Resize files and search pane"
      aria-orientation="horizontal"
      aria-controls={paneId}
      aria-valuemin={minWidth}
      aria-valuenow={width}
      aria-valuemax={maxWidth}
      tabIndex={0}
      className="nn-pane-splitter relative z-20 shrink-0 cursor-col-resize touch-none outline-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onKeyDown={handleKeyDown}
    />
  );
}
