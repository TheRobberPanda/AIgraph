import { useCallback, useEffect, useMemo, useState } from "react";
import { listSessions, type SessionSummary } from "../lib/chat";
import ImportChat from "./ImportChat";
import { longDate } from "../lib/format";

/**
 * Every conversation, kept and re-readable.
 *
 * Filterable by subject and by text, because a list you can only scroll stops
 * being useful at about thirty entries and the whole point is to come back.
 */
export default function Chats({ onOpen }: { onOpen?: (sessionId: number) => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listSessions().then(setSessions).catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [sessions]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (tag && !s.tags.includes(tag)) return false;
      if (!q) return true;
      return (
        s.opening.toLowerCase().includes(q) ||
        s.tags.some((t) => t.includes(q)) ||
        longDate(s.started_at).toLowerCase().includes(q)
      );
    });
  }, [sessions, query, tag]);

  return (
    <div className="pane-inner">
      {error && <p className="error">{error}</p>}

      <div className="row filters">
        <input
          className="field filter-input"
          placeholder="Filter conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn" onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "Add a conversation"}
        </button>
      </div>

      {tags.length > 0 && (
        <div className="row tag-row">
          <button
            className={tag === null ? "btn on" : "btn"}
            onClick={() => setTag(null)}
          >
            All
          </button>
          {tags.map(([name, count]) => (
            <button
              key={name}
              className={tag === name ? "btn on" : "btn"}
              onClick={() => setTag(tag === name ? null : name)}
            >
              {name}
              <span className="row-meta">{count}</span>
            </button>
          ))}
        </div>
      )}

      {adding && (
        <ImportChat
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}

      {shown.length === 0 ? (
        <p className="empty">
          {sessions.length === 0 ? (
            <>
              <strong>Nothing kept yet.</strong>
              Conversations appear here once a session ends.
            </>
          ) : (
            <>No conversation matches that.</>
          )}
        </p>
      ) : (
        <ul className="list">
          {shown.map((s) => (
            <li key={s.id}>
              <button onClick={() => onOpen?.(s.id)} className="row-btn chat-row">
                <span className="row-main">
                  <span className="chat-open">{s.opening || "(nothing was said)"}</span>
                  <span className="chat-sub">
                    {longDate(s.started_at)} · {s.turn_count} turns ·{" "}
                    {s.idea_count > 0
                      ? `${s.idea_count} idea${s.idea_count === 1 ? "" : "s"}`
                      : s.extract_state === "done"
                        ? "no ideas"
                        : s.extract_state}
                    {s.tags.length > 0 && ` · ${s.tags.join(", ")}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
