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
      // The wash is only painted by the bottom layer. Stacked, each one
      // darkened the last and the whole window silted up.
      className={depth > 0 ? "sheet-overlay stacked" : "sheet-overlay"}
      style={{ zIndex: 70 + depth * 2 }}
      onClick={onClose}
    >
      {/* A stacked sheet is inset on every side rather than pushed down. The
          offset was a top margin, so an idea opened from a conversation sat
          low in the window instead of centred — and the further in you went,
          the lower it sat. Inset keeps it centred and still shows there is
          something behind it. */}
      <div
        className={`sheet${size === "mid" ? " sheet-mid" : ""}`}
        style={depth > 0 ? { width: `calc(min(72rem, 92vw) - ${depth * 3}rem)` } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
