import { useCallback, useEffect, useState } from "react";
import { listSessions, type SessionSummary } from "../lib/chat";
import ImportChat from "./ImportChat";
import Markdown from "./Markdown";
import { dateTime, longDate } from "../lib/format";
import { sessionTurns, type StoredTurn } from "../lib/sessions";

/**
 * Every conversation you've had, kept and re-readable.
 *
 * The chat itself clears when a session ends — the map is the product — but
 * nothing is thrown away. This is where you go back in.
 */
export default function Chats({ onOpen }: { onOpen?: (sessionId: number) => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [turns, setTurns] = useState<StoredTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(() => {
    listSessions().then(setSessions).catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (open === null) return;
    setTurns([]);
    sessionTurns(open).then(setTurns).catch((e) => setError(String(e)));
  }, [open]);

  if (open !== null) {
    const session = sessions.find((s) => s.id === open);
    return (
      <div className="pane-inner">
        <header className="head">
          <button className="btn" onClick={() => setOpen(null)}>
            ← All chats
          </button>
          {session && (
            <span className="muted">
              {dateTime(session.started_at)} · {session.model}
            </span>
          )}
        </header>

        <div className="deep-transcript">
          {turns.map((t) => (
            <div key={t.id} className={`turn ${t.role}`}>
              {t.role === "assistant" ? <Markdown>{t.text}</Markdown> : t.text}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="pane-inner">
      {error && <p className="error">{error}</p>}

      <div className="row">
        <button className="btn" onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "Add a conversation"}
        </button>
      </div>

      {adding && (
        <ImportChat
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}

      {sessions.length === 0 ? (
        <p className="empty">
          No conversations yet. Anything you say is kept here once you press Done.
        </p>
      ) : (
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id}>
              <button onClick={() => (onOpen ? onOpen(s.id) : setOpen(s.id))}>
                <span className="row-meta">{longDate(s.started_at)}</span>
                <span className="row-main">{s.opening || "(nothing was said)"}</span>
                <span className="row-meta">
                  {/* Ideas first: the reason to go back to a conversation is
                      what came out of it, not how long it was. */}
                  {s.idea_count > 0
                    ? `${s.idea_count} idea${s.idea_count === 1 ? "" : "s"}`
                    : s.extract_state === "done"
                      ? "no ideas found"
                      : s.extract_state}
                  {" · "}
                  {s.turn_count} turns
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
