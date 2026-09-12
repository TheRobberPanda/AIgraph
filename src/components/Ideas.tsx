import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteSession,
  listSessions,
  renameSession,
  setSessionArchived,
  type SessionSummary,
} from "../lib/chat";
import ContextMenu from "./ContextMenu";
import Confirm from "./Confirm";
import MoveTo from "./MoveTo";
import Sheet from "./Sheet";
import { IconArchive, IconPlus, IconRewind, IconTrash } from "./Icons";
import ImportChat from "./ImportChat";
import Trash from "./Trash";
import { ConversationFile, IdeaFile } from "./Deep";
import { categoryColor } from "../lib/categories";
import { ROOT_FOLDER } from "../lib/folders";
import { longDate } from "../lib/format";
import { repeatedAmong } from "../lib/similarity";
import {
  extractionProgress,
  listIdeas,
  reextractSession,
  onExtractionProgress,
  onIdeasChanged,
  type ExtractionProgress,
  type Evidence,
  type Idea,
  type Phase,
} from "../lib/ideas";

/** A glanceable label; the full text is still there on hover. */
function shortTitle(text: string, max = 56): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).trimEnd() + "…";
}

const PHASE_LABELS: Record<Phase, string> = {
  asking: "reading the conversation",
  verifying: "checking quotes against what was said",
  retrying: "some quotes didn’t match — asking again",
  saving: "saving",
};

function elapsed(since: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** A duration, in the units it is actually worth reading in. */
function minutes(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** How many separate conversations support this idea. */
function sessionsFor(idea: Idea): number {
  return new Set(idea.evidence.map((e) => e.session_id)).size;
}

/**
 * A plain list of extracted ideas.
 *
 * Placeholder for the graph (milestone 6) — but a useful one: it shows the
 * claim, the exact words it came from, and the nudges, which is everything the
 * graph will need to be trustworthy. Getting this right first means the graph
 * is a rendering problem rather than a correctness one.
 */
export default function Ideas({
  folder,
  onContinue,
}: {
  folder: number | null;
  /** Picking a conversation back up makes it the live one, which the app has
   *  to switch to — so it is handled above rather than here. */
  onContinue?: (sessionId: number) => void;
}) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // Which conversations are open. Was the inverse — a set of closed ones —
  // which meant anything newly extracted arrived expanded and the list grew
  // unreadable on its own.
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const [panel, setPanel] = useState<{
    kind: "idea" | "conversation";
    id: number;
    /** For a conversation opened from a citation: which idea's words to flash. */
    flash?: number;
  } | null>(null);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionSummary } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  /** Subjects being shown. Empty means all of them — the same toggle the map's
   *  legend uses, so a subject is picked out the same way in both places. */
  const [subjects, setSubjects] = useState<Set<string>>(new Set());
  /** Carried over from the conversations list, which this replaced. */
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [binOpen, setBinOpen] = useState(false);
  /** Conversations that were read and yielded nothing are kept out of the way
   *  rather than gone — this is the drawer they wait in. */
  const [showEmpty, setShowEmpty] = useState(false);
  // Re-renders once a second purely so the elapsed counter advances between
  // phase events — which can be minutes apart on a local model.
  const [, tick] = useState(0);

  const refresh = useCallback(() => {
    void listIdeas(folder).then(setIdeas).catch(() => {});
    void listSessions(folder).then(setSessions).catch(() => {});
  }, [folder]);

  /**
   * Group ideas under the conversation that first produced them.
   *
   * An idea returned to in a later conversation still lives under the one
   * where it was first said — that conversation is where the thought started,
   * and repeating it under every conversation that touched it would turn one
   * idea into several list entries.
   */
  /** Every subject in view, commonest first, so the filter is ordered by how
   *  much of the list each one accounts for. */
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of ideas) {
      if (!i.category) continue;
      counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [ideas]);

  const shown = useMemo(
    () => (subjects.size === 0 ? ideas : ideas.filter((i) => subjects.has(i.category))),
    [ideas, subjects],
  );

  // Where a thought is likely the same one said twice. Ideas are matched on
  // their claim and title; conversations on their title and opening. The map
  // is id -> the id of its closest match, when there is one worth pointing at.
  const ideaRepeats = useMemo(
    () => repeatedAmong(shown, (i) => i.id, (i) => `${i.title} ${i.claim}`, 0.62),
    [shown],
  );
  const sessionRepeats = useMemo(
    () => repeatedAmong(sessions, (s) => s.id, (s) => `${s.title} ${s.opening}`, 0.6),
    [sessions],
  );

  const groups = useMemo(() => {
    const bySession = new Map<number, Idea[]>();
    const orphaned: Idea[] = [];
    // Which conversations are archived, so the grouping can tell the
    // conversation an idea was first said in from the one still keeping it.
    const archived = new Set(sessions.filter((s) => s.archived).map((s) => s.id));
    const earliest = (evidence: Evidence[]) =>
      evidence.reduce<Evidence | null>((min, e) => (min === null || e.id < min.id ? e : min), null);
    for (const idea of shown) {
      // In the archive view an idea hangs under the conversation that first
      // said it, archived or not. In the current view one whose first saying
      // was archived hangs under the first conversation still keeping it —
      // the archive is out of the way, and an idea alive through a current
      // conversation is that conversation's to show.
      const first =
        showArchived
          ? earliest(idea.evidence)
          : (earliest(idea.evidence.filter((e) => !archived.has(e.session_id))) ??
            earliest(idea.evidence));
      if (first === null) {
        orphaned.push(idea);
        continue;
      }
      const list = bySession.get(first.session_id) ?? [];
      list.push(idea);
      bySession.set(first.session_id, list);
    }

    const q = query.trim().toLowerCase();
    const visible = sessions.filter(
      (s) =>
        s.archived === showArchived &&
        (!q ||
          (s.title || "").toLowerCase().includes(q) ||
          (s.opening || "").toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q))),
    );
    const known = new Set(visible.map((s) => s.id));
    const rows = visible
      // The current view hangs ideas under the conversations they came from,
      // so a conversation with nothing filed under it is not on it. The
      // archive view is the conversations themselves — out of the way, not
      // gone — so every archived one is listed, with what the list still
      // carries under the ones that carry any.
      .filter((s) => showArchived || bySession.has(s.id))
      .map((s) => ({ session: s, ideas: bySession.get(s.id) ?? [] }));

    // A session not yet in the list (still extracting) still gets a home,
    // rather than losing its ideas until the list catches up. The current
    // view only, and never for an archived conversation: the fallback row is
    // a current conversation by definition, and without that guard the
    // archive filled with the current ones — deleting from the archive then
    // deleted conversations that were never archived.
    if (!showArchived) {
      for (const [id, list] of bySession) {
        if (known.has(id) || archived.has(id)) continue;
        rows.push({
          session: {
            id,
            started_at: "",
            ended_at: null,
            md_path: null,
            model: "",
            extract_state: "done",
            turn_count: 0,
            idea_count: list.length,
            tags: [],
            opening: "",
            title: "",
            archived: false,
            folder_id: ROOT_FOLDER,
          },
          ideas: list,
        });
      }
    }
    // Conversations that came out with nothing filed under them. In the
    // current view only — the archive is the conversations themselves, so
    // there they are already listed — and only ones the filter keeps, so the
    // drawer narrows with the list above it.
    const empty = visible.filter((s) => !bySession.has(s.id));

    // One folder is shown at a time, so the list is flat: no folder headings,
    // and no group for a conversation filed elsewhere. This tab is the folder
    // it is scoped to, and nothing outside it belongs on the page.
    return { rows, orphaned, empty };
  }, [shown, sessions, query, showArchived]);

  function toggle(sessionId: number) {
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  // Opened as a panel over the list rather than a page of its own — clicking
  // the same idea again closes it, clicking another swaps the panel's content.
  function openIdea(id: number) {
    setPanel((p) => (p?.kind === "idea" && p.id === id ? null : { kind: "idea", id }));
  }
  /** `flash` is the idea whose words to go to and pulse, when this was
   *  reached by clicking that idea's quote. */
  function openConversation(id: number, flash?: number) {
    setPanel((p) =>
      p?.kind === "conversation" && p.id === id && flash === undefined
        ? null
        : { kind: "conversation", id, flash },
    );
  }

  useEffect(() => {
    refresh();
    void extractionProgress().then(setProgress);
    const subs = [onIdeasChanged(refresh), onExtractionProgress(setProgress)];
    return () => {
      subs.forEach((p) => void p.then((un) => un()));
    };
  }, [refresh]);

  const running = progress?.running ?? null;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <div className="split">
    <div className="split-main">
    <div className="pane-inner">
      {(running || progress?.last?.error) && (
      <div className="diag">
        {running ? (
          <div className="row">
            <span className="spinner" aria-hidden="true" />
            <span>{PHASE_LABELS[running.phase]}</span>
            <span className="muted">{elapsed(running.started_at)}</span>
          </div>
        ) : (
          progress?.last?.error && (
            <p className="blurb">
              <span className="error">
                Session {progress.last.session_id} failed: {progress.last.error}
              </span>
            </p>
          )
        )}
      </div>
      )}

      {/* What the last read cost, kept on screen after it finishes. A digest
          that took four minutes is a complaint; 6,200 tokens read at 41/s and
          900 written at 3/s is something that can be acted on. */}
      {progress?.last && !running && (
      <div className="diag">
        <span className="muted">last read</span>
        <span>
          <strong>{minutes(progress.last.seconds)}</strong>
        </span>
        {progress.last.retried && <span className="muted">read twice</span>}
        {progress.last.cost?.calls > 0 && (
          <>
            <span>
              {progress.last.cost.read_tokens.toLocaleString()} in
              {progress.last.read_per_second != null &&
                ` · ${Math.round(progress.last.read_per_second)} tok/s`}
            </span>
            <span>
              {progress.last.cost.wrote_tokens.toLocaleString()} out
              {progress.last.wrote_per_second != null &&
                ` · ${Math.round(progress.last.wrote_per_second)} tok/s`}
            </span>
          </>
        )}
      </div>
      )}

      <div className="row filters">
        <input
          className="field filter-input"
          placeholder="Filter conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={adding ? "icon-btn on" : "icon-btn"}
          data-tip={adding ? "Cancel" : "Add a conversation"}
          onClick={() => setAdding((a) => !a)}
        >
          <IconPlus />
        </button>
        <button
          className={showArchived ? "icon-btn on" : "icon-btn"}
          data-tip={showArchived ? "Showing archived" : "Show archived"}
          onClick={() => setShowArchived((a) => !a)}
        >
          <IconArchive />
        </button>
        <button
          className={binOpen ? "icon-btn on" : "icon-btn"}
          data-tip="The trash"
          onClick={() => setBinOpen((b) => !b)}
        >
          <IconTrash />
        </button>
      </div>

      {adding && <ImportChat onDone={() => { setAdding(false); refresh(); }} />}

      {binOpen && <Trash onClose={() => setBinOpen(false)} onChanged={refresh} />}

      {tags.length > 1 && (
        <div className="tag-filter">
          {tags.map(([name, n]) => (
            <button
              type="button"
              key={name}
              className={subjects.has(name) ? "on" : undefined}
              aria-pressed={subjects.has(name)}
              onClick={() =>
                setSubjects((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(name)) next.add(name);
                  return next;
                })
              }
            >
              <i style={{ background: categoryColor(name) }} /> {name}
              <span className="row-meta">{n}</span>
            </button>
          ))}
          {subjects.size > 0 && (
            <button type="button" className="tag-filter-clear" onClick={() => setSubjects(new Set())}>
              Show all
            </button>
          )}
        </div>
      )}

      {ideas.length === 0 && !showArchived ? (
        <p className="empty">No ideas yet.</p>
      ) : shown.length === 0 ? (
        <p className="empty">Nothing filed under that subject.</p>
      ) : groups.rows.length === 0 && groups.orphaned.length === 0 ? (
        <p className="empty">{showArchived ? "Nothing archived here." : "Nothing here yet."}</p>
      ) : (
        <div className="tree">
          {groups.rows.map(({ session, ideas: sessionIdeas }) => {
            const isCollapsed = !opened.has(session.id);
            const label = session.title || session.opening || `Conversation ${session.id}`;
            return (
              <div key={session.id} className="tree-group">
                {renaming?.id === session.id ? (
                  <form
                    className="tree-head"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const title = renaming.value.trim();
                      setRenaming(null);
                      if (!title) return;
                      renameSession(session.id, title).then(refresh).catch(() => {});
                    }}
                  >
                    <input
                      className="field"
                      autoFocus
                      value={renaming.value}
                      onChange={(e) => setRenaming({ id: session.id, value: e.target.value })}
                      onBlur={() => setRenaming(null)}
                      onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                    />
                  </form>
                ) : (
                  <div
                    className="tree-head"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, session });
                    }}
                  >
                    {/* The caret opens the ideas under it; the title opens the
                        conversation itself. One row, two questions — "what came
                        out of this" and "what was said" — and giving the whole
                        row to one of them meant the other had nowhere to go. */}
                    <button
                      className="tree-toggle"
                      aria-expanded={!isCollapsed}
                      data-tip={isCollapsed ? "Show the ideas" : "Hide the ideas"}
                      onClick={() => toggle(session.id)}
                    >
                      <span className={`tree-caret${isCollapsed ? " closed" : ""}`} aria-hidden="true" />
                    </button>
                    <button className="tree-title" onClick={() => openConversation(session.id)}>
                      {label}
                      {session.tags.length > 0 && (
                        <span className="chat-tags">
                          {session.tags.map((t) => (
                            <i
                              key={t}
                              className="tag-swatch"
                              style={{ "--tag-color": categoryColor(t) } as React.CSSProperties}
                              data-tip={t}
                            />
                          ))}
                        </span>
                      )}
                    </button>
                    {/* Date and count on hover rather than in the row: they are
                        the same length as the title and were taking half of it. */}
                    <span
                      className="tree-meta"
                      data-tip={`${
                        session.started_at ? longDate(session.started_at) + " · " : ""
                      }${session.turn_count} turns · ${sessionIdeas.length} idea${
                        sessionIdeas.length === 1 ? "" : "s"
                      }`}
                    >
                      {sessionIdeas.length}
                    </span>
                    {sessionRepeats.has(session.id) && (
                      <button
                        type="button"
                        className="repeat-mark"
                        data-tip="You likely repeated this conversation somewhere — click to go there"
                        aria-label="Likely repeated elsewhere"
                        onClick={() => openConversation(sessionRepeats.get(session.id)!)}
                      >
                        !
                      </button>
                    )}
                    <span className="chat-actions">
                      <button
                        className="icon-btn"
                        data-tip="Re-read this conversation for ideas"
                        onClick={() => void reextractSession(session.id).then(refresh)}
                      >
                        <IconRewind />
                      </button>
                      <button
                        className="icon-btn"
                        data-tip={session.archived ? "Unarchive" : "Archive"}
                        onClick={() =>
                          void setSessionArchived(session.id, !session.archived).then(refresh)
                        }
                      >
                        <IconArchive />
                      </button>
                      <button
                        className="icon-btn"
                        data-tip="Delete"
                        onClick={() => setDeleting(session.id)}
                      >
                        <IconTrash />
                      </button>
                    </span>
                  </div>
                )}

                {!isCollapsed && (
                  <ul className="list tree-children">
                    {sessionIdeas.map((idea) => {
                      const isOpen = panel?.kind === "idea" && panel.id === idea.id;
                      const returned = sessionsFor(idea) > 1;
                      return (
                        <li key={idea.id} className={isOpen ? "idea open" : "idea"}>
                          <button
                            className="row-btn"
                            onClick={() => openIdea(idea.id)}
                            aria-expanded={isOpen}
                          >
                            {/* Coloured by subject, as on the map. Gold ring
                                means the same thing there too: returned to. */}
                            <span
                              className={returned ? "dot returned" : "dot"}
                              style={{ "--dot-color": categoryColor(idea.category) } as React.CSSProperties}
                              aria-hidden="true"
                            />
                            <span className="row-main">{idea.title && idea.title !== idea.claim ? idea.title : shortTitle(idea.claim)}</span>
                            {(returned || idea.evidence.length > 1) && (
                              <span className="row-meta">
                                {returned
                                  ? `also in ${sessionsFor(idea) - 1} more`
                                  : `${idea.evidence.length} quotes`}
                              </span>
                            )}
                          </button>
                          {ideaRepeats.has(idea.id) && (
                            <button
                              type="button"
                              className="repeat-mark"
                              data-tip="You likely repeated this idea somewhere — click to go there"
                              aria-label="Likely repeated elsewhere"
                              onClick={() => openIdea(ideaRepeats.get(idea.id)!)}
                            >
                              !
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}

          {/* Read, and nothing came out. Same list, folded away: a conversation
              that yielded no ideas is still a conversation, and hiding it
              entirely made it look deleted. Opening one closes the drawer first,
              so the panel it opens is not drawn over by the list it came from. */}
          {!showArchived && groups.empty.length > 0 && (
            <div className="tree-group empty-convos">
              <button
                className="tree-head empty-head"
                aria-expanded={showEmpty}
                onClick={() => setShowEmpty((v) => !v)}
              >
                <span className={`tree-caret${showEmpty ? "" : " closed"}`} aria-hidden="true" />
                <span className="tree-title muted">
                  {groups.empty.length} conversation{groups.empty.length === 1 ? "" : "s"} with no
                  ideas
                </span>
              </button>
              {showEmpty && (
                <ul className="list tree-children">
                  {groups.empty.map((session) => {
                    const label = session.title || session.opening || `Conversation ${session.id}`;
                    return (
                      <li key={session.id} className="chat-line">
                        <button
                          className="row-btn"
                          onClick={() => {
                            setShowEmpty(false);
                            openConversation(session.id);
                          }}
                        >
                          <span className="dot" aria-hidden="true" />
                          <span className="row-main">{shortTitle(label)}</span>
                          <span className="row-meta">{session.turn_count} turns</span>
                        </button>
                        <span className="chat-actions">
                          <button
                            className="icon-btn"
                            data-tip="Re-read this conversation for ideas"
                            onClick={() => void reextractSession(session.id).then(refresh)}
                          >
                            <IconRewind />
                          </button>
                          <button
                            className="icon-btn"
                            data-tip={session.archived ? "Unarchive" : "Archive"}
                            onClick={() =>
                              void setSessionArchived(session.id, !session.archived).then(refresh)
                            }
                          >
                            <IconArchive />
                          </button>
                          <button
                            className="icon-btn"
                            data-tip="Delete"
                            onClick={() => setDeleting(session.id)}
                          >
                            <IconTrash />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {groups.orphaned.length > 0 && (
            <div className="tree-group">
              <div className="tree-head">
                <span className="tree-title muted">Not yet placed</span>
              </div>
              <ul className="list tree-children">
                {groups.orphaned.map((idea) => (
                  <li key={idea.id} className="idea">
                    <span className="row-btn">
                      <span
                        className="dot"
                        style={{ "--dot-color": categoryColor(idea.category) } as React.CSSProperties}
                        aria-hidden="true"
                      />
                      <span className="row-main">{idea.title && idea.title !== idea.claim ? idea.title : shortTitle(idea.claim)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
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
                setRenaming({ id: menu.session.id, value: menu.session.title || menu.session.opening }),
            },
            {
              // Only ever appends, which is why it is safe: the bytes before
              // the join do not move, so every quote already recorded still
              // points at the words it was taken from.
              label: "Continue this conversation",
              onSelect: () => onContinue?.(menu.session.id),
            },
            {
              label: menu.session.archived ? "Unarchive" : "Archive",
              onSelect: () =>
                setSessionArchived(menu.session.id, !menu.session.archived).then(refresh).catch(() => {}),
            },
            {
              // One entry rather than one per folder. With fifty folders the
              // menu was taller than the window.
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

      {moving !== null && (
        <MoveTo sessionId={moving} onDone={refresh} onClose={() => setMoving(null)} />
      )}

      {deleting !== null && (
        <Confirm
          title="Move this conversation and its ideas to the trash?"
          danger
          onConfirm={() => {
            const id = deleting;
            setDeleting(null);
            deleteSession(id).then(refresh).catch(() => {});
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
    </div>

    {/* Over the list rather than beside it. The list is what you were reading;
        opening something from it should not shrink it to a column. */}
    {panel && (
      <Sheet onClose={() => setPanel(null)}>
        {panel.kind === "idea" ? (
          <IdeaFile
            ideaId={panel.id}
            onOpenConversation={(id, ideaId) => openConversation(id, ideaId)}
            onClose={() => setPanel(null)}
          />
        ) : (
          <ConversationFile
            sessionId={panel.id}
            highlightIdea={panel.flash}
            onClose={() => setPanel(null)}
          />
        )}
      </Sheet>
    )}
    </div>
  );
}
