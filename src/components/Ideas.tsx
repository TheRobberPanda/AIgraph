import { useCallback, useEffect, useMemo, useState } from "react";
import Source from "./Source";
import { listSessions, type SessionSummary } from "../lib/chat";
import { longDate } from "../lib/format";
import {
  extractNow,
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
export default function Ideas({ onOpen }: { onOpen?: (ideaId: number) => void }) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [source, setSource] = useState<{ evidence: Evidence; claim: string } | null>(null);
  // Bridges the gap between the click and the first progress event from the
  // backend, so the button doesn't sit there looking ignored.
  const [requested, setRequested] = useState(false);
  // Re-renders once a second purely so the elapsed counter advances between
  // phase events — which can be minutes apart on a local model.
  const [, tick] = useState(0);

  const refresh = useCallback(() => {
    void listIdeas().then(setIdeas);
    void listSessions().then(setSessions);
    void getDiagnostics().then(setDiag);
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
          },
          ideas: list,
        });
      }
    }
    return { rows, orphaned };
  }, [ideas, sessions]);

  function toggle(sessionId: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
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
    if (running) setRequested(false);
  }, [running]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <div className="pane-inner">
      {source && (
        <Source
          evidence={source.evidence}
          claim={source.claim}
          onClose={() => setSource(null)}
        />
      )}
      {(running || (progress?.pending ?? 0) > 0 || progress?.last) && (
      <div className="diag">
        {running ? (
          <div className="row">
            <span className="spinner" aria-hidden="true" />
            <span>
              Extracting session {running.session_id} — {PHASE_LABELS[running.phase]}
            </span>
            <span className="muted">{elapsed(running.started_at)}</span>
          </div>
        ) : (progress?.pending ?? 0) > 0 ? (
          <div className="row">
            <span>
              {progress?.pending} session{progress?.pending === 1 ? "" : "s"} waiting
            </span>
            {(
              <button
                className={requested ? "btn busy" : "btn"}
                disabled={requested}
                aria-busy={requested}
                onClick={() => {
                  setRequested(true);
                  void extractNow().catch(() => setRequested(false));
                }}
              >
                {requested && <span className="spinner" aria-hidden="true" />}
                {requested ? "Starting…" : "Extract now"}
              </button>
            )}
          </div>
        ) : null}

        {!running && progress?.last && (
          <p className="blurb">
            {progress.last.error ? (
              <span className="error">
                Session {progress.last.session_id} failed after{" "}
                {progress.last.seconds}s: {progress.last.error}
              </span>
            ) : (
              <span className="muted">
                Last run: {progress.last.ideas} idea
                {progress.last.ideas === 1 ? "" : "s"} from session{" "}
                {progress.last.session_id} in {progress.last.seconds}s
                {progress.last.dropped > 0 && `, ${progress.last.dropped} dropped`}
                {progress.last.retried && " (needed a retry)"}
              </span>
            )}
          </p>
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
          <span title="Proposed ideas that could not be traced back to the words as spoken">
            <strong>{(diag.drop_rate * 100).toFixed(0)}%</strong> dropped
          </span>
          {diag.normalized > 0 && (
            <span title="Matched after normalizing whitespace, quotes, or casing">
              {diag.normalized} loose {diag.normalized === 1 ? "match" : "matches"}
            </span>
          )}
          {diag.sessions_pending > 0 && (
            <span className="pending">
              {diag.sessions_pending} session
              {diag.sessions_pending === 1 ? "" : "s"} awaiting extraction
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
        <p className="empty">
          No ideas yet. Have a conversation, press Done, and they’ll appear here.
          {diag && diag.sessions_pending > 0 && (
            <>
              <br />
              <span className="muted">
                A session is queued — extraction runs in the background and can
                take a few minutes on a local model.
              </span>
            </>
          )}
        </p>
      ) : (
        <div className="tree">
          {groups.rows.map(({ session, ideas: sessionIdeas }) => {
            const isCollapsed = collapsed.has(session.id);
            return (
              <div key={session.id} className="tree-group">
                <button
                  className="tree-head"
                  onClick={() => toggle(session.id)}
                  aria-expanded={!isCollapsed}
                >
                  <span className={`tree-caret${isCollapsed ? " closed" : ""}`} aria-hidden="true" />
                  <span className="tree-title">
                    {session.opening || `Conversation ${session.id}`}
                  </span>
                  <span className="row-meta">
                    {session.started_at && longDate(session.started_at)}
                    {" · "}
                    {sessionIdeas.length} idea{sessionIdeas.length === 1 ? "" : "s"}
                  </span>
                </button>

                {!isCollapsed && (
                  <ul className="list tree-children">
                    {sessionIdeas.map((idea) => {
                      const isOpen = open === idea.id;
                      const returned = sessionsFor(idea) > 1;
                      return (
                        <li key={idea.id} className={isOpen ? "idea open" : "idea"}>
                          <button
                            className="row-btn"
                            onClick={() =>
                              onOpen ? onOpen(idea.id) : setOpen(isOpen ? null : idea.id)
                            }
                            aria-expanded={isOpen}
                          >
                            {/* Gold means the same thing here as on the map: a
                                thought returned to elsewhere. */}
                            <span className={returned ? "dot returned" : "dot"} aria-hidden="true" />
                            <span className="row-main">{idea.claim}</span>
                            {(returned || idea.evidence.length > 1) && (
                              <span className="row-meta">
                                {returned
                                  ? `also in ${sessionsFor(idea) - 1} more`
                                  : `${idea.evidence.length} quotes`}
                              </span>
                            )}
                          </button>

                          {isOpen && (
                            <div className="detail">
                              {idea.evidence.map((e) => (
                                <blockquote key={e.id}>
                                  <button
                                    className="link"
                                    onClick={() => setSource({ evidence: e, claim: idea.claim })}
                                    title="See this in the conversation"
                                  >
                                    “{e.quote}”
                                  </button>
                                  {e.normalized && <span className="tag">loose match</span>}
                                  {e.ambiguous && <span className="tag">said more than once</span>}
                                </blockquote>
                              ))}

                              {(idea.strong.length > 0 || idea.weak.length > 0) && (
                                <div className="notes">
                                  {idea.strong.map((t, i) => (
                                    <p key={`s${i}`} className="note strong">
                                      <span className="badge">AI</span>
                                      {t}
                                    </p>
                                  ))}
                                  {idea.weak.map((t, i) => (
                                    <p key={`w${i}`} className="note weak">
                                      <span className="badge">AI</span>
                                      {t}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}

          {groups.orphaned.length > 0 && (
            <div className="tree-group">
              <div className="tree-head">
                <span className="tree-title muted">Not yet placed</span>
              </div>
              <ul className="list tree-children">
                {groups.orphaned.map((idea) => (
                  <li key={idea.id} className="idea">
                    <span className="row-btn">
                      <span className="dot" aria-hidden="true" />
                      <span className="row-main">{idea.claim}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
