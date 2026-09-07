import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { listSessions, type SessionSummary } from "../lib/chat";
import { exportBook, onIdeasChanged, type BookFormat } from "../lib/ideas";
import { listFolders, ROOT_FOLDER, type Folder } from "../lib/folders";
import { longDate } from "../lib/format";
import { ConversationFile } from "./Deep";
import Sheet from "./Sheet";
import { IconBook } from "./Icons";

/** What a folder can be turned into, and why you would want each. */
const MEDIA: { format: BookFormat; extension: string; name: string; blurb: string }[] = [
  {
    format: "pdf",
    extension: "pdf",
    name: "A book",
    blurb: "Typeset: contents, the ideas by subject, and a conclusion. For handing to someone.",
  },
  {
    format: "markdown",
    extension: "md",
    name: "A book, as Markdown",
    blurb: "The same book as plain text, to paste into whatever you already write in.",
  },
];

/**
 * Everything said in one folder, and what it can become.
 *
 * The ideas list is about what was *taken out* of these conversations; this is
 * the conversations themselves, which is the other thing you come looking for
 * — and the honest place to put "turn this into something", because what gets
 * turned into a book is the folder, not any one idea in it.
 *
 * Scoped hard to the folder. A list that quietly included a neighbouring
 * folder's thinking would produce a book with someone else's argument in it.
 */
export default function Conversations({ folder }: { folder: number | null }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listSessions(folder)
      .then(setSessions)
      .catch((e) => setError(String(e)));
    void listFolders().then(setFolders);
  }, [folder]);

  useEffect(() => {
    setSessions(null);
    refresh();
  }, [refresh]);

  // A conversation that has just been read gains its ideas, and the count on
  // its line goes stale unless this hears about it.
  useEffect(() => {
    const p = onIdeasChanged(refresh);
    return () => {
      void p.then((un) => un());
    };
  }, [refresh]);

  const here = folders.find((f) => f.id === (folder ?? ROOT_FOLDER))?.name ?? "Ideas";
  const shown = (sessions ?? []).filter((s) => !s.archived);

  async function turnInto(media: (typeof MEDIA)[number]) {
    setMenu(false);
    setNote(null);
    setError(null);
    const path = await save({
      title: `Save ${here} as ${media.name.toLowerCase()}`,
      defaultPath: `${here.replace(/[/\\?%*:|"<>]/g, "-")}.${media.extension}`,
      filters: [{ name: media.name, extensions: [media.extension] }],
    });
    if (!path) return;

    setBusy(true);
    try {
      const done = await exportBook(folder, path, media.format);
      setNote(
        `${done.ideas} ideas across ${done.chapters} chapters — saved to ${done.path}.` +
          (done.note ? ` ${done.note}` : ""),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pane-inner">
      <div className="row filters">
        <span className="row-main">
          <strong>{shown.length}</strong>{" "}
          {shown.length === 1 ? "conversation" : "conversations"} in {here}
        </span>

        <span className="menu-anchor">
          <button
            className={busy ? "btn busy" : menu ? "btn on" : "btn"}
            disabled={busy || shown.length === 0}
            data-tip={
              shown.length === 0
                ? "Nothing here to turn into anything yet"
                : "Turn this folder into something you can keep"
            }
            onClick={() => setMenu((m) => !m)}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : <IconBook />}
            {busy ? "Writing…" : "Turn this into…"}
          </button>

          {menu && (
            // Closed by choosing, or by pressing the button again. The wash
            // behind it catches a click anywhere else, so it never gets
            // stranded open over the list.
            <>
              <span className="menu-wash" onClick={() => setMenu(false)} />
              <ul className="media-list">
                {MEDIA.map((m) => (
                  <li key={m.format}>
                    <button className="pick-option media-option" onClick={() => void turnInto(m)}>
                      <span className="media-name">{m.name}</span>
                      <span className="media-blurb">{m.blurb}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </span>
      </div>

      {error && <p className="error">{error}</p>}
      {note && <p className="blurb">{note}</p>}

      {sessions === null ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="empty">Nothing has been said in {here} yet.</p>
      ) : (
        <ul className="list">
          {shown.map((s) => (
            <li key={s.id} className="chat-line">
              <button className="row-btn" onClick={() => setOpen(s.id)}>
                <span className="row-main">
                  {s.title || s.opening || `Conversation ${s.id}`}
                </span>
                <span className="row-meta">
                  {s.started_at ? longDate(s.started_at) : ""} · {s.turn_count} turns ·{" "}
                  {s.idea_count} {s.idea_count === 1 ? "idea" : "ideas"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open !== null && (
        <Sheet onClose={() => setOpen(null)}>
          <ConversationFile sessionId={open} onClose={() => setOpen(null)} />
        </Sheet>
      )}
    </div>
  );
}
