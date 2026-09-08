import { useEffect, useState } from "react";
import { useUndoable } from "../lib/undo";
import {
  importClaudeConversation,
  importConversation,
  listClaudeImports,
  previewImport,
  type ClaudeImport,
  type Import,
} from "../lib/import";
import { longDate } from "../lib/format";

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
  /** Paste is the general case; Claude's own logs on this machine are the
   *  pleasant one — no copy-paste, roles already known. */
  const [mode, setMode] = useState<"paste" | "claude">("paste");
  const [claude, setClaude] = useState<ClaudeImport[] | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [text, setText] = useState("");
  const undoText = useUndoable(text, setText);
  const [preview, setPreview] = useState<Import | null>(null);
  const [swap, setSwap] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "claude" || claude !== null) return;
    void listClaudeImports()
      .then(setClaude)
      .catch((e) => {
        setClaude([]);
        setError(String(e));
      });
  }, [mode, claude]);

  async function keepClaude(path: string) {
    setImporting(path);
    setError(null);
    try {
      await importClaudeConversation(path, "");
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(null);
    }
  }

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
      <div className="row source-tabs">
        <button className={mode === "paste" ? "btn on" : "btn"} onClick={() => setMode("paste")}>
          Paste
        </button>
        <button className={mode === "claude" ? "btn on" : "btn"} onClick={() => setMode("claude")}>
          From Claude on this machine
        </button>
      </div>

      {mode === "claude" ? (
        <>
          {claude === null ? (
            <p className="muted">Looking…</p>
          ) : claude.length === 0 ? (
            <p className="blurb">Nothing found there.</p>
          ) : (
            <ul className="list claude-list">
              {claude.map((c) => (
                <li key={c.path} className="claude-row">
                  <button className="row-btn chat-row" onClick={() => void keepClaude(c.path)}>
                    <span className="row-main">
                      <span className="chat-open">
                        {c.title || c.first || c.project}
                      </span>
                      <span className="chat-sub">
                        {c.project} · {c.modified ? longDate(c.modified) : ""} · {c.turns} turns
                      </span>
                    </span>
                    <span className="row-meta">
                      {importing === c.path ? "importing…" : "Import"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <textarea
            className="field"
            value={text}
            onKeyDown={(e) => void undoText(e)}
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
                {shown.length > 8 && <p className="muted">…and {shown.length - 8} more</p>}
              </div>
            </>
          )}
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
