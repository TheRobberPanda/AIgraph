import { useEffect } from "react";
import { createPortal } from "react-dom";
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

  // Rendered at the top of the document rather than where it was written.
  //
  // A stacked sheet is written inside the sheet below it, and that one is
  // `overflow: hidden` — while the wash under it carries a `backdrop-filter`,
  // which makes it the containing block for `position: fixed` descendants. So
  // the inner sheet was being clipped to the outer one's box: it opened
  // centred on the window, had its lower half cut off at the outer sheet's
  // edge, and read as a panel sitting too high. A portal takes it out from
  // under both.
  return createPortal(
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
    </div>,
    document.body,
  );
}
