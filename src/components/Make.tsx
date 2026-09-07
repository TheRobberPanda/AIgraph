import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  composeClear,
  composeLoad,
  composeSend,
  onComposeToken,
  saveText,
  type Packed,
} from "../lib/compose";
import { getSettings, onSettingsChanged, type Preset } from "../lib/settings";
import { listFolders, ROOT_FOLDER, type Folder } from "../lib/folders";
import Markdown from "./Markdown";
import { IconSend } from "./Icons";

interface Exchange {
  asked: string;
  answer: string;
}

/**
 * Making something out of a folder, rather than reading something out of it.
 *
 * The map and the ideas are what the app *took* from these conversations. This
 * is the conversations themselves, handed whole to a model, so they can become
 * something else — a book, a script, an essay, or whatever gets typed in.
 *
 * The buttons are only saved instructions. Pressing one puts its wording in
 * the box and sends it, so what happened is visible and arguable rather than
 * hidden behind a label — and the wording itself is editable in Settings.
 */
export default function Make({ folder }: { folder: number | null }) {
  const [packed, setPacked] = useState<Packed | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [thread, setThread] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const here = folders.find((f) => f.id === (folder ?? ROOT_FOLDER))?.name ?? "this folder";

  useEffect(() => {
    void listFolders().then(setFolders);
  }, []);

  // The instructions are settings, so they follow edits made in the other tab
  // without needing this one reopened.
  useEffect(() => {
    void getSettings().then((s) => setPresets(s.presets));
    const p = onSettingsChanged((s) => setPresets(s.presets));
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // Changing folder changes the material, so the thread it produced goes with
  // it — answers about one folder sitting under another folder's heading would
  // be worse than losing them.
  useEffect(() => {
    setPacked(null);
    setThread([]);
    setError(null);
    composeLoad(folder)
      .then(setPacked)
      .catch((e) => setError(String(e)));
  }, [folder]);

  useEffect(() => {
    const p = onComposeToken((text) =>
      setThread((t) => {
        if (t.length === 0) return t;
        const next = [...t];
        next[next.length - 1] = {
          ...next[next.length - 1],
          answer: next[next.length - 1].answer + text,
        };
        return next;
      }),
    );
    return () => {
      void p.then((un) => un());
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread]);

  const ask = useCallback(async (instruction: string) => {
    const text = instruction.trim();
    if (!text) return;
    setError(null);
    setSaved(null);
    setBusy(true);
    setDraft("");
    setThread((t) => [...t, { asked: text, answer: "" }]);
    try {
      const reply = await composeSend(text);
      setThread((t) => {
        const next = [...t];
        next[next.length - 1] = { ...next[next.length - 1], answer: reply };
        return next;
      });
    } catch (e) {
      setError(String(e));
      // The question goes too — it never reached the model, and leaving it on
      // screen under an error reads as an answer that failed rather than one
      // that was never asked.
      setThread((t) => t.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }, []);

  async function keep(answer: string) {
    const path = await save({
      title: "Save this",
      defaultPath: `${here.replace(/[/\\?%*:|"<>]/g, "-")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }, { name: "Text", extensions: ["txt"] }],
    });
    if (!path) return;
    try {
      setSaved(`Saved to ${await saveText(path, answer)}`);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="pane-inner make">
      <div className="make-head">
        <span className="row-main">
          Making something out of <strong>{here}</strong>
        </span>
        {packed && (
          <span className="row-meta">
            {packed.conversations}{" "}
            {packed.conversations === 1 ? "conversation" : "conversations"} in front of it
            {packed.dropped > 0 && ` · ${packed.dropped} too old to fit`}
            {packed.shortened > 0 && ` · ${packed.shortened} replies shortened`}
          </span>
        )}
      </div>

      {/* The instructions, as buttons. Pressing one fills the box below with
          its wording and sends it — nothing happens that you cannot see. */}
      <div className="make-presets">
        {presets.map((p) => (
          <button
            key={p.id}
            className="btn"
            disabled={busy || !packed}
            data-tip={p.prompt}
            onClick={() => void ask(p.prompt)}
          >
            {p.name}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      {saved && <p className="blurb">{saved}</p>}

      <div className="make-thread">
        {thread.length === 0 && packed && (
          <p className="empty">
            <strong>Ask for something.</strong>
            <span className="muted">
              {" "}
              Everything said in {here} is in front of the model — the conversations
              themselves, not the ideas taken out of them.
            </span>
          </p>
        )}

        {thread.map((x, i) => (
          <div key={i} className="make-turn">
            <p className="make-asked">{x.asked}</p>
            <div className="make-answer">
              {x.answer ? <Markdown>{x.answer}</Markdown> : <span className="spinner" aria-hidden="true" />}
            </div>
            {x.answer && !busy && (
              <button className="btn" onClick={() => void keep(x.answer)}>
                Save this
              </button>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="composer-box make-box">
        <textarea
          value={draft}
          placeholder={packed ? "Or ask for something else" : "Loading the folder…"}
          disabled={!packed || busy}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(draft);
            }
          }}
        />
        <div className="bar">
          {thread.length > 0 && (
            <button
              className="btn"
              disabled={busy}
              data-tip="Forget this exchange and start again with the same folder"
              onClick={() => {
                void composeClear();
                setThread([]);
              }}
            >
              Start again
            </button>
          )}
          <button
            className="btn btn-send"
            disabled={!draft.trim() || busy || !packed}
            onClick={() => void ask(draft)}
          >
            <IconSend />
            {busy ? "Writing…" : "Ask"}
          </button>
        </div>
      </div>
    </div>
  );
}
