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
import FilePanel from "./FilePanel";
import { ConversationFile, IdeaFile } from "./Deep";
import { categoryColor } from "../lib/categories";
import { listFolders, moveSession, ROOT_FOLDER, type Folder } from "../lib/folders";
import { longDate } from "../lib/format";
import {
  extractionProgress,
  getDiagnostics,
  listIdeas,
  onExtractionProgress,
  onIdeasChanged,
  type Diagnostics,
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

/** How many separate conversations support this idea. */
function sessionsFor(idea: Idea): number {
  return new Set(idea.evidence.map((e) => e.session_id)).size;
}

const REASON_LABELS: Record<string, string> = {
  not_found: "not in the transcript",
  attributed_to_assistant: "quoted the assistant",
  empty_quote: "empty quote",
};

/**
 * A plain list of extracted ideas.
 *
 * Placeholder for the graph (milestone 6) — but a useful one: it shows the
 * claim, the exact words it came from, and the nudges, which is everything the
 * graph will need to be trustworthy. Getting this right first means the graph
 * is a rendering problem rather than a correctness one.
 */
export default function Ideas() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  // Which conversations are open. Was the inverse — a set of closed ones —
  // which meant anything newly extracted arrived expanded and the list grew
  // unreadable on its own.
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const [panel, setPanel] = useState<{ kind: "idea" | "conversation"; id: number } | null>(null);
  const [panelSide, setPanelSide] = useState<"left" | "right">("right");
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionSummary } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  // Re-renders once a second purely so the elapsed counter advances between
  // phase events — which can be minutes apart on a local model.
  const [, tick] = useState(0);

  const refresh = useCallback(() => {
    void listIdeas().then(setIdeas);
    void listSessions().then(setSessions);
    void getDiagnostics().then(setDiag);
    void listFolders().then(setFolders);
  }, []);

  /**
   * Group ideas under the conversation that first produced them.
   *
   * An idea returned to in a later conversation still lives under the one
   * where it was first said — that conversation is where the thought started,
   * and repeating it under every conversation that touched it would turn one
   * idea into several list entries.
   */
  const groups = useMemo(() => {
    const bySession = new Map<number, Idea[]>();
    const orphaned: Idea[] = [];
    for (const idea of ideas) {
      const first = idea.evidence.reduce<Evidence | null>(
        (min, e) => (min === null || e.id < min.id ? e : min),
        null,
      );
      if (first === null) {
        orphaned.push(idea);
        continue;
      }
      const list = bySession.get(first.session_id) ?? [];
      list.push(idea);
      bySession.set(first.session_id, list);
    }

    const known = new Set(sessions.map((s) => s.id));
    const rows = sessions
      .filter((s) => bySession.has(s.id))
      .map((s) => ({ session: s, ideas: bySession.get(s.id)! }));

    // A session not yet in the list (still extracting) still gets a home,
    // rather than losing its ideas until the list catches up.
    for (const [id, list] of bySession) {
      if (!known.has(id)) {
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
    // Then gather those conversations under the folder each is filed in, so
    // one line of thinking can be kept apart from another.
    const byFolder = new Map<number, typeof rows>();
    for (const row of rows) {
      const fid = row.session.folder_id ?? ROOT_FOLDER;
      const list = byFolder.get(fid) ?? [];
      list.push(row);
      byFolder.set(fid, list);
    }
    const foldered = [...byFolder.entries()]
      .map(([id, list]) => ({
        id,
        name: folders.find((f) => f.id === id)?.name ?? "Root",
        rows: list,
      }))
      // Root first, then alphabetically — the same order the picker uses.
      .sort((a, b) =>
        a.id === ROOT_FOLDER ? -1 : b.id === ROOT_FOLDER ? 1 : a.name.localeCompare(b.name),
      );

    return { foldered, orphaned };
  }, [ideas, sessions, folders]);

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
  function openConversation(id: number) {
    setPanel((p) => (p?.kind === "conversation" && p.id === id ? null : { kind: "conversation", id }));
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
    <div className={`split${panel && panelSide === "left" ? " panel-left" : ""}`}>
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

      {diag && (
        <div className="diag">
          <span>
            <strong>{diag.ideas}</strong> ideas
          </span>
          {/* The honesty metric. Shown rather than logged, because a drop rate
              nobody looks at is a drop rate nobody fixes. */}
          <span>
            <strong>{(diag.drop_rate * 100).toFixed(0)}%</strong> dropped
          </span>
          {diag.normalized > 0 && (
            <span>
              {diag.normalized} loose {diag.normalized === 1 ? "match" : "matches"}
            </span>
          )}
          {diag.by_reason.map(([reason, n]) => (
            <span key={reason} className="reason">
              {n} {REASON_LABELS[reason] ?? reason}
            </span>
          ))}
        </div>
      )}

      {ideas.length === 0 ? (
        <p className="empty">No ideas yet.</p>
      ) : (
        <div className="tree">
          {groups.foldered.map((folder) => (
          <div key={folder.id} className="folder-group">
            {/* Only worth a heading once there is more than one folder — a
                lone "ROOT" label above everything is noise. */}
            {groups.foldered.length > 1 && (
              <div className="folder-head">
                <span>{folder.name}</span>
                <span className="row-meta">
                  {folder.rows.length} {folder.rows.length === 1 ? "conversation" : "conversations"}
                </span>
              </div>
            )}
          {folder.rows.map(({ session, ideas: sessionIdeas }) => {
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
                      renameSession(session.id, title).then(refresh);
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
                  <button
                    className="tree-head"
                    onClick={() => toggle(session.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, session });
                    }}
                    aria-expanded={!isCollapsed}
                  >
                    <span className={`tree-caret${isCollapsed ? " closed" : ""}`} aria-hidden="true" />
                    <span className="tree-title">{label}</span>
                    {/* Date and count on hover rather than in the row: they are
                        the same length as the title and were taking half of it. */}
                    <span
                      className="tree-meta"
                      data-tip={`${
                        session.started_at ? longDate(session.started_at) + " · " : ""
                      }${sessionIdeas.length} idea${sessionIdeas.length === 1 ? "" : "s"}`}
                    >
                      {sessionIdeas.length}
                    </span>
                  </button>
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
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
          </div>
          ))}

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
              label: menu.session.archived ? "Unarchive" : "Archive",
              onSelect: () =>
                setSessionArchived(menu.session.id, !menu.session.archived).then(refresh),
            },
            ...folders
              .filter((f) => f.id !== menu.session.folder_id)
              .map((f) => ({
                label: `Move to ${f.name}`,
                onSelect: () => void moveSession(menu.session.id, f.id).then(refresh),
              })),
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
          title="Delete this conversation and the ideas found only in it?"
          danger
          onConfirm={() => {
            const id = deleting;
            setDeleting(null);
            deleteSession(id).then(refresh);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
    </div>

    {panel && (
      <FilePanel side={panelSide} onSideChange={setPanelSide} width={panelWidth} onWidthChange={setPanelWidth}>
        {panel.kind === "idea" ? (
          <IdeaFile
            ideaId={panel.id}
            onOpenConversation={(id) => openConversation(id)}
            onClose={() => setPanel(null)}
          />
        ) : (
          <ConversationFile
            sessionId={panel.id}
            onOpenIdea={(id) => openIdea(id)}
            onClose={() => setPanel(null)}
          />
        )}
      </FilePanel>
    )}
    </div>
  );
}
