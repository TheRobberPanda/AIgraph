import { useEffect, useState } from "react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import Fold from "./Fold";
import { useNoWheel } from "../lib/noWheel";
import Engine from "./Engine";
import {
  applyTheme,
  applyUiScale,
  getSettings,
  installVoice,
  onServerDownload,
  onVoiceDownload,
  saveSettings,
  embeddedStatus,
  transcriptsDir,
  setTranscriptsDir,
  voiceStatus,
  LANGUAGES,
  type EmbeddedStatus,
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
  const scaleRef = useNoWheel<HTMLInputElement>();
  const silenceRef = useNoWheel<HTMLInputElement>();
  const [s, setS] = useState<S | null>(null);
  const [dir, setDir] = useState("");
  const [dirError, setDirError] = useState("");

  /** Ask the OS for a folder, and only keep it if it can actually be used. */
  async function chooseDir() {
    setDirError("");
    const picked = await pickFolder({ directory: true, multiple: false, defaultPath: dir });
    if (typeof picked !== "string") return;
    await moveTranscripts(picked);
  }

  async function useDefaultDir() {
    setDirError("");
    await moveTranscripts("");
  }

  async function moveTranscripts(path: string) {
    try {
      setDir(await setTranscriptsDir(path));
    } catch (e) {
      setDirError(String(e));
    }
  }
  const [speech, setSpeech] = useState<{ installed: boolean; mb: number } | null>(null);
  const [voice, setVoice] = useState<{ installed: boolean; download_mb: number } | null>(null);
  const [server, setServer] = useState<EmbeddedStatus | null>(null);
  const [fetching, setFetching] = useState<{ what: string; received: number; total: number } | null>(
    null,
  );
  const [downloading, setDownloading] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What is being fetched right now, so a button that has been pressed says
   *  so. A download with no sign of life reads as a dead button, and the
   *  second press is someone giving up on the first. */
  const [busy, setBusy] = useState<"server" | "voice" | null>(null);
  /** One section open at a time. Two open sections is most of the way back to
   *  the wall this replaced. */
  const [open, setOpen] = useState<string | null>(null);
  const fold = (id: string) => ({
    open: open === id,
    onToggle: () => setOpen((cur) => (cur === id ? null : id)),
  });

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

      <Fold title="Appearance" summary={THEMES.find((t) => t.value === s.theme)!.label} {...fold("appearance")}>
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
      </Fold>

      <Fold
        title="Language"
        summary={LANGUAGES.find((l) => l.value === s.language)!.label}
        {...fold("language")}
      >
        <p className="blurb">
          What the model answers in, and what your notes and ideas are written
          in. Left to follow what you write, a short first message is not much
          to go on and you can get an English answer to a Polish question.
          Naming the language settles it. Quotes are never translated: they are
          found by searching your own words for them.
        </p>
        <div className="row">
          {LANGUAGES.map((l) => (
            <button
              key={l.value}
              className={s.language === l.value ? "btn on" : "btn"}
              onClick={() => void update({ language: l.value })}
            >
              {l.label}
            </button>
          ))}
        </div>
      </Fold>

      <Fold title="Interface size" summary={`${s.ui_scale}%`} {...fold("scale")}>
                <div className="row scale-row">
          <input
            ref={scaleRef}
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
      </Fold>

      <Fold title="Talking rather than reading" summary={s.call_mode ? "call mode" : s.voice === "off" ? "silent" : s.voice === "neural" ? "downloaded voice" : "system voice"} {...fold("voice")}>
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
          Reading replies out is off unless you ask for it here. A call turns it
          on for the length of the call regardless — there is nothing to read in
          a call — and hanging up leaves this setting where you left it.
        </p>
        <p className="blurb">
          The machine's own voice needs nothing downloaded and honours the rate
          and voice you have already configured — which, if you rely on speech,
          is usually the one you want. The downloaded voice sounds better and
          runs on the CPU.
        </p>
        <div className="knobs">
          <div className="knob">
            <label className="knob-name">Pause before sending</label>
            <input
              ref={silenceRef}
              type="range"
              className="scale-slider"
              min={1}
              max={15}
              step={1}
              value={s.call_silence_seconds}
              onChange={(e) => setS({ ...s, call_silence_seconds: Number(e.target.value) })}
              onMouseUp={() => void update({ call_silence_seconds: s.call_silence_seconds })}
              onKeyUp={() => void update({ call_silence_seconds: s.call_silence_seconds })}
            />
            <span className="knob-value">{s.call_silence_seconds}s</span>
            <span className="knob-hint">
              How long a call waits after you stop talking before it sends what
              you said. Thinking out loud has pauses in it.
            </span>
          </div>
        </div>

        {!voice?.installed &&
          (fetching?.what === "voice" ? (
            <p className="blurb">
              Downloading the voice…{" "}
              {Math.round((fetching.received / (fetching.total || 1)) * 100)}%
            </p>
          ) : (
            <button
              className={busy === "voice" ? "btn busy" : "btn"}
              disabled={busy !== null}
              onClick={() => {
                setBusy("voice");
                setError(null);
                installVoice()
                  .then(() => voiceStatus().then(setVoice))
                  .catch((e) => setError(String(e)))
                  .finally(() => setBusy(null));
              }}
            >
              {busy === "voice" && <span className="spinner" aria-hidden="true" />}
              {busy === "voice"
                ? "Downloading…"
                : `Download the voice · ${voice?.download_mb ?? 78}MB`}
            </button>
          ))}
      </Fold>

      <Fold
        title="Thinking out loud"
        summary={s.reasoning ? "on" : "off"}
        {...fold("reasoning")}
      >
        <p className="blurb">
          Some models deliberate at length before answering. None of it is shown
          or recorded here — it is time between asking and hearing, and on a
          local model it is usually most of the wait. Off unless what you are
          asking is genuinely hard.
        </p>
        <div className="row">
          <button
            className={s.reasoning ? "btn on" : "btn"}
            onClick={() => void update({ reasoning: !s.reasoning })}
          >
            {s.reasoning ? "Thinking before answering" : "Answering directly"}
          </button>
        </div>
      </Fold>

      <Fold title="Recall" summary={s.recall ? "on" : "off"} {...fold("recall")}>
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
      </Fold>

      <Fold
        title="Ending a session"
        summary={
          !s.auto_file
            ? "when you say so"
            : s.idle_minutes < 60
              ? `${s.idle_minutes} min of quiet`
              : `${s.idle_minutes / 60} hr of quiet`
        }
        {...fold("idle")}
      >
        <p className="blurb">
          A conversation is filed when you press Done. It can also file itself
          once you have been quiet for a while, which is convenient until you
          walk away from something half-finished and come back to find it
          filed, read and turned into ideas.
        </p>
        <div className="row">
          <button
            className={s.auto_file ? "btn" : "btn on"}
            onClick={() => void update({ auto_file: false })}
          >
            Turned off
          </button>
          {[10, 30, 60, 120].map((m) => (
            <button
              key={m}
              className={s.auto_file && s.idle_minutes === m ? "btn on" : "btn"}
              onClick={() => void update({ auto_file: true, idle_minutes: m })}
            >
              After {m < 60 ? `${m} min` : `${m / 60} hr`} of quiet
            </button>
          ))}
        </div>
      </Fold>

      <Fold title="Transcripts" {...fold("transcripts")}>
        <p className="blurb">
          Every conversation is also written out as a plain Markdown file, so
          the record outlives this app. Move the folder and new transcripts go
          there; the ones already written stay where they are.
        </p>
        <p className="path">{dir}</p>
        {dirError && <p className="blurb warn">{dirError}</p>}
        <div className="row">
          <button className="btn" onClick={() => void chooseDir()}>
            Choose a folder
          </button>
          <button className="btn" onClick={() => void useDefaultDir()}>
            Back to the default
          </button>
        </div>
      </Fold>

      <Fold title="Dictation" summary={speech?.installed ? "installed" : "not installed"} {...fold("dictation")}>
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
      </Fold>

      <Fold
        title="The engine"
        summary={server?.server_ready ? server.server_build ?? "installed" : "none"}
        {...fold("engine")}
      >
        <p className="blurb">
          What actually runs a model the app holds itself. The CPU build works
          everywhere; the GPU build uses whatever graphics card is here,
          whoever made it, and is several times faster where there is one.
        </p>
        <Engine onChanged={() => void embeddedStatus().then(setServer).catch(() => {})} />
      </Fold>

      <Fold title="How this app uses AI" {...fold("ai")}>
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
      </Fold>
    </div>
  );
}
