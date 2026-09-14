import { useEffect, useState } from "react";
import { onEscapeLayer } from "../lib/escape";

/**
 * Three questions before anything is destroyed for good.
 *
 * Only the bin can destroy, and it asks three times, each question harder to
 * say yes to by accident than the last. Enter does not answer any of them: a
 * key held or pressed three times is not three decisions.
 */
export function ConfirmThrice({
  what,
  onConfirm,
  onCancel,
}: {
  /** What is about to go, as a phrase — “3 items”, “the conversation “X””. */
  what: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const titles = [
    `Delete ${what} for good?`,
    `Are you sure? Once deleted, ${what} cannot be restored.`,
    `Last chance — ${what} will be destroyed permanently. Delete?`,
  ];
  return (
    <Confirm
      key={step}
      title={`${titles[step]} (${step + 1} of 3)`}
      danger
      noEnter
      onCancel={onCancel}
      onConfirm={() => (step < 2 ? setStep(step + 1) : onConfirm())}
    />
  );
}

/**
 * An in-app confirmation, replacing the browser's own dialog — which renders
 * outside the window chrome and looks like it belongs to a different app.
 */
export default function Confirm({
  title,
  danger,
  noEnter,
  onConfirm,
  onCancel,
}: {
  title: string;
  danger?: boolean;
  /** Enter does not confirm; the button has to be pressed. */
  noEnter?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => onEscapeLayer(onCancel), [onCancel]);

  useEffect(() => {
    if (noEnter) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") onConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onConfirm, noEnter]);

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
            autoFocus={!noEnter}
            onClick={onConfirm}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
