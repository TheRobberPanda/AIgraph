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
  OUTPUT_FORMATS,
} from "../lib/settings";
import Confirm from "./Confirm";
import { IconTrash } from "./Icons";
import Hint, { Section } from "./Hint";

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
  /** Which instruction is one more click from being deleted. */
  const [removing, setRemoving] = useState<string | null>(null);
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
      summary:
        s.chat_stance === "challenge"
          ? "pushes back"
          : s.chat_stance === "organize"
            ? "lays it out"
            : "default",
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
            <Section
              hint={
                <>
                  The app used to explain itself in a paragraph beside almost
                  every control. Read once, those stop being help and become
                  furniture. They are all still here — this puts them back on
                  the page instead of under the mark you just hovered.
                </>
              }
            >
              Explanations
            </Section>
            <div className="row">
              <button
                className={s.show_explanations ? "btn on" : "btn"}
                onClick={() => void update({ show_explanations: !s.show_explanations })}
              >
                {s.show_explanations ? "On the page" : "Under a hint"}
              </button>
            </div>

            <Section>Theme</Section>
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

            <Section hint="The colour of links, highlights and the chosen model.">
              Accent
            </Section>
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

            <Section
              hint={
                <>
                  Three ways of standing the same material up. None of them
                  hides anything.
                </>
              }
            >
              The map
            </Section>
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

            {/* The galaxy's hidden layer. Offered here and nowhere else —
                the map's own arrange panel keeps the three arrangements it is
                for, and this is the sort of thing found in Settings. */}
            {s.map_style === "galaxy" && (
              <>
                <Section
                  hint="A quiet extra for the galaxy: each node is drawn as a world, lit from one side, with bands or craters. The colour is still the subject's."
                >
                  The secret one
                </Section>
                <div className="row">
                  <button
                    className={s.secret_galaxy ? "btn on" : "btn"}
                    onClick={() => void update({ secret_galaxy: !s.secret_galaxy })}
                  >
                    {s.secret_galaxy ? "Worlds, lit" : "Plain points"}
                  </button>
                </div>
              </>
            )}
            {s.map_style === "forest" && (
              <>
                <Section
                  hint="A quiet extra for the forest: each conversation grows its own kind of tree — acacia, baobab, oak, birch or fir."
                >
                  The secret one
                </Section>
                <div className="row">
                  <button
                    className={s.secret_trees ? "btn on" : "btn"}
                    onClick={() => void update({ secret_trees: !s.secret_trees })}
                  >
                    {s.secret_trees ? "Mixed woodland" : "Firs only"}
                  </button>
                </div>
              </>
            )}

            <Section
              hint="Locked, nothing on the map can be dragged out of place. Clicking still opens a node."
            >
              Moving nodes
            </Section>
            <div className="row">
              <button
                className={!s.map_lock_nodes ? "btn on" : "btn"}
                onClick={() => void update({ map_lock_nodes: false })}
              >
                Free
              </button>
              <button
                className={s.map_lock_nodes ? "btn on" : "btn"}
                onClick={() => void update({ map_lock_nodes: true })}
              >
                Locked
              </button>
            </div>

            <Section>Interface size</Section>
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

            <Section
              hint={
                <>
                  In the advanced layout: which side the conversations sit on.
                  Make takes the other side; the thinking stays in the middle.
                </>
              }
            >
              Advanced layout sides
            </Section>
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

            <Section hint="What the model answers in, and what your notes and ideas are written in.">
              Language
            </Section>
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
            <Section
              hint={
                <>
                  Pushing back tests a thought; laying it out sorts it without
                  arguing. This also decides what the margin notes on an idea
                  say: pushing back keeps the doubts, laying out keeps the
                  summary, and the default keeps both.
                </>
              }
            >
              How it responds
            </Section>
            <div className="row">
              <button
                className={s.chat_stance === "neutral" ? "btn on" : "btn"}
                onClick={() => void update({ chat_stance: "neutral" })}
              >
                Default
              </button>
              <button
                className={s.chat_stance === "challenge" ? "btn on" : "btn"}
                onClick={() => void update({ chat_stance: "challenge" })}
              >
                Push back
              </button>
              {/* Renamed in the interface only. The stored value stays
                  "organize" — it is in everyone's settings file already, and
                  a rename that reaches the disk costs a migration to buy
                  nothing. */}
              <button
                className={s.chat_stance === "organize" ? "btn on" : "btn"}
                onClick={() => void update({ chat_stance: "organize" })}
              >
                Lay it out
              </button>
            </div>
            <Section
              hint={
                <>
                  Reasoning models can deliberate at length first. None of it is
                  shown or recorded here — on a local model it is most of the
                  wait.
                </>
              }
            >
              Thinking before answering
            </Section>
            <div className="row">
              <button
                className={s.reasoning ? "btn on" : "btn"}
                onClick={() => void update({ reasoning: !s.reasoning })}
              >
                {s.reasoning ? "On" : "Off"}
              </button>
            </div>
            <Section
              hint={
                <>
                  Hands the conversation the titles of ideas already recorded in
                  this folder. Titles only — never claims, quotes, or
                  transcripts.
                </>
              }
            >
              Recall
            </Section>
            <div className="row">
              <button
                className={s.recall ? "btn on" : "btn"}
                onClick={() => void update({ recall: !s.recall })}
              >
                {s.recall ? "Connecting to earlier ideas" : "Each turn on its own"}
              </button>
            </div>
            <Section
              hint={
                <>
                  A conversation files when you press Done. It can also file
                  itself after a stretch of quiet.
                </>
              }
            >
              Ending a session
            </Section>
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
          </>
        )}

        {category === "voice" && (
          <>
            <Section
              hint={
                <>
                  Call mode is like a call with your ideas: answers stay a few
                  sentences long and are read out. Reading aloud is off unless
                  you ask; a call turns it on for its length and hanging up
                  leaves this where you left it.
                </>
              }
            >
              Reading replies aloud
            </Section>
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
            <div className="knobs">
              <div className="knob">
                <label className="knob-name">Pause before sending</label>
                <input
                  ref={silenceRef}
                  type="range"
                  className="scale-slider"
                  min={0}
                  max={15}
                  step={1}
                  value={s.call_silence_seconds}
                  onChange={(e) => setS({ ...s, call_silence_seconds: Number(e.target.value) })}
                  onMouseUp={() => void update({ call_silence_seconds: s.call_silence_seconds })}
                  onKeyUp={() => void update({ call_silence_seconds: s.call_silence_seconds })}
                />
                <span className="knob-value">
                  {s.call_silence_seconds > 0 ? `${s.call_silence_seconds}s` : "off"}
                </span>
                <span className="knob-hint">
                  How long a call waits after you stop talking before it sends what
                  you said. Thinking out loud has pauses in it. At zero nothing
                  sends itself — what you said waits for Send.
                </span>
              </div>
            </div>

            <Section>Dictation</Section>
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
            <Section
              hint={
                <>
                  What runs a model the app holds itself. The CPU build works
                  everywhere; the GPU build is several times faster where there
                  is a graphics card. Models themselves are picked from the chip
                  at the top of the conversation.
                </>
              }
            >
              The engine
            </Section>
            <Engine onChanged={() => void embeddedStatus().then(setServer).catch(() => {})} />
          </>
        )}

        {category === "prompts" && (
          <>
            <Section
              hint={
                <>
                  Each button sends the wording below, with the folder in front
                  of the model.
                </>
              }
            >
              What the Make buttons ask for
            </Section>
            {s.presets.map((preset, i) => (
              <div key={preset.id} className="preset">
                {/* The name and its way out on one line. "Remove" was a
                    full-width button under the wording, the same size and
                    weight as everything else on the page — the largest thing
                    in the block was the one that destroys it. */}
                <div className="preset-top">
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
                {/* Still two presses, like everything else here that destroys
                    something: an instruction somebody wrote out is not worth
                    losing to a stray click. The first press names what is
                    about to go, which an icon on its own cannot. */}
                {removing === preset.id ? (
                  <button
                    className="btn armed"
                    onMouseLeave={() => setRemoving(null)}
                    onClick={() => {
                      setRemoving(null);
                      const presets = s.presets.filter((x) => x.id !== preset.id);
                      setS({ ...s, presets });
                      void update({ presets });
                    }}
                  >
                    Delete “{preset.name}”
                  </button>
                ) : (
                  <button
                    className="icon-btn preset-remove"
                    data-tip={`Remove “${preset.name}”`}
                    aria-label={`Remove ${preset.name}`}
                    onClick={() => setRemoving(preset.id)}
                  >
                    <IconTrash />
                  </button>
                )}
                </div>
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
                {/* What it is asking to be made, beside the wording that asks
                    for it. The shape reaches the model — a deck and an essay
                    are not the same text in two wrappers — so it belongs with
                    the instruction rather than on the Save button. */}
                <div className="row preset-formats">
                  {OUTPUT_FORMATS.map((f) => (
                    <button
                      key={f.value}
                      className={(preset.format ?? "markdown") === f.value ? "btn on" : "btn"}
                      data-tip={f.blurb}
                      onClick={() => {
                        const presets = [...s.presets];
                        presets[i] = { ...preset, format: f.value };
                        setS({ ...s, presets });
                        void update({ presets });
                      }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="row">
              <button
                className="btn"
                onClick={() => resetPresets().then(setS).catch((e) => setError(String(e)))}
              >
                Put them all back
              </button>
              <Hint>
                Restores the instructions the app ships with. Anything you
                wrote yourself is kept — this adds the originals back beside
                it, and undoes edits to the ones that came with the app.
              </Hint>
            </div>
            <Section
              hint={
                <>
                  Every conversation is also written out as Markdown, so the
                  record outlives this app.
                </>
              }
            >
              Transcripts
            </Section>
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
