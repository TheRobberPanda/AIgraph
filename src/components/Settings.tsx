import { useEffect, useState } from "react";
import {
  applyTheme,
  applyUiScale,
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
    if (patch.ui_scale) applyUiScale(patch.ui_scale);
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
        <h2 className="section">Interface size</h2>
        <div className="row scale-row">
          <input
            type="range"
            className="scale-slider"
            min={85}
            max={160}
            step={5}
            value={s.ui_scale}
            onChange={(e) => {
              // Applied live as it's dragged, saved once it settles — a slider
              // that only updates on release feels disconnected from the hand.
              const v = Number(e.target.value);
              setS({ ...s, ui_scale: v });
              applyUiScale(v);
            }}
            onMouseUp={() => void update({ ui_scale: s.ui_scale })}
            onKeyUp={() => void update({ ui_scale: s.ui_scale })}
          />
          <span className="scale-value">{s.ui_scale}%</span>
          {s.ui_scale !== 100 && (
            <button className="btn" onClick={() => void update({ ui_scale: 100 })}>
              Reset
            </button>
          )}
        </div>
      </section>

      <section>
        <h2 className="section">Talking rather than reading</h2>
        <p className="blurb">
          Call mode keeps answers to a few sentences and reads them out, so a
          conversation can happen without looking at the screen. Asking to see
          the map or the ideas opens them.
        </p>
        <div className="row">
          <button
            className={s.call_mode ? "btn on" : "btn"}
            onClick={() => void update({ call_mode: !s.call_mode })}
          >
            {s.call_mode ? "Call mode on" : "Call mode off"}
          </button>
          <button
            className={s.voice === "system" ? "btn on" : "btn"}
            onClick={() =>
              void update({ voice: s.voice === "system" ? "off" : "system" })
            }
          >
            {s.voice === "system" ? "Reading replies aloud" : "Read replies aloud"}
          </button>
        </div>
        <p className="blurb">
          Uses the voice this machine is already set up with, so nothing is
          downloaded and whatever rate and voice you have configured is what you
          get.
        </p>
      </section>

      <section>
        <h2 className="section">The model that runs in the app</h2>
        <p className="blurb">
          Only applies to the bundled model. These are the settings that decide
          whether it is pleasant or painful on a given machine.
        </p>

        <div className="row runtime-row">
          <label htmlFor="ctx">Context length</label>
          <select
            id="ctx"
            className="field"
            value={s.runtime.context_length}
            onChange={(e) =>
              void update({
                runtime: { ...s.runtime, context_length: Number(e.target.value) },
              })
            }
          >
            {[4096, 8192, 16384, 32768, 65536, 131072, 262144].map((n) => (
              <option key={n} value={n}>
                {n >= 1024 ? `${n / 1024}K tokens` : `${n} tokens`}
              </option>
            ))}
          </select>
        </div>

        <div className="row runtime-row">
          <label htmlFor="gpu">GPU offload</label>
          <input
            id="gpu"
            type="range"
            className="scale-slider"
            min={0}
            max={64}
            step={1}
            value={s.runtime.gpu_layers}
            onChange={(e) =>
              setS({ ...s, runtime: { ...s.runtime, gpu_layers: Number(e.target.value) } })
            }
            onMouseUp={() => void update({ runtime: s.runtime })}
            onKeyUp={() => void update({ runtime: s.runtime })}
          />
          <span className="scale-value">
            {s.runtime.gpu_layers === 0 ? "CPU only" : `${s.runtime.gpu_layers} layers`}
          </span>
        </div>

        <div className="row">
          <button
            className={s.runtime.kv_cache_on_gpu ? "btn on" : "btn"}
            onClick={() =>
              void update({
                runtime: { ...s.runtime, kv_cache_on_gpu: !s.runtime.kv_cache_on_gpu },
              })
            }
          >
            KV cache in GPU memory
          </button>
          <button
            className={s.runtime.keep_in_memory ? "btn on" : "btn"}
            onClick={() =>
              void update({
                runtime: { ...s.runtime, keep_in_memory: !s.runtime.keep_in_memory },
              })
            }
          >
            Keep model loaded
          </button>
        </div>
        <p className="blurb">
          The KV cache is faster on the GPU but takes memory the chat model may
          want. Keeping the model loaded avoids a reload each session and holds
          the memory meanwhile.
        </p>
      </section>

      <section>
        <h2 className="section">Ending a session</h2>
        <p className="blurb">Idle timeout before a session is filed.</p>
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
        <p className="path">{dir}</p>
      </section>

      <section>
        <h2 className="section">Dictation</h2>
        {speech?.installed ? (
          <p className="blurb">Installed, runs on the CPU.</p>
        ) : downloading ? (
          <p className="blurb">
            Downloading… {Math.round((downloading.received / (downloading.total || 1)) * 100)}%
          </p>
        ) : (
          <>
            <p className="blurb">About {speech?.mb ?? 488}MB, once, offline.</p>
            <button className="btn" onClick={() => void downloadSpeechModel()}>
              Download the speech model
            </button>
          </>
        )}
      </section>

      <section>
        <h2 className="section">Re-read every conversation</h2>
        <p className="blurb">
          Re-extracts ideas from every conversation. The conversations
          themselves are untouched.
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
          <li>The chat is asked to argue rather than agree — the same fixed instruction every time, regardless of model. Nothing about this app or its extraction is added.</li>
          <li>Nothing leaves this machine unless a remote model is chosen in Models.</li>
        </ul>
      </section>
    </div>
  );
}
