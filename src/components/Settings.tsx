import { useEffect, useState } from "react";
import {
  applyTheme,
  applyUiScale,
  getSettings,
  installLlamaServer,
  installVoice,
  onServerDownload,
  onVoiceDownload,
  embeddedStatus,
  reextractAll,
  saveSettings,
  transcriptsDir,
  voiceStatus,
  type EmbeddedStatus,
  type Runtime,
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

/**
 * Every knob the embedded model is started with, in one place.
 *
 * Two groups, because they answer different questions. The first is whether it
 * runs at all on this machine; the second is how it sounds. Mixing them means
 * someone hunting for "why is this slow" reads four sampling settings first.
 */
const LOADING: {
  key: keyof Runtime;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "gpu_layers", label: "GPU layers", hint: "0 keeps everything on the CPU", min: 0, max: 128, step: 1 },
  { key: "context_length", label: "Context", hint: "tokens held at once — costs memory", min: 512, max: 262144, step: 512 },
  { key: "batch_size", label: "Batch", hint: "tokens per pass; larger fills a GPU better", min: 32, max: 4096, step: 32 },
  { key: "threads", label: "CPU threads", hint: "0 lets it decide from the machine", min: 0, max: 64, step: 1 },
  { key: "parallel", label: "Parallel", hint: "conversations answered at once; each takes a slice of the context", min: 1, max: 8, step: 1 },
];

const SAMPLING: {
  key: keyof Runtime;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "temperature", label: "Temperature", hint: "how adventurous the wording is", min: 0, max: 2, step: 0.05 },
  { key: "top_p", label: "Top P", hint: "share of the probability mass considered", min: 0.05, max: 1, step: 0.01 },
  { key: "top_k", label: "Top K", hint: "how many candidates are considered at all", min: 0, max: 200, step: 1 },
  { key: "repeat_penalty", label: "Repeat penalty", hint: "pressure against repeating itself; 1 is off", min: 1, max: 2, step: 0.01 },
];

const SWITCHES: { key: keyof Runtime; label: string; hint: string }[] = [
  { key: "kv_cache_on_gpu", label: "KV cache on the GPU", hint: "faster, at the cost of VRAM the model wants" },
  { key: "flash_attention", label: "Flash attention", hint: "fused kernels where the backend has them" },
  { key: "mlock", label: "Lock in RAM", hint: "stops the OS paging the weights out" },
  { key: "keep_in_memory", label: "Keep loaded", hint: "hold the weights between sessions instead of reloading" },
];

export default function Settings({
  folder,
  folderName,
}: {
  folder: number | null;
  folderName: string;
}) {
  const [s, setS] = useState<S | null>(null);
  const [dir, setDir] = useState("");
  const [speech, setSpeech] = useState<{ installed: boolean; mb: number } | null>(null);
  const [voice, setVoice] = useState<{ installed: boolean; download_mb: number } | null>(null);
  const [server, setServer] = useState<EmbeddedStatus | null>(null);
  const [fetching, setFetching] = useState<{ what: string; received: number; total: number } | null>(
    null,
  );
  const [downloading, setDownloading] = useState<DownloadProgress | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Null while nothing is pending, otherwise the scope being confirmed. */
  const [confirming, setConfirming] = useState<"folder" | "all" | null>(null);

  useEffect(() => {
    void getSettings().then(setS);
    void transcriptsDir().then(setDir);
    void speechModelStatus()
      .then((x) => setSpeech({ installed: x.installed, mb: x.download_mb }))
      .catch(() => {});
    void voiceStatus().then(setVoice).catch(() => {});
    void embeddedStatus().then(setServer).catch(() => {});
    const p = onDownloadProgress(setDownloading);
    const q = onServerDownload(setFetching);
    const r = onVoiceDownload(setFetching);
    return () => {
      void p.then((un) => un());
      void q.then((un) => un());
      void r.then((un) => un());
    };
  }, []);

  function setRuntime(patch: Partial<Runtime>) {
    if (!s) return;
    void update({ runtime: { ...s.runtime, ...patch } });
  }

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
            onClick={() => void update({ voice: s.voice === "system" ? "off" : "system" })}
          >
            This machine's voice
          </button>
          <button
            className={s.voice === "neural" ? "btn on" : "btn"}
            disabled={!voice?.installed}
            onClick={() => void update({ voice: s.voice === "neural" ? "off" : "neural" })}
          >
            Downloaded voice
          </button>
        </div>
        <p className="blurb">
          The machine's own voice needs nothing downloaded and honours the rate
          and voice you have already configured — which, if you rely on speech,
          is usually the one you want. The downloaded voice sounds better and
          runs on the CPU.
        </p>
        {!voice?.installed &&
          (fetching?.what === "voice" ? (
            <p className="blurb">
              Downloading the voice…{" "}
              {Math.round((fetching.received / (fetching.total || 1)) * 100)}%
            </p>
          ) : (
            <button
              className="btn"
              onClick={() =>
                installVoice()
                  .then(() => voiceStatus().then(setVoice))
                  .catch((e) => setError(String(e)))
              }
            >
              Download the voice · {voice?.download_mb ?? 78}MB
            </button>
          ))}
      </section>

      <section>
        <h2 className="section">Recall</h2>
        <p className="blurb">
          Hands the conversation the titles of ideas already recorded in this
          folder, so it can say how what you are saying now bears on what you
          said before. Titles only — never the claims, the quotes, or the
          transcripts. This is the one thing the app adds to the chat that comes
          from your own words, which is why it can be switched off.
        </p>
        <div className="row">
          <button
            className={s.recall ? "btn on" : "btn"}
            onClick={() => void update({ recall: !s.recall })}
          >
            {s.recall ? "Connecting to earlier ideas" : "Answering each turn on its own"}
          </button>
        </div>
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
        <h2 className="section">The model this app runs</h2>
        <p className="blurb">
          These apply to the model the app starts itself. A model reached
          through LM Studio, Ollama, or an API is configured where it lives.
        </p>

        {server?.server_ready ? (
          <p className="path">{server.server_path}</p>
        ) : fetching?.what === "llama-server" ? (
          <p className="blurb">
            Fetching llama-server…{" "}
            {Math.round((fetching.received / (fetching.total || 1)) * 100)}%
          </p>
        ) : (
          <>
            <p className="blurb">
              No engine yet. The CPU build is one download; a GPU build is
              per-vendor, so if you have built llama.cpp yourself, putting
              <code> llama-server</code> on your PATH is preferred over this one.
            </p>
            <button
              className="btn"
              onClick={() =>
                installLlamaServer()
                  .then(() => embeddedStatus().then(setServer))
                  .catch((e) => setError(String(e)))
              }
            >
              Install llama-server
            </button>
          </>
        )}

        <h3 className="section sub">Loading</h3>
        <div className="params">
          {LOADING.map((f) => (
            <label key={f.key} className="param">
              <span className="param-name">{f.label}</span>
              <input
                className="field param-input"
                type="number"
                min={f.min}
                max={f.max}
                step={f.step}
                value={s.runtime[f.key] as number}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setRuntime({ [f.key]: v } as Partial<Runtime>);
                }}
              />
              <span className="param-hint">{f.hint}</span>
            </label>
          ))}
        </div>

        <h3 className="section sub">Sampling</h3>
        <p className="blurb">
          Left at llama.cpp's own defaults. Anything else would be this app
          quietly having an opinion about how every model should sound.
        </p>
        <div className="params">
          {SAMPLING.map((f) => (
            <label key={f.key} className="param">
              <span className="param-name">{f.label}</span>
              <input
                className="field param-input"
                type="number"
                min={f.min}
                max={f.max}
                step={f.step}
                value={s.runtime[f.key] as number}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setRuntime({ [f.key]: v } as Partial<Runtime>);
                }}
              />
              <span className="param-hint">{f.hint}</span>
            </label>
          ))}
        </div>

        <h3 className="section sub">Switches</h3>
        <div className="row wrap">
          {SWITCHES.map((f) => (
            <button
              key={f.key}
              className={s.runtime[f.key] ? "btn on" : "btn"}
              data-tip={f.hint}
              onClick={() => setRuntime({ [f.key]: !s.runtime[f.key] } as Partial<Runtime>)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <p className="blurb">
          Changes take effect the next time the model starts. Stop and start it
          in Models to apply them now.
        </p>
      </section>

      <section>
        <h2 className="section">Re-read conversations</h2>
        <p className="blurb">
          Discards the ideas and reads the conversations again — worth doing
          after the app has learned to read better. The conversations
          themselves are untouched.
        </p>
        {confirming ? (
          <div className="row">
            <button
              className="btn danger"
              onClick={() => {
                const scope = confirming === "folder" ? folder : null;
                setConfirming(null);
                reextractAll(scope)
                  .then((n) => setNote(`Re-reading ${n} conversation${n === 1 ? "" : "s"}.`))
                  .catch((e) => setError(String(e)));
              }}
            >
              {confirming === "folder" ? `Yes, re-read ${folderName}` : "Yes, re-read everything"}
            </button>
            <button className="btn" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="row">
            {/* Scoped first: fixing one line of thinking should not mean
                paying to re-read every other one. */}
            <button className="btn" onClick={() => setConfirming("folder")}>
              Re-read {folderName}
            </button>
            <button className="btn" onClick={() => setConfirming("all")}>
              Re-read every folder
            </button>
          </div>
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
          <li>With Recall on, the chat is also handed the <i>titles</i> of ideas already recorded in the folder you are in. Nothing else of yours reaches it, and turning Recall off removes even that.</li>
          <li>Nothing leaves this machine unless a remote model is chosen in Models.</li>
        </ul>
      </section>
    </div>
  );
}
