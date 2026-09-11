import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useUndoable } from "../lib/undo";
import {
  importClaudeConversation,
  importConversation,
  importObsidianNote,
  listClaudeImports,
  listObsidianNotes,
  previewImport,
  type ClaudeImport,
  type Import,
  type ObsidianNote,
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
  const [mode, setMode] = useState<"paste" | "claude" | "obsidian">("paste");
  const [claude, setClaude] = useState<ClaudeImport[] | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [text, setText] = useState("");
  const undoText = useUndoable(text, setText);
  const [preview, setPreview] = useState<Import | null>(null);
  const [swap, setSwap] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The vault that was chosen, and the notes in it. */
  const [vault, setVault] = useState<string | null>(null);
  const [notes, setNotes] = useState<ObsidianNote[] | null>(null);

  useEffect(() => {
    if (mode !== "claude" || claude !== null) return;
    void listClaudeImports()
      .then(setClaude)
      .catch((e) => {
        setClaude([]);
        setError(String(e));
      });
  }, [mode, claude]);

  async function pickVault() {
    setError(null);
    const dir = await open({ directory: true, title: "Choose an Obsidian vault" });
    if (!dir) return;
    setVault(dir);
    setNotes(null);
    try {
      setNotes(await listObsidianNotes(dir));
    } catch (e) {
      setNotes([]);
      setError(String(e));
    }
  }

  async function keepNote(path: string) {
    setImporting(path);
    setError(null);
    try {
      await importObsidianNote(path, vaultName());
      setNotes((ns) => (ns ?? []).filter((n) => n.path !== path));
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(null);
    }
  }

  function vaultName(): string {
    if (!vault) return "";
    const parts = vault.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] ?? "";
  }

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
        <button className={mode === "obsidian" ? "btn on" : "btn"} onClick={() => setMode("obsidian")}>
          From an Obsidian vault
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
      ) : mode === "obsidian" ? (
        <>
          <div className="row">
            <button className="btn" onClick={() => void pickVault()}>
              {vault ? "Choose another folder" : "Choose a vault folder…"}
            </button>
            {vault && <span className="muted row-main">{vault}</span>}
          </div>
          <p className="blurb">
            Each markdown note becomes one conversation — the note itself as your
            thinking, its frontmatter left behind. A note that holds a pasted
            transcript with speaker labels still keeps its roles.
          </p>
          {notes === null ? null : notes.length === 0 ? (
            <p className="blurb">
              {vault ? "No markdown notes found there." : ""}
            </p>
          ) : (
            <ul className="list claude-list obsidian-list">
              {notes.map((n) => (
                <li key={n.path} className="claude-row">
                  <button className="row-btn chat-row" onClick={() => void keepNote(n.path)}>
                    <span className="row-main">
                      <span className="chat-open">{n.title}</span>
                      <span className="chat-sub">
                        {n.modified ? longDate(n.modified) : ""}
                        {n.chars > 0 &&
                          ` · ${n.chars < 1024 ? `${n.chars} bytes` : `${Math.round(n.chars / 1024)} kB`}`}
                      </span>
                    </span>
                    <span className="row-meta">
                      {importing === n.path ? "importing…" : "Import"}
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
