import { useEffect, useState } from "react";
import Markdown from "./Markdown";
import { dateTime, plainDate } from "../lib/format";
import {
  conversationView,
  ideaView,
  revertRevision,
  type ConversationView,
  type IdeaView,
} from "../lib/views";

/**
 * The model's read on something.
 *
 * Split under two headings rather than run together: the whole point is to push
 * the thinking on, and "where this is thin" is the half that does that work. Six
 * undifferentiated bullets bury it.
 */
function Nudges({ strong, weak }: { strong: string[]; weak: string[] }) {
  if (!strong.length && !weak.length) return null;
  return (
    <div className="deep-nudges">
      {strong.length > 0 && (
        <section>
          <h3 className="deep-section">Where it holds</h3>
          <div className="nudges">
            {strong.map((t, i) => (
              <p key={i} className="nudge strong">
                <span className="badge">AI</span>
                {t}
              </p>
            ))}
          </div>
        </section>
      )}
      {weak.length > 0 && (
        <section>
          <h3 className="deep-section">Where it’s thin</h3>
          <div className="nudges">
            {weak.map((t, i) => (
              <p key={i} className="nudge weak">
                <span className="badge">AI</span>
                {t}
              </p>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * A conversation's file.
 *
 * The transcript as it happened, with the words that produced ideas highlighted
 * in place — only ever the human's words. Hovering a highlight shows *why* the
 * model read those words as that claim, which is what makes the extraction
 * inspectable rather than something you have to take on faith.
 */
export function ConversationFile({
  sessionId,
  onOpenIdea,
  onClose,
}: {
  sessionId: number;
  onOpenIdea: (id: number) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<ConversationView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(null);
    conversationView(sessionId).then(setView).catch((e) => setError(String(e)));
  }, [sessionId]);

  return (
    <div className="deep">
      <header className="deep-head">
        <button className="done" onClick={onClose}>← Back</button>
        {view && (
          <span className="muted">
            {dateTime(view.started_at)} · {view.model}
          </span>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {!view ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <Nudges strong={view.strong} weak={view.weak} />

          <div className="deep-transcript">
            {view.turns.map((turn) =>
              turn.role === "user" ? (
                // Your words, verbatim, with what the model took from them
                // marked in place.
                <p key={turn.id} className="turn user">
                  {turn.segments.map((seg, i) =>
                    seg.idea_id === null ? (
                      <span key={i}>{seg.text}</span>
                    ) : (
                      <mark
                        key={i}
                        className="extracted"
                        onClick={() => seg.idea_id && onOpenIdea(seg.idea_id)}
                        title="Open this idea"
                      >
                        {seg.text}
                        <span className="why">
                          <strong>{seg.claim}</strong>
                          {seg.reasoning && <em>{seg.reasoning}</em>}
                        </span>
                      </mark>
                    ),
                  )}
                </p>
              ) : (
                // The model's reply. Rendered as markdown and set quieter — it
                // is context for your thinking, not the subject of the page.
                <div key={turn.id} className="turn assistant">
                  <Markdown>{turn.segments.map((s) => s.text).join("")}</Markdown>
                </div>
              ),
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** An idea's file: everything supporting it, and how it has changed. */
export function IdeaFile({
  ideaId,
  onOpenConversation,
  onClose,
}: {
  ideaId: number;
  onOpenConversation: (id: number) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<IdeaView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => ideaView(ideaId).then(setView).catch((e) => setError(String(e)));
  useEffect(() => {
    setView(null);
    void load();
  }, [ideaId]);

  return (
    <div className="deep">
      <header className="deep-head">
        <button className="done" onClick={onClose}>← Back</button>
        {view && view.evidence.length > 1 && (
          <span className="muted">
            said across {new Set(view.evidence.map((e) => e.session_id)).size} conversations
          </span>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {!view ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <h2 className="deep-claim">{view.claim}</h2>
          <Nudges strong={view.strong} weak={view.weak} />

          <h3 className="deep-section">Where you said it</h3>
          {view.evidence.map((e) => (
            <div key={e.id} className="evidence">
              <blockquote>
                “{e.quote}”
                {e.normalized && <span className="tag">loose match</span>}
              </blockquote>
              {e.reasoning && <p className="why-inline">{e.reasoning}</p>}
              <button className="evidence-link" onClick={() => onOpenConversation(e.session_id)}>
                {plainDate(e.started_at)} — open the conversation →
              </button>
            </div>
          ))}

          {view.revisions.length > 0 && (
            <>
              <h3 className="deep-section">How it changed</h3>
              {view.revisions.map((r) => (
                <div key={r.id} className="revision">
                  <p className="was">was: “{r.prev_claim}”</p>
                  <p className="muted">
                    rewritten {plainDate(r.created_at)} ·{" "}
                    {(r.confidence * 100).toFixed(0)}% confident
                    {r.reverted_at && " · reverted"}
                  </p>
                  {!r.reverted_at && (
                    // Rewriting is the only thing here that can destroy
                    // something you wrote, so undoing it stays one click away.
                    <button
                      className="done"
                      onClick={() => revertRevision(r.id).then(load).catch((e) => setError(String(e)))}
                    >
                      Restore this wording
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
