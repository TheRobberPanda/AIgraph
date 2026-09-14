import { useEffect, useState } from "react";
import { setSessionArchived, type SessionSummary } from "../lib/chat";
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
import Sheet from "./Sheet";
import { IconArchive, IconSend } from "./Icons";
import { t, useLang } from "../lib/i18n";

/**
 * What is waiting to be read, and the moment reading is agreed to.
 *
 * Reading a conversation costs minutes of a local model's time and produces
 * ideas that then have to be dealt with — so it is a thing to confirm, not
 * something that starts the second a conversation is filed. This is that
 * confirmation, and it is also the place to set one aside without reading it.
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

  /** A conversation's name when it has no title yet: its first spoken line. */
  function titleOf(s: SessionSummary): string {
    if (s.title.trim()) return s.title;
    const first = s.opening
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    return (first ?? "").slice(0, 90) || `Conversation ${s.id}`;
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
              className="btn btn-send grow head-end"
              onClick={() => {
                onDigest();
                onClose();
              }}
            >
              <IconSend />
              <span className="btn-label">Read {rows.length === 1 ? "it" : `these ${rows.length}`} now</span>
            </button>
          )}
        </header>

        {error && <p className="error">{error}</p>}

        {/* What is happening, in the place people come to when it looks
            like nothing is. Reading stops between conversations, backs
            off after a failure, and both are invisible from the button. */}
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
                    <span className="queue-title">{titleOf(s)}</span>
                    {titleOf(s) !== s.opening.trim() && s.opening.trim() && (
                      <span className="chat-open queue-opening">{s.opening}</span>
                    )}
                  </span>
                  <span className="row-meta">
                    {s.started_at ? longDate(s.started_at) : ""} · {s.turn_count} turns
                  </span>
                </span>
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
