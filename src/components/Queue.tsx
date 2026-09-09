import { useEffect, useState } from "react";
import { deleteSession, type SessionSummary } from "../lib/chat";
import {
  extractionProgress,
  extractionTrouble,
  onExtractionProgress,
  pace,
  pendingSessions,
  type ExtractionProgress,
  type Stalled,
} from "../lib/ideas";
import { longDate } from "../lib/format";
import Confirm from "./Confirm";
import Sheet from "./Sheet";
import { IconTrash } from "./Icons";
import { t, useLang } from "../lib/i18n";

/**
 * What is waiting to be read, and a way to say no to any of it.
 *
 * The count in the corner said how many and never which. Reading a
 * conversation costs minutes of a local model's time and produces ideas that
 * then have to be deleted one by one — so the cheap moment to decide a
 * conversation is not worth reading is before it is read, and that needs the
 * queue to be visible.
 */
export default function Queue({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  useLang();
  const [rows, setRows] = useState<SessionSummary[] | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What went wrong, and what is still going. */
  const [trouble, setTrouble] = useState<Stalled[]>([]);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  /** Which reason was just copied, so the button can say so briefly. */
  const [copied, setCopied] = useState<number | null>(null);

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
    // The progress event now ticks while a single read is in flight, so
    // refetching the lists on every one of them would put four queries a
    // second behind a panel that is only being looked at. The lists can only
    // change when the read moves on, so that is when they are re-read.
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

  return (
    <Sheet onClose={onClose}>
      <div className="pane-inner">
        <header className="head">
          <button className="btn" onClick={onClose}>
            {t("back")}
          </button>
          <span className="muted">
            {rows === null ? t("queue_loading") : t("queue_count", { n: rows.length })}
          </span>
        </header>

        {error && <p className="error">{error}</p>}

        {/* What is happening, in the place people come to when it looks like
            nothing is. Reading stops between conversations, backs off after a
            failure, and both are invisible from the button. */}
        <div className="state-panel">
          <h3 className="section">Right now</h3>
          {progress?.running ? (
            <p className="blurb">
              <span className="spinner" aria-hidden="true" /> Reading{" "}
              {progress.running.total > 1 &&
                `${progress.running.index} of ${progress.running.total} — `}
              {progress.running.phase}
              {pace(progress.running) && ` · ${pace(progress.running)}`}
              {progress.stopping && " · stopping after this one"}
            </p>
          ) : (
            <p className="blurb">Not reading anything.</p>
          )}

          {progress?.last && (
            <p className="blurb">
              Last read took {progress.last.seconds}s
              {progress.last.error ? (
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
          )}

          {trouble.length > 0 && (
            <>
              <h3 className="section">Would not read</h3>
              <ul className="plain-list">
                {trouble.map((t) => (
                  <li key={t.session_id}>
                    <strong>{t.title || `Conversation ${t.session_id}`}</strong>
                    {t.retry_in_minutes !== null && (
                      <span className="row-meta">
                        {" "}
                        · trying again in {t.retry_in_minutes} min
                        {t.attempts > 1 && ` (${t.attempts} attempts)`}
                      </span>
                    )}
                    {/* The whole message, not a summary of it. This is the one
                        place the actual reason is available, and an abridged
                        error is a reason nobody can act on. */}
                    <p className="path">{t.error}</p>
                    {/* One click to hand the reason to someone who can act on
                        it. Selecting text out of a panel that redraws whenever
                        the queue moves is a fight nobody should have. */}
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
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {rows !== null && rows.length === 0 ? (
          <p className="empty">{t("queue_empty")}</p>
        ) : (
          <ul className="list">
            {(rows ?? []).map((s) => (
              <li key={s.id} className="chat-line">
                <span className="row-btn">
                  <span className="row-main">
                    {s.title || s.opening || `Conversation ${s.id}`}
                  </span>
                  <span className="row-meta">
                    {s.started_at ? longDate(s.started_at) : ""} · {s.turn_count} turns
                  </span>
                </span>
                <span className="chat-actions">
                  <button
                    className="icon-btn"
                    data-tip="Delete it rather than read it"
                    onClick={() => setDeleting(s.id)}
                  >
                    <IconTrash />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="blurb">
          Deleting one here removes the conversation itself, not just its place
          in the queue — there is no way to keep a conversation and refuse to
          read it, because an unread conversation is what this list is.
        </p>
      </div>

      {deleting !== null && (
        <Confirm
          title="Delete this conversation?"
          danger
          onConfirm={() => {
            const id = deleting;
            setDeleting(null);
            deleteSession(id)
              .then(refresh)
              .then(onChanged)
              .catch((e) => setError(String(e)));
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </Sheet>
  );
}
