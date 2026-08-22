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

  if (!s) return <div className="panel" />;

  return (
    <div className="panel">
      {error && <p className="error">{error}</p>}

      <section>
        <h2 className="panel-title">Appearance</h2>
        <div className="choice-row">
          {THEMES.map((t) => (
            <button
              key={t.value}
              className={s.theme === t.value ? "choice on" : "choice"}
              onClick={() => void update({ theme: t.value })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="panel-title">Ending a session</h2>
        <p className="panel-blurb">
          How long the app waits before deciding you have finished and filing the
          conversation away. Pressing <b>Done</b> always ends it immediately.
        </p>
        <div className="choice-row">
          {[10, 30, 60, 120].map((m) => (
            <button
              key={m}
              className={s.idle_minutes === m ? "choice on" : "choice"}
              onClick={() => void update({ idle_minutes: m })}
            >
              {m < 60 ? `${m} min` : `${m / 60} hr`}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="panel-title">Your transcripts</h2>
        <p className="panel-blurb">
          Every conversation is written here as plain markdown as well as to the
          app's database, so your thinking is never only inside this program.
        </p>
        <p className="path">{dir}</p>
      </section>

      <section>
        <h2 className="panel-title">Dictation</h2>
        {speech?.installed ? (
          <p className="panel-blurb">
            Speech recognition is installed and runs on the CPU, so it does not
            compete with your chat model for the graphics card.
          </p>
        ) : downloading ? (
          <p className="panel-blurb">
            Downloading… {Math.round((downloading.received / (downloading.total || 1)) * 100)}%
          </p>
        ) : (
          <>
            <p className="panel-blurb">
              Talk instead of typing. Downloads about {speech?.mb ?? 488}MB once,
              and runs entirely on this machine.
            </p>
            <button className="done" onClick={() => void downloadSpeechModel()}>
              Download the speech model
            </button>
          </>
        )}
      </section>

      <section>
        <h2 className="panel-title">Re-read every conversation</h2>
        <p className="panel-blurb">
          Throws away the extracted ideas and works through your conversations
          again. Useful after the app has been updated. Your conversations
          themselves are never touched — only what was extracted from them.
        </p>
        {confirming ? (
          <div className="choice-row">
            <button
              className="choice danger"
              onClick={() => {
                setConfirming(false);
                reextractAll()
                  .then((n) => setNote(`Re-reading ${n} conversation${n === 1 ? "" : "s"}.`))
                  .catch((e) => setError(String(e)));
              }}
            >
              Yes, re-read them
            </button>
            <button className="choice" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="done" onClick={() => setConfirming(true)}>
            Re-read everything
          </button>
        )}
        {note && <p className="panel-blurb">{note}</p>}
      </section>

      <section>
        <h2 className="panel-title">How this app uses AI</h2>
        {/* Stated in the app, not only in a README. Someone using this to think
            through something that matters deserves to know what is machine-made
            without going looking for it. */}
        <ul className="plain-list">
          <li>Your ideas are extracted by a model. It can misread you, so every idea links back to your exact words.</li>
          <li>An idea the model cannot quote you on is discarded rather than shown. The Ideas page reports how often that happens.</li>
          <li>Strong and weak points are the model's opinion. They are marked <b>AI</b> and never become ideas of yours.</li>
          <li>Your conversation is never steered. No instructions about this app are added to it.</li>
          <li>Everything runs on this machine unless you point it at a remote model yourself.</li>
        </ul>
      </section>
    </div>
  );
}
