import { useEffect } from "react";
import { onEscapeLayer } from "../lib/escape";

/**
 * A file opened over what you were doing, rather than instead of it.
 *
 * The background darkens but stays visible: you have not left the map or the
 * list, you are reading something on top of it. Clicking the wash or pressing
 * Escape puts it away.
 *
 * `depth` stacks one over another — an idea opened from a conversation's file
 * sits above that file rather than replacing it, so going back is closing
 * rather than navigating.
 */
export default function Sheet({
  onClose,
  depth = 0,
  size = "full",
  children,
}: {
  onClose: () => void;
  depth?: number;
  /** "full" is a file you read against the thing behind it; "mid" is a
   *  control panel — models, mostly — that only needs its own height. */
  size?: "full" | "mid";
  children: React.ReactNode;
}) {
  useEffect(() => onEscapeLayer(onClose), [onClose]);

  return (
    <div
      className="sheet-overlay"
      style={{ zIndex: 70 + depth * 2 }}
      onClick={onClose}
    >
      {/* Offset with margin rather than a transform: a transformed ancestor
          becomes the containing block for `position: fixed`, so a sheet opened
          over this one would be trapped inside it instead of covering the
          window. */}
      <div
        className={`sheet${size === "mid" ? " sheet-mid" : ""}`}
        style={{ marginTop: `${depth * 2.4}rem` }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
