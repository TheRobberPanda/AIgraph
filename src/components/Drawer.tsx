import { useEffect } from "react";
import { IconClose } from "./Icons";

/**
 * A panel that slides in over one side of the pane, not over the window.
 *
 * Used for things you consult while doing something else — which model is
 * answering, most of all. A full-screen sheet for that is the app saying "stop
 * what you are doing"; a drawer leaves the conversation on screen beside it,
 * which is the thing the question was about.
 */
export default function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        {/* A visible way out. Clicking the wash and pressing Escape both work,
            but neither is discoverable, and a panel with no exit is a panel
            people force-quit the app to leave. */}
        <header className="drawer-head">
          <h2 className="drawer-title">{title}</h2>
          <button className="icon-btn" data-tip="Close" onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}
