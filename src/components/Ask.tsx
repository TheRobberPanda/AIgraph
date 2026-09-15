import { useCallback, useEffect, useRef, useState } from "react";
import { askClear, askLoad, askSend, onAskToken } from "../lib/ask";
import { stopGeneration, type Packed } from "../lib/compose";
import { getSettings, onSettingsChanged, saveSettings, type Preset } from "../lib/settings";
import { REASONING_REFUSED, wantsReasoning } from "../lib/chat";
import { enableReasoningFor } from "../lib/notice";
import { listFolders, type Folder } from "../lib/folders";
import { useUndoable } from "../lib/undo";
import Markdown from "./Markdown";
import Select from "./Select";
import { IconClose, IconPlus, IconSend, IconStop } from "./Icons";

interface Turn {
  asked: string;
  answer: string;
}

/** The folder picker's value for "every folder at once". */
const ALL = "all";

/**
 * Asking a folder anything.
 *
 * The map and the ideas are what was taken out of the conversations; Make
 * turns them into a document. This is the plainer thing in between: a
 * question, answered from what was actually said, read here and not filed.
 * The folder is chosen on the page rather than taken from the one being
 * worked in, because the question is often about somewhere else.
 */
export default function Ask({ initialFolder }: { initialFolder: number }) {
  const [folder, setFolder] = useState<number | null>(initialFolder);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [packed, setPacked] = useState<Packed | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [thread, setThread] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const undoDraft = useUndoable(draft, setDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = useRef<string | null>(null);
  /** Writing a new question to keep as a button, or removing old ones. */
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void listFolders().then(setFolders).catch(() => {});
    void getSettings().then((s) => setPresets(s.ask_presets ?? []));
    const p = onSettingsChanged((s) => setPresets(s.ask_presets ?? []));
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // A different folder is different material, so the answers about the last
  // one go with it.
  useEffect(() => {
    setPacked(null);
    setThread([]);
    setError(null);
    askLoad(folder)
      .then(setPacked)
      .catch((e) => setError(String(e)));
  }, [folder]);

  useEffect(() => {
    const p = onAskToken((text) =>
      setThread((t) => {
        if (t.length === 0) return t;
        const next = [...t];
        next[next.length - 1] = { ...next[next.length - 1], answer: next[next.length - 1].answer + text };
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

  const ask = useCallback(async (question: string) => {
    const text = question.trim();
    if (!text) return;
    setError(null);
    setBusy(true);
    setDraft("");
    setThread((t) => [...t, { asked: text, answer: "" }]);
    let retry = false;
    try {
      const reply = await askSend(text);
      // The whole reply, in place of what streamed: a stop keeps what had
      // arrived, and this is that, exactly.
      setThread((t) => {
        const next = [...t];
        next[next.length - 1] = { ...next[next.length - 1], answer: reply };
        return next;
      });
    } catch (e) {
      retry = await enableReasoningFor(e).catch(() => false);
      if (!retry) {
        failed.current = text;
        setError(String(e));
      }
      setThread((t) => t.slice(0, -1));
    } finally {
      setBusy(false);
    }
    if (retry) void ask(text);
  }, []);

  async function savePresets(next: Preset[]) {
    try {
      const current = await getSettings();
      await saveSettings({ ...current, ask_presets: next });
      setPresets(next);
    } catch (e) {
      setError(String(e));
    }
  }

  async function addPreset() {
    const name = newName.trim();
    const prompt = newPrompt.trim();
    if (!name || !prompt) return;
    await savePresets([
      ...presets,
      { id: `ask-own-${Date.now().toString(36)}`, name, prompt, format: "markdown" },
    ]);
    setAdding(false);
    setNewName("");
    setNewPrompt("");
  }

  const options = [
    { value: ALL, label: "Every folder" },
    ...folders.map((f) => ({
      value: String(f.id),
      label: f.name,
      meta: `${f.session_count}`,
    })),
  ];
  const where =
    folder === null ? "every folder" : (folders.find((f) => f.id === folder)?.name ?? "this folder");
  const empty = packed !== null && packed.conversations === 0;

  return (
    <div className="pane-inner ask">
      <div className="ask-head">
        <Select
          value={folder === null ? ALL : String(folder)}
          options={options}
          tip="Which conversations the question is asked of"
          onChange={(v) => setFolder(v === ALL ? null : Number(v))}
        />
        {packed && (
          <span className="row-meta">
            {packed.conversations} {packed.conversations === 1 ? "conversation" : "conversations"}
            {packed.dropped > 0 && ` · ${packed.dropped} too old to fit`}
          </span>
        )}
      </div>

      <div className="make-presets ask-presets">
        {presets.map((p) => (
          <span key={p.id} className="ask-preset">
            <button
              className="btn"
              disabled={busy || !packed || empty}
              data-tip={p.prompt}
              onClick={() => void ask(p.prompt)}
            >
              {p.name}
            </button>
            {editing && (
              <button
                className="icon-btn ask-preset-remove"
                data-tip="Remove this question"
                onClick={() => void savePresets(presets.filter((x) => x.id !== p.id))}
              >
                <IconClose />
              </button>
            )}
          </span>
        ))}
        <button
          className={adding ? "icon-btn on" : "icon-btn"}
          data-tip={adding ? "Cancel" : "Keep a question as a button"}
          onClick={() => {
            setEditing(false);
            setAdding((v) => !v);
          }}
        >
          <IconPlus />
        </button>
        {presets.length > 0 && (
          <button
            className={editing ? "btn subtle on" : "btn subtle"}
            onClick={() => {
              setAdding(false);
              setEditing((v) => !v);
            }}
          >
            {editing ? "Done" : "Edit"}
          </button>
        )}
      </div>

      {adding && (
        <div className="make-new">
          <input
            className="field"
            placeholder="What the button says — “Who do I keep mentioning?”"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <textarea
            className="field preset-prompt"
            rows={3}
            placeholder="The question itself, in full."
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
          />
          <div className="row">
            <button
              className="btn"
              disabled={!newName.trim() || !newPrompt.trim()}
              onClick={() => void addPreset()}
            >
              Keep it
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error">
          {wantsReasoning(error) ? REASONING_REFUSED : error}
          {wantsReasoning(error) && (
            <button
              className="btn error-action"
              onClick={async () => {
                const again = failed.current;
                failed.current = null;
                try {
                  await saveSettings({ ...(await getSettings()), reasoning: true });
                } catch (e) {
                  setError(String(e));
                  return;
                }
                setError(null);
                if (again) void ask(again);
              }}
            >
              Turn reasoning on and ask again
            </button>
          )}
        </p>
      )}

      <div className="make-thread">
        {thread.length === 0 && packed && (
          <p className="empty">
            {empty ? (
              <strong>Nothing has been said in {where} yet.</strong>
            ) : (
              <>
                <strong>Ask anything.</strong>
                <span className="muted"> Everything said in {where} is in front of the model.</span>
              </>
            )}
          </p>
        )}
        {thread.map((x, i) => (
          <div key={i} className="make-turn">
            <p className="make-asked">{x.asked}</p>
            <div className="make-answer">
              {x.answer ? <Markdown>{x.answer}</Markdown> : <span className="spinner" aria-hidden="true" />}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="composer-box make-box">
        <textarea
          value={draft}
          placeholder={packed ? `Ask ${where} something` : "Loading the folder…"}
          disabled={!packed || busy || empty}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (undoDraft(e)) return;
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
              data-tip="Forget these questions and start again with the same folder"
              onClick={() => {
                void askClear();
                setThread([]);
              }}
            >
              Start again
            </button>
          )}
          {busy ? (
            <button
              className="btn grow"
              data-tip="Stop and keep what has arrived"
              onClick={() => void stopGeneration()}
            >
              <IconStop />
              <span className="btn-label">Stop</span>
            </button>
          ) : (
            <button
              className="btn btn-send grow"
              disabled={!draft.trim() || !packed || empty}
              onClick={() => void ask(draft)}
            >
              <IconSend />
              <span className="btn-label">Ask</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
