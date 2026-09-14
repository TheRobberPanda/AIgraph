import { useEffect } from "react";
import { onEscapeLayer } from "../lib/escape";

/**
 * An in-app confirmation, replacing the browser's own dialog — which renders
 * outside the window chrome and looks like it belongs to a different app.
 */
export default function Confirm({
  title,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => onEscapeLayer(onCancel), [onCancel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") onConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onConfirm]);

  return (
    // `clear`: a question and two buttons does not need the window dimmed and
    // blurred behind it — over the chat that read as the conversation being
    // taken away, for a question about one message in it.
    <div className="modal-overlay clear" onClick={onCancel}>
      <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
        <p>{title}</p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={danger ? "btn danger" : "btn on"}
            autoFocus
            onClick={onConfirm}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
