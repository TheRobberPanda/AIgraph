import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
 *
 * It renders through a portal at the document root, because `position: fixed`
 * is only relative to the viewport while no ancestor transforms it — and this
 * menu is mounted from panels, sheets and canvases, some of which do. Inside
 * one of those it was positioned as if the transformed box were the window,
 * and the menu landed cropped outside the app.
 *
 * The clamping reads the menu's own rendered size rather than counting items:
 * labels wrap, and a guess that is wrong by a line is a menu cut off at the
 * bottom edge — the exact thing this exists to prevent.
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
  /** Where the menu actually goes, decided from its own measured box. */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

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

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const margin = 8;
    // Near the right or bottom edge the menu is pulled back inside, past
    // its own width and height — the pointer stays over the first item,
    // which is where the eye already is.
    const left =
      x + box.width + margin > window.innerWidth
        ? Math.max(margin, x - box.width)
        : x;
    const top =
      y + box.height + margin > window.innerHeight
        ? Math.max(margin, window.innerHeight - box.height - margin)
        : y;
    setPos({ left, top });
  }, [x, y, items.length]);

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={{
        position: "fixed",
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        // Measured before it is placed: invisible, not flickering at the
        // raw point and then jumping.
        visibility: pos ? undefined : "hidden",
      }}
    >
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
    </div>,
    document.body,
  );
}
