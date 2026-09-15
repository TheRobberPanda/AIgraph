import { useEffect, useState } from "react";
import { setSessionArchived, type SessionSummary } from "../lib/chat";
import {
  extractionProgress,
  extractionTrouble,
  onExtractionProgress,
  pace,
  pendingSessions,
  wireLog,
  type ExtractionProgress,
  type Stalled,
  type WireRequest,
} from "../lib/ideas";
import { parseLiveRead } from "../lib/liveRead";
import { conversationView, type ConversationView } from "../lib/views";
import { longDate } from "../lib/format";
import Sheet from "./Sheet";
import { IconArchive, IconBook, IconChevron } from "./Icons";
import { t, useLang } from "../lib/i18n";

/** What a read ends with when Stop was pressed; `STOPPED_READ` in commands.rs. */
const STOPPED_READ = "stopped before it finished";

/** How much of a conversation a row shows: its title, its start, or all of it. */
type Depth = 0 | 1 | 2;

const DEPTH_TIP: Record<Depth, string> = {
  0: "Show how it starts",
  1: "Show the whole conversation",
  2: "Fold it back to the title",
};

/** A conversation's name when it has no title yet: its first spoken line. */
function titleOf(s: SessionSummary): string {
  if (s.title.trim()) return s.title;
  const first = s.opening
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (first ?? "").slice(0, 90) || `Conversation ${s.id}`;
}

/**
 * What is waiting to be read, and the moment reading is agreed to.
 *
 * Reading a conversation costs minutes of a model's time and produces ideas
 * that then have to be dealt with — so it is a thing to confirm, not something
 * that starts the second a conversation is filed. This is that confirmation,
 * and it is also the place to set one aside without reading it.
 *
 * Rows start as titles. A click shows how a conversation starts, a second
 * shows all of it, a third folds it back. The one being read shows what the
 * model has found so far beside it, as it writes.
 *
 * Nothing here is deleted. A conversation put aside moves to the Archived
 * window, reached from beside the Read button.
 */
export default function Queue({
  onClose,
  onChanged,
  onDigest,
}: {
  onClose: () => void;
  onChanged: () => void;
  /** Begin reading the waiting conversations, once confirmed. */
  onDigest: () => void;
}) {
  useLang();
  const [rows, setRows] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What went wrong, and what is still going. */
  const [trouble, setTrouble] = useState<Stalled[]>([]);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  /** Which reason was just copied, so the button can say so briefly. */
  const [copied, setCopied] = useState<number | null>(null);
  const [depth, setDepth] = useState<Record<number, Depth>>({});
  /** Whole conversations, fetched the first time one is opened all the way. */
  const [full, setFull] = useState<Record<number, ConversationView | "loading">>({});
  /** The failures, folded away until asked for. */
  const [errorsOpen, setErrorsOpen] = useState(false);
  /** The model's reply to the read in flight, as far as it has got. */
  const [wire, setWire] = useState<WireRequest | null>(null);

  const refresh = () => {
    pendingSessions()
      .then(setRows)
      .catch((e) => setError(String(e)));
    void extractionTrouble().then(setTrouble).catch(() => {});
    void extractionProgress().then(setProgress).catch(() => {});
  };

  useEffect(() => {
    void refresh();
    // Live, not a snapshot. This panel opened, read the state once and then
    // sat there — so a conversation that failed while it was open never
    // appeared, and the one reason worth reading was the one it could not
    // show. Every progress event is also the moment something may have
    // changed here.
    let reading: number | null = null;
    const stop = onExtractionProgress((p) => {
      setProgress(p);
      const at = p.running?.session_id ?? null;
      if (at === reading) return;
      reading = at;
      void extractionTrouble().then(setTrouble).catch(() => {});
      void pendingSessions().then(setRows).catch(() => {});
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  // The reply is only on the wire log, so while a read runs it is polled. A
  // request from before this read started is not this read's reply.
  const runningId = progress?.running?.session_id ?? null;
  const runningSince = progress?.running ? Date.parse(progress.running.started_at) : null;
  useEffect(() => {
    if (runningId === null) {
      setWire(null);
      return;
    }
    let live = true;
    const poll = () =>
      void wireLog()
        .then((w) => {
          if (!live) return;
          const r = w.request;
          setWire(r && (runningSince === null || r.started_ms >= runningSince - 2000) ? r : null);
        })
        .catch(() => {});
    poll();
    const id = window.setInterval(poll, 700);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [runningId, runningSince]);

  function cycle(id: number) {
    const next = (((depth[id] ?? 0) + 1) % 3) as Depth;
    setDepth((d) => ({ ...d, [id]: next }));
    if (next === 2 && !full[id]) {
      setFull((f) => ({ ...f, [id]: "loading" }));
      conversationView(id)
        .then((v) => setFull((f) => ({ ...f, [id]: v })))
        .catch((e) => {
          setError(String(e));
          setFull((f) => {
            const { [id]: _, ...rest } = f;
            return rest;
          });
        });
    }
  }

  const failed = new Map(trouble.map((t) => [t.session_id, t]));
  // The one being read goes first, then the rest in the order the queue reads
  // them — which puts the ones that failed last. They stay in this list: a
  // failed read is still waiting, and will be tried again. Taking them out
  // left a queue that said "Read (3)" over an empty list, with the three
  // folded away under "Would not read" as if they were done with.
  const all = rows ?? [];
  const reading = all.filter((s) => s.id === runningId);
  const waiting = all.filter((s) => s.id !== runningId);
  const shown = [...reading, ...waiting];

  function row(s: SessionSummary) {
    const d = depth[s.id] ?? 0;
    const isReading = s.id === runningId;
    const opening = s.opening.trim();
    const conv = full[s.id];
    return (
      <li key={s.id} className={isReading ? "queue-item reading" : "queue-item"}>
        <div className="queue-body">
          <div className="queue-line">
            <button
              className="queue-toggle"
              aria-expanded={d > 0}
              data-tip={DEPTH_TIP[d]}
              onClick={() => cycle(s.id)}
            >
              <IconChevron className={`queue-chevron d${d}`} />
              <span className="queue-title">{titleOf(s)}</span>
              <span className="row-meta">
                {s.started_at ? longDate(s.started_at) : ""} · {s.turn_count} turns
              </span>
            </button>
            {!isReading && failed.has(s.id) && (
              <span
                className="tag warn"
                data-tip={failed.get(s.id)!.error}
                onClick={() => setErrorsOpen(true)}
              >
                {failed.get(s.id)!.retry_in_minutes
                  ? `failed · again in ${failed.get(s.id)!.retry_in_minutes} min`
                  : "failed last time"}
              </span>
            )}
            {!isReading && (
              <span className="chat-actions">
                <button
                  className="icon-btn"
                  data-tip="Set it aside without reading it"
                  onClick={() =>
                    void setSessionArchived(s.id, true)
                      .then(refresh)
                      .then(onChanged)
                      .catch((e) => setError(String(e)))
                  }
                >
                  <IconArchive />
                </button>
              </span>
            )}
          </div>
          {d === 1 && opening && <p className="queue-opening">{opening}</p>}
          {d === 2 &&
            (conv === undefined || conv === "loading" ? (
              <p className="queue-opening full">{opening || "Loading…"}</p>
            ) : (
              <div className="queue-full">
                {conv.turns.map((turn) => (
                  <p key={turn.id} className={`queue-turn ${turn.role}`}>
                    <span className="queue-role">{turn.role === "user" ? "You" : "AI"}</span>
                    {turn.segments.map((g) => g.text).join("")}
                  </p>
                ))}
              </div>
            ))}
        </div>
        {isReading && progress?.running && <LivePanel wire={wire} progress={progress} />}
      </li>
    );
  }

  return (
    <Sheet onClose={onClose}>
      <div className="pane-inner">
        <header className="head">
          <button className="btn" onClick={onClose}>
            {t("back")}
          </button>
          <h1>Waiting to be read</h1>
          <span className="muted">
            {rows === null ? t("queue_loading") : t("queue_count", { n: rows.length })}
          </span>
          {/* Top right, where the eye ends up after reading down the header —
              not under a list that may be longer than the window. */}
          {rows !== null && rows.length > 0 && (
            <button
              className="btn btn-send head-end"
              onClick={() => {
                onDigest();
                onClose();
              }}
            >
              <IconBook />
              Read these now
            </button>
          )}
        </header>

        {error && <p className="error">{error}</p>}

        {/* What is happening, in the place people come to when it looks
            like nothing is. Reading stops between conversations, backs
            off after a failure, and both are invisible from the button. */}
        {!progress?.running && (
          <div className="state-panel">
            {progress?.last ? (
              <p className="blurb">
                Not reading anything. Last read{" "}
                {progress.last.error === STOPPED_READ ? "ran" : "took"} {progress.last.seconds}s
                {progress.last.error === STOPPED_READ ? (
                  <> and was stopped. It is back in the queue, unread.</>
                ) : progress.last.error ? (
                  <> and failed.</>
                ) : (
                  <>
                    {" "}
                    and found {progress.last.ideas}{" "}
                    {progress.last.ideas === 1 ? "idea" : "ideas"}
                    {progress.last.wrote_per_second != null &&
                      ` · ${Math.round(progress.last.wrote_per_second)} tok/s`}
                    .
                  </>
                )}
              </p>
            ) : (
              <p className="blurb">Not reading anything.</p>
            )}
          </div>
        )}

        {rows !== null && shown.length === 0 && trouble.length === 0 ? (
          <p className="empty">{t("queue_empty")}</p>
        ) : (
          <ul className="queue-list">{shown.map(row)}</ul>
        )}

        {/* At the bottom, where the queue puts them: a conversation that
            failed is read after everything that has not. Folded and greyed,
            so one stubborn conversation does not take over the page. */}
        {trouble.length > 0 && (
          <section className={errorsOpen ? "queue-errors open" : "queue-errors"}>
            <button
              className="rail-section-head"
              aria-expanded={errorsOpen}
              onClick={() => setErrorsOpen((o) => !o)}
            >
              <IconChevron className={errorsOpen ? "queue-chevron d1" : "queue-chevron d0"} />
              Would not read · {trouble.length}
            </button>
            {errorsOpen && (
              <ul className="queue-list">
                {trouble.map((t) => (
                  <li key={t.session_id} className="queue-item failed">
                    <div className="queue-body">
                      <div className="queue-line">
                        <span className="queue-title">{t.title || `Conversation ${t.session_id}`}</span>
                        <span className="row-meta">
                          {t.retry_in_minutes !== null
                            ? `trying again in ${t.retry_in_minutes} min`
                            : "read last"}
                          {t.attempts > 1 && ` · ${t.attempts} attempts`}
                        </span>
                      </div>
                      {/* The whole message, not a summary of it. This is the one
                          place the actual reason is available, and an abridged
                          error is a reason nobody can act on. */}
                      <p className="path">{t.error}</p>
                      <button
                        className="btn subtle"
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            `${t.title || `Conversation ${t.session_id}`}: ${t.error}`,
                          );
                          setCopied(t.session_id);
                          window.setTimeout(() => setCopied(null), 1400);
                        }}
                      >
                        {copied === t.session_id ? "Copied" : "Copy the reason"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </Sheet>
  );
}

/**
 * Beside the conversation being read: what the model has written so far,
 * already parsed into the ideas it will become.
 */
function LivePanel({ wire, progress }: { wire: WireRequest | null; progress: ExtractionProgress }) {
  const r = progress.running!;
  const found = parseLiveRead(wire?.output ?? "");
  const thinking = wire && !wire.output.trim() && wire.thinking.trim();
  return (
    <aside className="live-read" aria-live="polite">
      <div className="live-head">
        <span className="spinner" aria-hidden="true" />
        <span>
          {r.total > 1 && `${r.index} of ${r.total} · `}
          {r.phase}
          {pace(r) && ` · ${pace(r)}`}
          {progress.stopping && " · stopping"}
        </span>
      </div>
      {found.title && (
        <p className="live-title">
          <span className="live-label">Title</span> {found.title}
        </p>
      )}
      {found.ideas.length > 0 ? (
        <ol className="live-ideas">
          {found.ideas.map((i, n) => (
            <li key={n}>
              {i.title && <strong>{i.title}</strong>}
              {i.claim && <span>{i.claim}</span>}
              {i.category && <span className="tag">{i.category}</span>}
            </li>
          ))}
        </ol>
      ) : thinking ? (
        <p className="live-thinking">Thinking… {thinking.slice(-240)}</p>
      ) : (
        <p className="live-thinking">
          {wire ? "Waiting for the model's first words…" : "Waiting for the model…"}
        </p>
      )}
      {found.definitions.length > 0 && (
        <p className="live-defs">
          <span className="live-label">Definitions</span>{" "}
          {found.definitions.map((d) => d.term).join(", ")}
        </p>
      )}
    </aside>
  );
}
