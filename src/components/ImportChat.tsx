import { useState } from "react";
import { importConversation, previewImport, type Import } from "../lib/import";

const BASIS_NOTE: Record<string, string> = {
  recognised: "Speakers identified from their labels.",
  length_heuristic:
    "The labels weren’t recognised, so the wordier speaker was taken to be the assistant. Worth checking.",
  unlabelled:
    "No speaker labels found, so the whole thing is treated as one person thinking.",
};

/**
 * Bring in a conversation from somewhere else.
 *
 * Always previewed before it is kept. Getting the roles the wrong way round
 * would file an assistant's words as somebody's own thinking — the exact mistake
 * the quote verification exists to prevent — so the guess is shown and can be
 * reversed.
 */
export default function ImportChat({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Import | null>(null);
  const [swap, setSwap] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function look() {
    setError(null);
    try {
      setPreview(await previewImport(text));
      setSwap(false);
    } catch (e) {
      setError(String(e));
    }
  }

  async function keep() {
    setBusy(true);
    setError(null);
    try {
      await importConversation(text, swap, source);
      setText("");
      setPreview(null);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const shown = preview
    ? swap
      ? preview.turns.map((t) => ({
          ...t,
          role: t.role === "user" ? ("assistant" as const) : ("user" as const),
        }))
      : preview.turns
    : [];

  return (
    <div className="import">
      <h2 className="section">Add a conversation</h2>
      <p className="blurb">
        Paste an exchange from anywhere else. The speakers are detected from their
        labels — check the preview before keeping it, since only the human side
        becomes recorded ideas.
      </p>

      <textarea
        className="field"
        value={text}
        placeholder={"You: ...\nChatGPT: ..."}
        onChange={(e) => {
          setText(e.target.value);
          setPreview(null);
        }}
        rows={8}
      />

      <div className="row">
        <button className="btn" disabled={!text.trim()} onClick={() => void look()}>
          Check it
        </button>
        {preview && preview.turns.length > 0 && (
          <>
            <button className="btn" onClick={() => setSwap((s) => !s)}>
              Swap who’s who
            </button>
            <input
              className="field"
              placeholder="where it came from (optional)"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <button
              className={busy ? "btn busy" : "btn"}
              disabled={busy}
              onClick={() => void keep()}
            >
              {busy ? "Keeping…" : `Keep ${shown.length} turns`}
            </button>
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {preview && (
        <>
          <p className="blurb">{BASIS_NOTE[preview.basis]}</p>
          <div className="import-preview">
            {shown.slice(0, 8).map((t, i) => (
              <div key={i} className={`turn ${t.role}`}>
                <span className="import-role">
                  {t.role === "user" ? "thinking" : "assistant"}
                  {t.label && ` · ${t.label}`}
                </span>
                {t.text.length > 260 ? `${t.text.slice(0, 260)}…` : t.text}
              </div>
            ))}
            {shown.length > 8 && (
              <p className="muted">…and {shown.length - 8} more</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
