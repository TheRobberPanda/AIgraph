import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteSession,
  listSessions,
  renameSession,
  setSessionArchived,
  type SessionSummary,
} from "../lib/chat";
import { onIdeasChanged, reextractSession } from "../lib/ideas";
import { useRememberedOpen } from "../lib/remembered";
import { listFolders, ROOT_FOLDER, type Folder } from "../lib/folders";
import { longDate } from "../lib/format";
import { repeatedAmong } from "../lib/similarity";
import { ConversationFile } from "./Deep";
import Sheet from "./Sheet";
import MoveTo from "./MoveTo";
import { IconArrowRight, IconBook, IconChevron } from "./Icons";
import ContextMenu from "./ContextMenu";
import Confirm from "./Confirm";
import { isImportConversation } from "../lib/import";

/** Not read for ideas yet: waiting, or being read now. */
function isUnread(s: SessionSummary): boolean {
  return !s.archived && (s.extract_state === "pending" || s.extract_state === "extracting");
}

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
  action,
  onContinue,
}: {
  folder: number | null;
  /** Sits in the head beside the folder's name — the Read button. */
  action?: React.ReactNode;
  /** Pick an archived conversation back up as the live one. */
  onContinue: (sessionId: number) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  /** Whether the open conversation was reached from the repeat warning, so its
   *  file can say so and offer to delete it. */
  const [openRepeat, setOpenRepeat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Right-clicked, and where. */
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionSummary } | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  /** A bulk delete of everything with no ideas, waiting on confirmation. */
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  /** The conversation being filed somewhere else, or somewhere new. */
  const [moving, setMoving] = useState<number | null>(null);
  /** Archived ones are out of the way, not gone — one toggle brings them back. */
  const [showArchived, setShowArchived] = useState(false);
  /** Which sections are unfolded, remembered between visits and restarts. */
  const [unreadOpen, toggleUnread] = useRememberedOpen("rail.unreadOpen");
  const [restOpen, toggleRest] = useRememberedOpen("rail.restOpen");

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
  // Conversations that are likely the same thinking said twice, so the rail can
  // point from one to the other.
  const repeats = useMemo(
    () =>
      repeatedAmong(
        sessions ?? [],
        (s) => s.id,
        (s) => `${s.title} ${s.opening}`,
        0.6,
      ),
    [sessions],
  );
  // Conversations that produced nothing. Worth clearing in one go, since they
  // are clutter that costs a read each to find out nothing was in them.
  const emptyOnes = shown.filter((s) => s.idea_count === 0 && !isUnread(s));
  // Not read yet goes first and on its own: "0 ideas" on one of these means
  // nobody has looked, not that nothing was there. The archived view is
  // one list, as before.
  const unread = showArchived ? [] : shown.filter(isUnread);
  const rest = showArchived ? shown : shown.filter((s) => !isUnread(s));
  const sections = [
    {
      key: "unread",
      list: unread,
      open: unreadOpen,
      head: (
        <button className="rail-section-head" aria-expanded={unreadOpen} onClick={toggleUnread}>
          <IconChevron className={unreadOpen ? "flip" : undefined} />
          Not read yet ({unread.length})
        </button>
      ),
    },
    {
      key: "rest",
      list: rest,
      // Alone, it has no heading to unfold it by, so it cannot stay folded.
      open: restOpen || unread.length === 0,
      head:
        unread.length > 0 ? (
          <button className="rail-section-head" aria-expanded={restOpen} onClick={toggleRest}>
            <IconChevron className={restOpen ? "flip" : undefined} />
            Conversations ({rest.length})
          </button>
        ) : null,
    },
  ].filter((sec) => sec.list.length > 0);

  async function deleteEmpty() {
    setConfirmEmpty(false);
    try {
      for (const s of emptyOnes) await deleteSession(s.id);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="rail-title">{here}</span>
        {action}
        {emptyOnes.length > 0 && (
          <button
            className="rail-toggle rail-clear"
            data-tip={`Delete the ${emptyOnes.length} conversation${
              emptyOnes.length === 1 ? "" : "s"
            } here with no ideas`}
            onClick={() => setConfirmEmpty(true)}
          >
            no ideas ({emptyOnes.length})
          </button>
        )}
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
        sections.map((sec) => (
          <div key={sec.key} className="rail-section">
            {sec.head}
            {sec.open && (
        <ul className="rail-list">
          {sec.list.map((s) => (
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
                <button
                  className={isImportConversation(s.model) ? "rail-row imported" : "rail-row"}
                  onClick={() => {
                    setOpenRepeat(false);
                    setOpen(s.id);
                  }}
                >
                  <span className="rail-name">
                    {isImportConversation(s.model) && (
                      <span className="rail-import-mark" data-tip="Imported — a document or transcript brought in, not a conversation that was lived">
                        <IconBook />
                      </span>
                    )}
                    {s.title || s.opening || `Conversation ${s.id}`}
                  </span>
                  <span className="rail-meta">
                    {s.started_at ? longDate(s.started_at) : ""} · {s.turn_count} turns ·{" "}
                    {/* "0 ideas" on one nobody has read yet reads as a
                        verdict that nothing was in it. */}
                    {isUnread(s) ? (
                      <span className="rail-ideas">not read yet</span>
                    ) : (
                      <span className={s.idea_count === 0 ? "rail-ideas none" : "rail-ideas"}>
                        {s.idea_count} {s.idea_count === 1 ? "idea" : "ideas"}
                      </span>
                    )}
                  </span>
                </button>
              )}
              {repeats.has(s.id) && (
                <button
                  type="button"
                  className="repeat-mark"
                  data-tip="You likely repeated this conversation somewhere — click to go there"
                  aria-label="Likely repeated elsewhere"
                  onClick={() => {
                    setOpenRepeat(true);
                    setOpen(repeats.get(s.id)!);
                  }}
                >
                  !
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
          </div>
        ))
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
              // Read it again from scratch: useful when the extraction prompt
              // has changed, or a read went badly. Existing ideas are archived
              // rather than lost, and the ones this still supports come back.
              label: "Read it again",
              onSelect: () =>
                void reextractSession(menu.session.id).then(refresh).catch((e) => setError(String(e))),
            },
            {
              label: menu.session.archived ? "Unarchive" : "Archive",
              onSelect: () =>
                setSessionArchived(menu.session.id, !menu.session.archived)
                  .then(refresh)
                  .catch((e) => setError(String(e))),
            },
            {
              // File it in another folder, or a new one made on the spot.
              label: "Move to folder…",
              onSelect: () => setMoving(menu.session.id),
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
          title="Move this conversation to the trash?"
          danger
          onConfirm={() => {
            const id = deleting;
            setDeleting(null);
            deleteSession(id).then(refresh).catch((e) => setError(String(e)));
          }}
          onCancel={() => setDeleting(null)}
        />
      )}

      {confirmEmpty && (
        <Confirm
          title={`Move ${emptyOnes.length} conversation${
            emptyOnes.length === 1 ? "" : "s"
          } with no ideas to the trash?`}
          danger
          onConfirm={() => void deleteEmpty()}
          onCancel={() => setConfirmEmpty(false)}
        />
      )}

      {moving !== null && (
        <MoveTo
          sessionId={moving}
          onDone={refresh}
          onClose={() => setMoving(null)}
        />
      )}

      {open !== null && (
        <Sheet
          onClose={() => {
            setOpen(null);
            setOpenRepeat(false);
          }}
        >
          {openRepeat && (
            <div className="repeat-banner">
              <span className="repeat-banner-text">
                <strong>Likely repeated.</strong> This reads like something already filed — delete
                it if it was said twice.
              </span>
              <button
                className="btn danger"
                onClick={() => {
                  const id = open;
                  setOpen(null);
                  setOpenRepeat(false);
                  deleteSession(id).then(refresh).catch((e) => setError(String(e)));
                }}
              >
                Delete
              </button>
            </div>
          )}
          <ConversationFile
            sessionId={open}
            unread={(() => {
              const s = sessions?.find((x) => x.id === open);
              return s ? isUnread(s) : false;
            })()}
            onRead={refresh}
            repeatWarning={openRepeat}
            onClose={() => {
              setOpen(null);
              setOpenRepeat(false);
            }}
          />
        </Sheet>
      )}
    </aside>
  );
}
