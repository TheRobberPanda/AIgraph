import { useCallback, useEffect, useRef } from "react";

/**
 * How much of the split the panel takes when first opened.
 *
 * Two thirds. A file is opened to be read, and the map behind it only has to
 * show where the thing being read sits — a third is enough for that, and less
 * than that for the words is not enough to read them in.
 */
const DEFAULT_SHARE = 0.65;
/**
 * Narrower than this and the transcript and the list of ideas cannot both fit
 * beside each other at a readable width — 15rem for the words, the list's
 * fixed 19rem, the gap between them, and the pane's own padding.
 */
const MIN_WIDTH = 640;

/**
 * A node or row's file, opened beside whatever it was opened from — the map,
 * the idea list — rather than replacing it or covering it.
 *
 * Laid out in flow rather than floated on top, so the thing it was opened
 * from keeps the rest of the space to itself and never renders underneath.
 * Resizable by dragging its inner edge, and movable to the other side.
 */
export default function FilePanel({
  side,
  onSideChange,
  width,
  onWidthChange,
  children,
}: {
  side: "left" | "right";
  onSideChange: (side: "left" | "right") => void;
  /** Pixels, or null for the default share of the split. */
  width: number | null;
  onWidthChange: (width: number) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; width: number } | null>(null);

  const onMove = useCallback(
    (e: MouseEvent) => {
      const start = startRef.current;
      if (!start) return;
      // Dragging toward the panel's own edge grows it, whichever side it is
      // docked on.
      const dx = side === "right" ? start.x - e.clientX : e.clientX - start.x;
      const parent = ref.current?.parentElement?.clientWidth ?? window.innerWidth;
      // Always leave the other half something to be. A panel dragged to fill
      // the window would be the full-page view this exists to replace — and
      // one dragged below MIN_WIDTH has a transcript too narrow to read, which
      // is the same thing from the other end.
      onWidthChange(Math.min(Math.max(start.width + dx, MIN_WIDTH), parent - 260));
    },
    [side, onWidthChange],
  );

  const onUp = useCallback(() => {
    startRef.current = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }, [onMove]);

  useEffect(
    () => () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    },
    [onMove, onUp],
  );

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    // Measured rather than taken from the prop, so the first drag from the
    // default share starts from where the panel actually is.
    startRef.current = { x: e.clientX, width: ref.current?.clientWidth ?? 0 };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <div
      ref={ref}
      className={`file-panel ${side}`}
      style={{
        // A share of the split, but never below what the file needs — on a
        // small screen a third of the window is not enough to read in.
        flexBasis:
          width === null ? `max(${DEFAULT_SHARE * 100}%, ${MIN_WIDTH}px)` : `${width}px`,
      }}
    >
      <div className="file-panel-resize" onMouseDown={startDrag} />
      <button
        className="file-panel-flip"
        data-tip={side === "right" ? "Move to the left" : "Move to the right"}
        onClick={() => onSideChange(side === "right" ? "left" : "right")}
      >
        ⇄
      </button>
      {children}
    </div>
  );
}
