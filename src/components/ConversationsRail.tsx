import { useCallback, useEffect, useState } from "react";
import {
  deleteSession,
  listSessions,
  renameSession,
  setSessionArchived,
  type SessionSummary,
} from "../lib/chat";
import { onIdeasChanged } from "../lib/ideas";
import { listFolders, ROOT_FOLDER, type Folder } from "../lib/folders";
import { longDate } from "../lib/format";
import { ConversationFile } from "./Deep";
import Sheet from "./Sheet";
import { IconArrowRight } from "./Icons";
import ContextMenu from "./ContextMenu";
import Confirm from "./Confirm";

/**
 * The folder's conversations, beside the one being had.
 *
 * The Think tab is where a folder is talked to, so its past is what sits next
 * to the present: every conversation filed here, one click to read it whole,
 * one to pick it back up and continue it. Scoped hard to the folder — a list
 * that quietly included a neighbouring folder's thinking would read as
 * something it is not.
 */
export default function ConversationsRail({
  folder,
  onContinue,
}: {
  folder: number | null;
  /** Pick an archived conversation back up as the live one. */
  onContinue: (sessionId: number) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Right-clicked, and where. */
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionSummary } | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  /** Archived ones are out of the way, not gone — one toggle brings them back. */
  const [showArchived, setShowArchived] = useState(false);

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

  const here = folders.find((f) => f.id === (folder ?? ROOT_FOLDER))?.name ?? "this folder";
  const shown = (sessions ?? []).filter((s) => s.archived === showArchived);
  const archivedCount = (sessions ?? []).filter((s) => s.archived).length;

  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="rail-title">{here}</span>
        {(archivedCount > 0 || showArchived) && (
          <button
            className={showArchived ? "rail-toggle on" : "rail-toggle"}
            data-tip={showArchived ? "Back to the current ones" : `${archivedCount} archived`}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "current" : "archived"}
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {sessions === null ? (
        <p className="muted rail-empty">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="muted rail-empty">Nothing here yet.</p>
      ) : (
        <ul className="rail-list">
          {shown.map((s) => (
            <li
              key={s.id}
              className="rail-item"
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, session: s });
              }}
            >
              {renaming?.id === s.id ? (
                <input
                  className="field rail-rename"
                  autoFocus
                  value={renaming.value}
                  onChange={(e) => setRenaming({ id: s.id, value: e.target.value })}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setRenaming(null);
                    if (e.key !== "Enter") return;
                    const name = renaming.value.trim();
                    setRenaming(null);
                    if (name) void renameSession(s.id, name).then(refresh).catch(() => {});
                  }}
                />
              ) : (
                <button className="rail-row" onClick={() => setOpen(s.id)}>
                  <span className="rail-name">{s.title || s.opening || `Conversation ${s.id}`}</span>
                  <span className="rail-meta">
                    {s.started_at ? longDate(s.started_at) : ""} · {s.turn_count} turns ·{" "}
                    {s.idea_count} {s.idea_count === 1 ? "idea" : "ideas"}
                  </span>
                </button>
              )}
              <button
                className="icon-btn rail-continue"
                data-tip="Continue this conversation"
                onClick={() => onContinue(s.id)}
              >
                <IconArrowRight />
              </button>
            </li>
          ))}
        </ul>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Rename",
              onSelect: () =>
                setRenaming({
                  id: menu.session.id,
                  value: menu.session.title || menu.session.opening,
                }),
            },
            {
              // Only ever appends, which is what makes it safe: the bytes
              // before the join do not move, so every quote already recorded
              // still points at the words it was taken from.
              label: "Continue this conversation",
              onSelect: () => onContinue(menu.session.id),
            },
            {
              label: menu.session.archived ? "Unarchive" : "Archive",
              onSelect: () =>
                setSessionArchived(menu.session.id, !menu.session.archived)
                  .then(refresh)
                  .catch((e) => setError(String(e))),
            },
            {
              label: "Delete",
              danger: true,
              onSelect: () => setDeleting(menu.session.id),
            },
          ]}
        />
      )}

      {deleting !== null && (
        <Confirm
          title="Delete this conversation?"
          danger
          onConfirm={() => {
            const id = deleting;
            setDeleting(null);
            deleteSession(id).then(refresh).catch((e) => setError(String(e)));
          }}
          onCancel={() => setDeleting(null)}
        />
      )}

      {open !== null && (
        <Sheet onClose={() => setOpen(null)}>
          <ConversationFile sessionId={open} onClose={() => setOpen(null)} />
        </Sheet>
      )}
    </aside>
  );
}
