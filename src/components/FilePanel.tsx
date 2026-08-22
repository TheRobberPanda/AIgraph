import { useCallback, useEffect, useRef } from "react";

/**
 * A node or row's file, opened as a panel over whatever it was opened from —
 * the map, the idea list — rather than replacing it. Resizable by dragging its
 * inner edge, and can be moved to the other side when the thing it's covering
 * matters more on the right than the left.
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
  width: number;
  onWidthChange: (width: number) => void;
  children: React.ReactNode;
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null);

  const onMove = useCallback(
    (e: MouseEvent) => {
      const start = startRef.current;
      if (!start) return;
      // Dragging toward the panel's own edge grows it, regardless of which
      // side it's docked on.
      const dx = side === "right" ? start.x - e.clientX : e.clientX - start.x;
      onWidthChange(Math.min(Math.max(start.width + dx, 280), window.innerWidth - 240));
    },
    [side, onWidthChange],
  );

  const onUp = useCallback(() => {
    startRef.current = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }, [onMove]);

  useEffect(() => () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }, [onMove, onUp]);

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    startRef.current = { x: e.clientX, width };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <div className={`file-panel ${side}`} style={{ width }}>
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
