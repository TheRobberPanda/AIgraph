import { useEffect, useMemo, useState } from "react";
import { listDefinitions, removeDefinition, type Definition } from "../lib/definitions";
import { onIdeasChanged } from "../lib/ideas";
import { longDate } from "../lib/format";
import Confirm from "./Confirm";
import { IconTrash } from "./Icons";

/**
 * What the person has said their words mean.
 *
 * Found by the same read that finds ideas: when a conversation is digested,
 * anywhere the person pinned down what they mean by a word is kept here, with
 * the words they said it in. A term defined more than once shows every
 * version, newest first — a meaning that shifted is worth seeing shift.
 */
export default function Definitions({
  folder,
  onOpenConversation,
}: {
  folder: number | null;
  onOpenConversation: (sessionId: number) => void;
}) {
  const [rows, setRows] = useState<Definition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<Definition | null>(null);

  useEffect(() => {
    const refresh = () =>
      listDefinitions(folder)
        .then(setRows)
        .catch((e) => setError(String(e)));
    void refresh();
    // A read that finishes while this is open adds to it.
    const off = onIdeasChanged(() => void refresh());
    return () => {
      void off.then((un) => un());
    };
  }, [folder]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = rows ?? [];
    const hit = q
      ? all.filter((d) => d.term.toLowerCase().includes(q) || d.definition.toLowerCase().includes(q))
      : all;
    return [...hit].sort(
      (a, b) =>
        a.term.localeCompare(b.term, undefined, { sensitivity: "base" }) ||
        b.started_at.localeCompare(a.started_at),
    );
  }, [rows, query]);

  return (
    <div className="pane-inner">
      <header className="head">
        <h1>Definitions</h1>
        <span className="muted">
          {rows === null ? "Loading…" : `${rows.length} ${rows.length === 1 ? "term" : "terms"}`}
        </span>
      </header>

      {error && <p className="error">{error}</p>}

      {rows !== null && rows.length > 0 && (
        <input
          className="defs-search"
          placeholder="Find a term"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {rows !== null && rows.length === 0 ? (
        <p className="empty">
          Nothing yet. When you say what you mean by a word — “by freedom I mean…” — reading the
          conversation back keeps it here.
        </p>
      ) : (
        <div>
          {shown.map((d) => (
            <div key={d.id} className="def-item">
              <div className="def-head">
                <span className="def-term">{d.term}</span>
                <button
                  className="icon-btn"
                  data-tip="Take it off the list"
                  onClick={() => setRemoving(d)}
                >
                  <IconTrash />
                </button>
              </div>
              <p className="def-text">{d.definition}</p>
              <button
                className="def-quote"
                data-tip="Open the conversation"
                onClick={() => onOpenConversation(d.session_id)}
              >
                “{d.quote}”
              </button>
              <div className="def-meta">
                {d.session_title || `Conversation ${d.session_id}`}
                {d.started_at && ` · ${longDate(d.started_at)}`}
              </div>
            </div>
          ))}
          {rows !== null && rows.length > 0 && shown.length === 0 && (
            <p className="empty">No term matches “{query}”.</p>
          )}
        </div>
      )}

      {removing && (
        <Confirm
          title={`Take “${removing.term}” off the list?`}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const id = removing.id;
            setRemoving(null);
            void removeDefinition(id)
              .then(() => setRows((r) => (r ?? []).filter((x) => x.id !== id)))
              .catch((e) => setError(String(e)));
          }}
        />
      )}
    </div>
  );
}
