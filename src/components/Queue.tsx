import { useEffect, useState } from "react";
import { deleteSession, type SessionSummary } from "../lib/chat";
import { pendingSessions } from "../lib/ideas";
import { longDate } from "../lib/format";
import Confirm from "./Confirm";
import Sheet from "./Sheet";
import { IconTrash } from "./Icons";

/**
 * What is waiting to be read, and a way to say no to any of it.
 *
 * The count in the corner said how many and never which. Reading a
 * conversation costs minutes of a local model's time and produces ideas that
 * then have to be deleted one by one — so the cheap moment to decide a
 * conversation is not worth reading is before it is read, and that needs the
 * queue to be visible.
 */
export default function Queue({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<SessionSummary[] | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    pendingSessions()
      .then(setRows)
      .catch((e) => setError(String(e)));

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <Sheet onClose={onClose}>
      <div className="pane-inner">
        <header className="head">
          <button className="btn" onClick={onClose}>
            ← Back
          </button>
          <span className="muted">
            {rows === null
              ? "Loading…"
              : `${rows.length} waiting to be read`}
          </span>
        </header>

        {error && <p className="error">{error}</p>}

        {rows !== null && rows.length === 0 ? (
          <p className="empty">Nothing waiting.</p>
        ) : (
          <ul className="list">
            {(rows ?? []).map((s) => (
              <li key={s.id} className="chat-line">
                <span className="row-btn">
                  <span className="row-main">
                    {s.title || s.opening || `Conversation ${s.id}`}
                  </span>
                  <span className="row-meta">
                    {s.started_at ? longDate(s.started_at) : ""} · {s.turn_count} turns
                  </span>
                </span>
                <span className="chat-actions">
                  <button
                    className="icon-btn"
                    data-tip="Delete it rather than read it"
                    onClick={() => setDeleting(s.id)}
                  >
                    <IconTrash />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="blurb">
          Deleting one here removes the conversation itself, not just its place
          in the queue — there is no way to keep a conversation and refuse to
          read it, because an unread conversation is what this list is.
        </p>
      </div>

      {deleting !== null && (
        <Confirm
          title="Delete this conversation?"
          danger
          onConfirm={() => {
            const id = deleting;
            setDeleting(null);
            deleteSession(id)
              .then(refresh)
              .then(onChanged)
              .catch((e) => setError(String(e)));
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </Sheet>
  );
}
