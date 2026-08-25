import { useEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /**
   * Ask again before doing it. The first click swaps the label for this one
   * and the second carries it out.
   *
   * For anything that throws work away. A right-click menu opens under the
   * pointer, which is exactly where the next click lands — so the gap between
   * meaning to open it and having deleted something is one twitch wide.
   */
  confirm?: string;
}

/**
 * A small floating menu at a point on screen, replacing the browser's own
 * right-click menu with actions that actually apply here.
 */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** Which item is armed, if any. */
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep it on screen even when opened near an edge.
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 36 - 16),
  };

  return (
    <div ref={ref} className="context-menu" style={style}>
      {items.map((item) => {
        const isArmed = armed === item.label;
        return (
          <button
            key={item.label}
            className={
              (item.danger || isArmed ? "context-item danger" : "context-item") +
              (isArmed ? " armed" : "")
            }
            onClick={() => {
              if (item.confirm && !isArmed) {
                setArmed(item.label);
                return;
              }
              item.onSelect();
              onClose();
            }}
            onMouseLeave={() => isArmed && setArmed(null)}
          >
            {isArmed ? item.confirm : item.label}
          </button>
        );
      })}
    </div>
  );
}
