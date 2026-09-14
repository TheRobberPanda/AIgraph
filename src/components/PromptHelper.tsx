import { useState } from "react";
import { OUTPUT_FORMATS, writePresetPrompt, type Preset } from "../lib/settings";
import { IconTrash } from "./Icons";
import { Section } from "./Hint";

/**
 * Write a Make instruction by showing rather than describing.
 *
 * Paste text that looks like what you want back, list what it must never do,
 * and the model writes the instruction out in full. It lands in an editable
 * box, not straight into the list: the wording is yours to argue with before
 * it becomes a button.
 */
export default function PromptHelper({ onAdd }: { onAdd: (p: Preset) => void }) {
  const [sample, setSample] = useState("");
  const [avoid, setAvoid] = useState<string[]>([""]);
  const [written, setWritten] = useState("");
  const [name, setName] = useState("");
  const [format, setFormat] = useState<Preset["format"]>("markdown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function write() {
    setBusy(true);
    setError(null);
    try {
      setWritten(await writePresetPrompt(sample, avoid));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function add() {
    onAdd({
      id: `own-${Date.now().toString(36)}`,
      name: name.trim(),
      prompt: written.trim(),
      format,
    });
    setSample("");
    setAvoid([""]);
    setWritten("");
    setName("");
  }

  return (
    <div className="prompt-helper">
      <Section
        hint={
          <>
            Paste something that reads the way you want the result to read, say
            what it must never do, and the model writes the instruction for you.
          </>
        }
      >
        Write one from an example
      </Section>

      <label className="prompt-helper-label">What the result should look like</label>
      <textarea
        className="field preset-prompt"
        rows={6}
        placeholder="Paste a passage written the way you want yours written."
        value={sample}
        onChange={(e) => setSample(e.target.value)}
      />

      <label className="prompt-helper-label">What it must never do</label>
      {avoid.map((a, i) => (
        <div key={i} className="prompt-helper-avoid">
          <span className="muted">Don't</span>
          <input
            className="field"
            placeholder={["sound robotic", "use words that are not mine", "add lists"][i % 3]}
            value={a}
            onChange={(e) => setAvoid(avoid.map((x, j) => (j === i ? e.target.value : x)))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && a.trim()) setAvoid([...avoid, ""]);
            }}
          />
          {avoid.length > 1 && (
            <button
              className="icon-btn preset-remove"
              aria-label="Remove this rule"
              onClick={() => setAvoid(avoid.filter((_, j) => j !== i))}
            >
              <IconTrash />
            </button>
          )}
        </div>
      ))}
      <div className="row">
        <button className="btn" onClick={() => setAvoid([...avoid, ""])}>
          Add another
        </button>
        <button className="btn on" disabled={busy || !sample.trim()} onClick={() => void write()}>
          {busy ? "Writing…" : written ? "Write it again" : "Write the prompt"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {written && (
        <div className="preset">
          <div className="preset-top">
            <input
              className="field preset-name"
              placeholder="Name the button"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <textarea
            className="field preset-prompt"
            rows={10}
            value={written}
            onChange={(e) => setWritten(e.target.value)}
          />
          <div className="row preset-formats">
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
          <div className="row">
            <button className="btn on" disabled={!name.trim() || !written.trim()} onClick={add}>
              Add it to Make
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
