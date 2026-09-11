import { useEffect, useRef, useState } from "react";
import Sheet from "./Sheet";
import SpeakInto from "./SpeakInto";
import { useUndoable } from "../lib/undo";
import {
  OUTPUT_FORMATS,
  getSettings,
  saveSettings,
  type OutputFormat,
  type Preset,
} from "../lib/settings";

/**
 * The wording, in front of you, before it is sent.
 *
 * A preset used to fire the moment it was pressed: the whole instruction went
 * to the model unseen, and the only way to find out what a button actually
 * asked for was to open Settings in another tab and read it there. Which is
 * the wrong moment — the moment you want to argue with the wording is the
 * moment you are about to spend a minute of a model's time on it.
 *
 * Edits are kept as you make them. Not a Save button: this is the same
 * instruction the Settings tab edits, and an edit you made here and then
 * decided against sending would otherwise be lost on the way out — which
 * makes the box feel like a scratchpad you cannot trust with anything.
 */
export default function PresetPreview({
  preset,
  onStart,
  onClose,
}: {
  preset: Preset;
  onStart: (prompt: string, format: OutputFormat) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(preset.prompt);
  const [format, setFormat] = useState<OutputFormat>(preset.format ?? "markdown");
  const [saved, setSaved] = useState(false);
  const undo = useUndoable(prompt, setPrompt);

  // Held in a ref so the debounce always writes the latest, and so the
  // unmount below can flush whatever had not been written yet.
  const latest = useRef({ prompt, format });
  latest.current = { prompt, format };

  /** Write this preset's wording back into settings, leaving the rest alone. */
  async function keep() {
    const { prompt: p, format: f } = latest.current;
    if (p === preset.prompt && f === preset.format) return;
    const current = await getSettings();
    const presets = current.presets.map((x) =>
      x.id === preset.id ? { ...x, prompt: p, format: f } : x,
    );
    await saveSettings({ ...current, presets });
  }

  // A second after typing stops, not on every keystroke: this writes a file
  // and tells every window about it, and doing that per character would fight
  // the person typing.
  useEffect(() => {
    if (prompt === preset.prompt && format === preset.format) return;
    setSaved(false);
    const id = window.setTimeout(() => {
      void keep().then(() => setSaved(true));
    }, 900);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, format]);

  // Closing within the debounce window must not throw the edit away — that is
  // the whole promise this box makes.
  useEffect(
    () => () => {
      void keep().catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const chosen = OUTPUT_FORMATS.find((f) => f.value === format);

  return (
    <Sheet size="mid" onClose={onClose}>
      <div className="sheet-head">
        <h2 className="sheet-title">{preset.name}</h2>
      </div>
      <div className="sheet-body">
        <div className="pane-inner preset-preview">
          <label className="section" htmlFor="preset-preview-prompt">
            The instruction
          </label>
          <div className="dispute-box">
            <textarea
              id="preset-preview-prompt"
              className="field preset-prompt"
              rows={9}
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => undo(e)}
            />
            <SpeakInto
              onPhrase={(text) =>
                setPrompt((d) => (d ? `${d.replace(/\s+$/, "")} ${text}` : text))
              }
            />
          </div>

          <label className="section">What it should come out as</label>
          <div className="row">
            {OUTPUT_FORMATS.map((f) => (
              <button
                key={f.value}
                className={format === f.value ? "btn on" : "btn"}
                data-tip={f.blurb}
                onClick={() => setFormat(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {chosen && <p className="blurb">{chosen.blurb}</p>}

          <div className="row preset-preview-bar">
            {/* The two decisions this sheet exists for, said in colour and
                sitting apart at the bottom centre: everything above is what
                will be sent, these are what happens to it. */}
            <button
              className="btn yes"
              disabled={!prompt.trim()}
              onClick={() => onStart(prompt.trim(), format)}
            >
              Send it
            </button>
            <button className="btn no" onClick={onClose}>
              Not yet
            </button>
            {/* Said rather than implied. An edit box with no save button is
                only trustworthy if it says so. */}
            <span className="row-meta">
              {saved ? "Kept — this is the wording from now on." : "Edits are kept as you make them."}
            </span>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
