import { useEffect, useState } from "react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useNoWheel } from "../lib/noWheel";
import Engine from "./Engine";
import {
  ACCENTS,
  applyAccent,
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
  resetPresets,
  reextractAll,
  voiceStatus,
  LANGUAGES,
  type EmbeddedStatus,
  type Settings as S,
  type Theme,
  MAP_STYLES,
} from "../lib/settings";
import Confirm from "./Confirm";

import {
  downloadSpeechModel,
  onDownloadProgress,
  speechModelStatus,
  type DownloadProgress,
} from "../lib/dictation";

const THEMES: { value: Theme; label: string }[] = [
  { value: "auto", label: "Match the system" },
  { value: "dark", label: "Dark" },
  { value: "ember", label: "Ember" },
  { value: "ink", label: "Ink" },
  { value: "slate", label: "Slate" },
  { value: "light", label: "Light" },
  { value: "paper", label: "Paper" },
];

type Category = "appearance" | "conversation" | "voice" | "engine" | "prompts" | "about";

/**
 * Settings, sorted by the question you arrive with.
 *
 * One list of categories on the left, one pane at a time on the right. It was
 * a single long scroll of folding sections, which made finding one setting a
 * scan and made every setting carry the cost of explaining itself in place.
 */
export default function Settings() {
  const scaleRef = useNoWheel<HTMLInputElement>();
  const silenceRef = useNoWheel<HTMLInputElement>();
  const [s, setS] = useState<S | null>(null);
  const [dir, setDir] = useState("");
  const [offerRedigest, setOfferRedigest] = useState<string | null>(null);
  const [redigesting, setRedigesting] = useState(false);
  const [redigestNote, setRedigestNote] = useState<string | null>(null);
  const [dirError, setDirError] = useState("");
  const [category, setCategory] = useState<Category>("appearance");

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
    if (patch.accent !== undefined) applyAccent(patch.accent);
    try {
      await saveSettings(next);
    } catch (e) {
      setError(String(e));
    }
  }

  if (!s) return <div className="pane-inner" />;

  const themeLabel = THEMES.find((t) => t.value === s.theme)!.label;
  const voiceLabel = s.call_mode
    ? "call mode"
    : s.voice === "off"
      ? "silent"
      : s.voice === "neural"
        ? "downloaded voice"
        : "system voice";

  const CATEGORIES: { id: Category; title: string; summary: string | null }[] = [
    { id: "appearance", title: "Appearance", summary: themeLabel },
    {
      id: "conversation",
      title: "Conversation",
      summary: s.chat_stance === "challenge" ? "pushes back" : "organizes",
    },
    { id: "voice", title: "Voice & dictation", summary: voiceLabel },
    {
      id: "engine",
      title: "Models & engine",
      summary: server?.server_ready ? server.server_build ?? "ready" : "none installed",
    },
    { id: "prompts", title: "Prompts", summary: `${s.presets.length} instructions` },
    { id: "about", title: "How this app uses AI", summary: null },
  ];

  return (
    <div className="pane-inner settings-wrap">
      <nav className="settings-nav">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={category === c.id ? "settings-cat on" : "settings-cat"}
            onClick={() => setCategory(c.id)}
          >
            <span className="settings-cat-title">{c.title}</span>
            {c.summary && <span className="settings-cat-summary">{c.summary}</span>}
          </button>
        ))}
      </nav>

      <div className="settings-pane">
        {error && <p className="error">{error}</p>}

        {category === "appearance" && (
          <>
            <h3 className="section">Theme</h3>
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

            <h3 className="section">Accent</h3>
            <p className="blurb">The colour of links, highlights and the chosen model.</p>
            <div className="row accent-row">
              {ACCENTS.map((a) => (
                <button
                  key={a.id || "default"}
                  className={s.accent === a.id ? "accent-swatch on" : "accent-swatch"}
                  data-tip={a.label}
                  aria-label={a.label}
                  onClick={() => void update({ accent: a.id })}
                  style={a.hex ? { ["--swatch" as string]: a.hex } : undefined}
                />
              ))}
            </div>

            <h3 className="section">The map</h3>
            <p className="blurb">
              How the map draws itself. Node size and line weight only — never
              what is on it.
            </p>
            <div className="row">
              {MAP_STYLES.map((m) => (
                <button
                  key={m.value}
                  className={s.map_style === m.value ? "btn on" : "btn"}
                  data-tip={m.blurb}
                  onClick={() => void update({ map_style: m.value })}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <h3 className="section">Interface size</h3>
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
                  // The number moves with the hand; the interface does not.
                  // Rescaling the whole app on every step of the drag moves
                  // the slider out from under the cursor as you use it, which
                  // makes the setting fight the person changing it.
                  setS({ ...s, ui_scale: Number(e.target.value) });
                }}
                onMouseUp={() => {
                  applyUiScale(s.ui_scale);
                  void update({ ui_scale: s.ui_scale });
                }}
                onKeyUp={() => {
                  applyUiScale(s.ui_scale);
                  void update({ ui_scale: s.ui_scale });
                }}
              />
              <span className="scale-value">{s.ui_scale}%</span>
              {s.ui_scale !== 100 && (
                <button className="btn" onClick={() => void update({ ui_scale: 100 })}>
                  Reset
                </button>
              )}
            </div>

            <h3 className="section">Advanced layout sides</h3>
            <p className="blurb">
              In the advanced layout: which side the conversations sit on. Make takes
              the other side; the thinking stays in the middle.
            </p>
            <div className="row">
              <button
                className={!s.advanced_swap ? "btn on" : "btn"}
                onClick={() => void update({ advanced_swap: false })}
              >
                Conversations right
              </button>
              <button
                className={s.advanced_swap ? "btn on" : "btn"}
                onClick={() => void update({ advanced_swap: true })}
              >
                Conversations left
              </button>
            </div>

            <h3 className="section">Language</h3>
            <p className="blurb">What the model answers in, and what your notes and ideas are written in.</p>
            <div className="row">
              {LANGUAGES.map((l) => (
                <button
                  key={l.value}
                  className={s.language === l.value ? "btn on" : "btn"}
                  onClick={() => {
                    const was = s.language;
                    void update({ language: l.value }).then(() => {
                      // Nothing already read gets rewritten on its own — the
                      // switch changes what happens from here forward, and
                      // whether to go back and redo the rest is a real question,
                      // not a side effect of picking a language.
                      if (l.value !== was) setOfferRedigest(l.label);
                    });
                  }}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </>
        )}

        {category === "conversation" && (
          <>
            <h3 className="section">How it responds</h3>
            <div className="row">
              <button
                className={s.chat_stance === "challenge" ? "btn on" : "btn"}
                onClick={() => void update({ chat_stance: "challenge" })}
              >
                Push back
              </button>
              <button
                className={s.chat_stance === "organize" ? "btn on" : "btn"}
                onClick={() => void update({ chat_stance: "organize" })}
              >
                Just organize
              </button>
            </div>
            <p className="blurb">
              Pushing back tests a thought; organizing lays it out without arguing.
            </p>

            <h3 className="section">Thinking before answering</h3>
            <div className="row">
              <button
                className={s.reasoning ? "btn on" : "btn"}
                onClick={() => void update({ reasoning: !s.reasoning })}
              >
                {s.reasoning ? "On" : "Off"}
              </button>
            </div>
            <p className="blurb">
              Reasoning models can deliberate at length first. None of it is shown or
              recorded here — on a local model it is most of the wait.
            </p>

            <h3 className="section">Recall</h3>
            <div className="row">
              <button
                className={s.recall ? "btn on" : "btn"}
                onClick={() => void update({ recall: !s.recall })}
              >
                {s.recall ? "Connecting to earlier ideas" : "Each turn on its own"}
              </button>
            </div>
            <p className="blurb">
              Hands the conversation the titles of ideas already recorded in this
              folder. Titles only — never claims, quotes, or transcripts.
            </p>

            <h3 className="section">Ending a session</h3>
            <div className="row">
              <button
                className={s.auto_file ? "btn" : "btn on"}
                onClick={() => void update({ auto_file: false })}
              >
                When you say so
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
            <p className="blurb">
              A conversation files when you press Done. It can also file itself after
              a stretch of quiet.
            </p>
          </>
        )}

        {category === "voice" && (
          <>
            <h3 className="section">Reading replies aloud</h3>
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
              Call mode keeps answers to a few sentences and reads them out. Reading
              aloud is off unless you ask; a call turns it on for its length and
              hanging up leaves this where you left it.
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

            <h3 className="section">Dictation</h3>
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

            {!voice?.installed &&
              (fetching?.what === "voice" ? (
                <p className="blurb">
                  Downloading the voice…{" "}
                  {Math.round((fetching.received / (fetching.total || 1)) * 100)}%
                </p>
              ) : (
                <div className="row" style={{ marginTop: "0.6rem" }}>
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
                </div>
              ))}
          </>
        )}

        {category === "engine" && (
          <>
            <h3 className="section">The engine</h3>
            <p className="blurb">
              What runs a model the app holds itself. The CPU build works everywhere;
              the GPU build is several times faster where there is a graphics card.
              Models themselves are picked from the chip at the top of the
              conversation.
            </p>
            <Engine onChanged={() => void embeddedStatus().then(setServer).catch(() => {})} />
          </>
        )}

        {category === "prompts" && (
          <>
            <h3 className="section">What the Make buttons ask for</h3>
            <p className="blurb">
              Each button on the Make tab sends the wording below, with the folder's
              conversations in front of the model.
            </p>
            {s.presets.map((preset, i) => (
              <div key={preset.id} className="preset">
                <input
                  className="field preset-name"
                  value={preset.name}
                  onChange={(e) => {
                    const presets = [...s.presets];
                    presets[i] = { ...preset, name: e.target.value };
                    setS({ ...s, presets });
                  }}
                  onBlur={() => void update({ presets: s.presets })}
                />
                <textarea
                  className="field preset-prompt"
                  rows={4}
                  value={preset.prompt}
                  onChange={(e) => {
                    const presets = [...s.presets];
                    presets[i] = { ...preset, prompt: e.target.value };
                    setS({ ...s, presets });
                  }}
                  // Saved on leaving the box rather than on every keystroke: this
                  // writes a file and emits to every window, and doing that per
                  // character would fight the person typing.
                  onBlur={() => void update({ presets: s.presets })}
                />
              </div>
            ))}
            <div className="row">
              <button
                className="btn"
                onClick={() => resetPresets().then(setS).catch((e) => setError(String(e)))}
              >
                Put them all back
              </button>
            </div>
            <h3 className="section">Transcripts</h3>
            <p className="blurb">
              Every conversation is also written out as a plain Markdown file, so the
              record outlives this app. New transcripts go to the folder chosen here.
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

          </>
        )}

        {category === "about" && (
          <>
            {/* Stated in the app, not only in a README. Someone using this to think
                through something that matters deserves to know what is machine-made
                without going looking for it. */}
            <ul className="plain-list">
              <li>Ideas are recorded by a model taking notes. It can misread, so every idea links back to the exact words it came from.</li>
              <li>An idea the model cannot quote is discarded rather than shown. The Ideas page reports how often that happens.</li>
              <li>Notes in the margin are the model's, marked <b>AI</b>, and never become recorded ideas.</li>
              <li>The chat runs on one of two fixed instructions, chosen in <i>Conversation</i> — arguing the substance, or organizing it without arguing — the same one every time regardless of model. Nothing about this app or its extraction is added.</li>
              <li>With Recall on, the chat is also handed the <i>titles</i> of ideas already recorded in the folder you are in. Nothing else of yours reaches it, and turning Recall off removes even that.</li>
              <li>Nothing leaves this machine unless a remote model is chosen in Models.</li>
            </ul>
          </>
        )}

        {redigesting && <p className="blurb">Reading everything again…</p>}
        {redigestNote && <p className="blurb">{redigestNote}</p>}
      </div>

      {offerRedigest && (
        <Confirm
          title={`Read everything again in ${offerRedigest}? Ideas already recorded keep the language they were written in — only conversations you re-read from now on come out in ${offerRedigest}.`}
          onCancel={() => setOfferRedigest(null)}
          onConfirm={() => {
            setOfferRedigest(null);
            setRedigesting(true);
            setRedigestNote(null);
            reextractAll()
              .then((n) =>
                setRedigestNote(
                  n > 0
                    ? `Reading ${n} conversation${n === 1 ? "" : "s"} again in ${offerRedigest}.`
                    : "Nothing to read again yet.",
                ),
              )
              .catch((e) => setRedigestNote(String(e)))
              .finally(() => setRedigesting(false));
          }}
        />
      )}
    </div>
  );
}
