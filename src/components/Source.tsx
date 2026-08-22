import { useEffect, useRef, useState } from "react";
import { sourceView, type Evidence, type SourceView } from "../lib/ideas";

/**
 * Click-to-source: the conversation as it happened, with the quote highlighted
 * in place.
 *
 * This is what makes the ideas checkable rather than merely plausible. A model
 * can restate you badly; seeing the surrounding conversation is how you catch it.
 */
export default function Source({
  evidence,
  claim,
  onClose,
}: {
  evidence: Evidence;
  claim: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<SourceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setView(null);
    setError(null);
    sourceView(evidence.id).then(setView).catch((e) => setError(String(e)));
  }, [evidence.id]);

  // Land on the quote rather than at the top of a long transcript.
  useEffect(() => {
    if (view) markRef.current?.scrollIntoView({ block: "center" });
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="source-backdrop" onClick={onClose}>
      <div className="source" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <div className="source-claim">{claim}</div>
            {view && (
              <div className="muted">
                Session {view.session_id} ·{" "}
                {new Date(view.started_at).toLocaleString()}
              </div>
            )}
          </div>
          <button className="done" onClick={onClose}>
            Close
          </button>
        </header>

        {error ? (
          // A wrong highlight would be worse than none, so this says so plainly
          // rather than rendering something approximate.
          <p className="error">
            This idea’s source could not be located in the transcript, so nothing
            is shown rather than risk highlighting the wrong words.
            <br />
            <span className="muted">{error}</span>
          </p>
        ) : !view ? (
          <p className="muted">Loading…</p>
        ) : (
          <pre className="transcript">
            {view.before}
            <mark ref={markRef}>{view.highlight}</mark>
            {view.after}
          </pre>
        )}
      </div>
    </div>
  );
}
