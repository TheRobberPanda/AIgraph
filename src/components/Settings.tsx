import { useEffect, useState } from "react";
import {
  applyTheme,
  getSettings,
  reextractAll,
  saveSettings,
  transcriptsDir,
  type Settings as S,
  type Theme,
} from "../lib/settings";
import {
  downloadSpeechModel,
  onDownloadProgress,
  speechModelStatus,
  type DownloadProgress,
} from "../lib/dictation";

const THEMES: { value: Theme; label: string }[] = [
  { value: "auto", label: "Match the system" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export default function Settings() {
  const [s, setS] = useState<S | null>(null);
  const [dir, setDir] = useState("");
  const [speech, setSpeech] = useState<{ installed: boolean; mb: number } | null>(null);
  const [downloading, setDownloading] = useState<DownloadProgress | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void getSettings().then(setS);
    void transcriptsDir().then(setDir);
    void speechModelStatus()
      .then((x) => setSpeech({ installed: x.installed, mb: x.download_mb }))
      .catch(() => {});
    const p = onDownloadProgress(setDownloading);
    return () => {
      void p.then((un) => un());
    };
  }, []);

  async function update(patch: Partial<S>) {
    if (!s) return;
    const next = { ...s, ...patch };
    setS(next);
    if (patch.theme) applyTheme(patch.theme);
    try {
      await saveSettings(next);
    } catch (e) {
      setError(String(e));
    }
  }

  if (!s) return <div className="pane-inner" />;

  return (
    <div className="pane-inner">
      {error && <p className="error">{error}</p>}

      <section>
        <h2 className="section">Appearance</h2>
        <div className="row">
          {THEMES.map((t) => (
            <button
              key={t.value}
              className={s.theme === t.value ? "btn on" : "btn"}
              onClick={() => void update({ theme: t.value })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section">Ending a session</h2>
        <p className="blurb">
          How long a session can sit quiet before it is treated as finished and
          filed. Pressing <b>Done</b> ends it immediately.
        </p>
        <div className="row">
          {[10, 30, 60, 120].map((m) => (
            <button
              key={m}
              className={s.idle_minutes === m ? "btn on" : "btn"}
              onClick={() => void update({ idle_minutes: m })}
            >
              {m < 60 ? `${m} min` : `${m / 60} hr`}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section">Transcripts</h2>
        <p className="blurb">
          Every conversation is written here as plain markdown as well as to the
          database — the full exchange, exactly as it happened, readable without
          this program.
        </p>
        <p className="path">{dir}</p>
      </section>

      <section>
        <h2 className="section">Dictation</h2>
        {speech?.installed ? (
          <p className="blurb">
            Speech recognition is installed and runs on the CPU, so it does not
            compete with the chat model for the graphics card.
          </p>
        ) : downloading ? (
          <p className="blurb">
            Downloading… {Math.round((downloading.received / (downloading.total || 1)) * 100)}%
          </p>
        ) : (
          <>
            <p className="blurb">
              Talk instead of typing. Downloads about {speech?.mb ?? 488}MB once
              and runs entirely on this machine.
            </p>
            <button className="btn" onClick={() => void downloadSpeechModel()}>
              Download the speech model
            </button>
          </>
        )}
      </section>

      <section>
        <h2 className="section">Re-read every conversation</h2>
        <p className="blurb">
          Discards the recorded ideas and reads every conversation again. Useful
          after the app has been updated. The conversations themselves are never
          touched — only what was taken from them.
        </p>
        {confirming ? (
          <div className="row">
            <button
              className="btn danger"
              onClick={() => {
                setConfirming(false);
                reextractAll()
                  .then((n) => setNote(`Re-reading ${n} conversation${n === 1 ? "" : "s"}.`))
                  .catch((e) => setError(String(e)));
              }}
            >
              Yes, re-read them
            </button>
            <button className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => setConfirming(true)}>
            Re-read everything
          </button>
        )}
        {note && <p className="blurb">{note}</p>}
      </section>

      <section>
        <h2 className="section">How this app uses AI</h2>
        {/* Stated in the app, not only in a README. Someone using this to think
            through something that matters deserves to know what is machine-made
            without going looking for it. */}
        <ul className="plain-list">
          <li>Ideas are recorded by a model taking notes. It can misread, so every idea links back to the exact words it came from.</li>
          <li>An idea the model cannot quote is discarded rather than shown. The Ideas page reports how often that happens.</li>
          <li>Notes in the margin are the model's, marked <b>AI</b>, and never become recorded ideas.</li>
          <li>The conversation is never steered. No instructions about this app are added to it.</li>
          <li>Nothing leaves this machine unless a remote model is chosen in Models.</li>
        </ul>
      </section>
    </div>
  );
}
