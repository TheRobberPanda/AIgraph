import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  composeClear,
  composeLoad,
  composeSelect,
  composeSelectable,
  composeSend,
  onComposeToken,
  saveText,
  type Packed,
  type Selectable,
} from "../lib/compose";
import { getSettings, onSettingsChanged, saveSettings, type Preset } from "../lib/settings";
import { listFolders, ROOT_FOLDER, type Folder } from "../lib/folders";
import { useUndoable } from "../lib/undo";
import Markdown from "./Markdown";
import { IconSend, IconPlus, IconChevron } from "./Icons";

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
export default function Make({ folder, compact = false }: { folder: number | null; /** In the advanced layout's narrow panel the titles fold away; simple mode shows them. */ compact?: boolean }) {
  const [packed, setPacked] = useState<Packed | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [thread, setThread] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState("");
  const undoDraft = useUndoable(draft, setDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /** What there is to choose from, and what is ticked. */
  const [tree, setTree] = useState<Selectable[]>([]);
  const [pickedSessions, setPickedSessions] = useState<Set<number>>(new Set());
  const [pickedIdeas, setPickedIdeas] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [picking, setPicking] = useState(false);
  /** Writing a new instruction to sit beside the others. */
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
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
    setPickedSessions(new Set());
    setPickedIdeas(new Set());
    setExpanded(new Set());
    composeLoad(folder)
      .then(setPacked)
      .catch((e) => setError(String(e)));
    composeSelectable(folder)
      .then(setTree)
      .catch(() => setTree([]));
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

  /** Push the current ticks to the backend and take the new context back. */
  const apply = useCallback(
    async (sessions: Set<number>, ideas: Set<number>) => {
      try {
        setPacked(await composeSelect(folder, [...sessions], [...ideas]));
      } catch (e) {
        setError(String(e));
      }
    },
    [folder],
  );

  /** Ticking a conversation ticks everything in it: the transcript already
   *  carries those ideas, so the two cannot sensibly disagree. */
  function toggleSession(c: Selectable) {
    const sessions = new Set(pickedSessions);
    const ideas = new Set(pickedIdeas);
    if (sessions.delete(c.session_id)) {
      for (const i of c.ideas) ideas.delete(i.idea_id);
    } else {
      sessions.add(c.session_id);
      for (const i of c.ideas) ideas.add(i.idea_id);
    }
    setPickedSessions(sessions);
    setPickedIdeas(ideas);
    void apply(sessions, ideas);
  }

  function toggleIdea(c: Selectable, ideaId: number) {
    const ideas = new Set(pickedIdeas);
    const sessions = new Set(pickedSessions);
    if (!ideas.delete(ideaId)) ideas.add(ideaId);
    // A conversation is only "whole" while every idea under it is ticked.
    const whole = c.ideas.length > 0 && c.ideas.every((i) => ideas.has(i.idea_id));
    if (whole) sessions.add(c.session_id);
    else sessions.delete(c.session_id);
    setPickedIdeas(ideas);
    setPickedSessions(sessions);
    void apply(sessions, ideas);
  }

  async function addPreset() {
    const name = newName.trim();
    const prompt = newPrompt.trim();
    if (!name || !prompt) return;
    try {
      const current = await getSettings();
      const next = [
        ...current.presets,
        // Unique enough, and stable once written: the id is what survives a
        // rename, so it must not be derived from the name.
        { id: `own-${Date.now().toString(36)}`, name, prompt },
      ];
      await saveSettings({ ...current, presets: next });
      setPresets(next);
      setAdding(false);
      setNewName("");
      setNewPrompt("");
    } catch (e) {
      setError(String(e));
    }
  }

  const everything = pickedSessions.size === 0 && pickedIdeas.size === 0;

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
    // Simple mode gives this the whole page, so the picker goes to the right
    // edge and out of the reading column; the narrow advanced panel has no
    // right edge to speak of and keeps everything stacked.
    <div className={compact ? "pane-inner make" : "pane-inner make roomy"}>
      <div className="make-head">
        <span className="row-main">
          Making something out of <strong>{here}</strong>
        </span>
      </div>

      {/* What the model will actually be reading. A count alone asks to be
          trusted; this says which, and lets any of it be dropped. Ticking a
          conversation takes it whole; ticking one idea takes that idea's own
          material and leaves the rest of the transcript behind. */}
      {tree.length > 0 && (
        <div className="make-picker">
          <button className="make-picker-head" onClick={() => setPicking((v) => !v)}>
            <IconChevron className={picking ? "flip" : undefined} />
            {everything ? (
              <>
                Everything in {here}
                {packed && ` — ${packed.conversations} ${packed.conversations === 1 ? "conversation" : "conversations"}`}
              </>
            ) : (
              <>
                {pickedSessions.size} {pickedSessions.size === 1 ? "conversation" : "conversations"}
                {pickedIdeas.size > 0 && `, ${pickedIdeas.size} ideas`} chosen
              </>
            )}
            {packed && packed.dropped > 0 && (
              <span className="muted"> · {packed.dropped} too old to fit</span>
            )}
          </button>

          {picking && (
            <div className="make-picker-body">
              {!everything && (
                <button
                  className="link"
                  onClick={() => {
                    setPickedSessions(new Set());
                    setPickedIdeas(new Set());
                    void apply(new Set(), new Set());
                  }}
                >
                  Use everything again
                </button>
              )}
              <ul className="pick-tree">
                {tree.map((c) => {
                  const open = expanded.has(c.session_id);
                  const on = pickedSessions.has(c.session_id);
                  const some = c.ideas.some((i) => pickedIdeas.has(i.idea_id));
                  return (
                    <li key={c.session_id}>
                      <div className="pick-row">
                        <button
                          className={on ? "tick on" : some ? "tick part" : "tick"}
                          aria-pressed={on}
                          onClick={() => toggleSession(c)}
                        >
                          {on ? "✓" : some ? "–" : ""}
                        </button>
                        <button
                          className="pick-name"
                          disabled={c.ideas.length === 0}
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (!next.delete(c.session_id)) next.add(c.session_id);
                              return next;
                            })
                          }
                        >
                          {c.ideas.length > 0 && (
                            <IconChevron className={open ? "flip" : undefined} />
                          )}
                          <span className="row-main">
                            {c.title || `Conversation ${c.session_id}`}
                          </span>
                          <span className="row-meta">
                            {c.ideas.length} {c.ideas.length === 1 ? "idea" : "ideas"}
                          </span>
                        </button>
                      </div>

                      {open && (
                        <ul className="pick-ideas">
                          {c.ideas.map((i) => (
                            <li key={i.idea_id} className="pick-row">
                              <button
                                className={pickedIdeas.has(i.idea_id) ? "tick on" : "tick"}
                                aria-pressed={pickedIdeas.has(i.idea_id)}
                                onClick={() => toggleIdea(c, i.idea_id)}
                              >
                                {pickedIdeas.has(i.idea_id) ? "✓" : ""}
                              </button>
                              <span className="pick-idea-name">{i.title}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

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
        {/* One preset ships. This is how the rest arrive — written by whoever
            is going to press them, which is the only way the wording ends up
            sounding like anything in particular. */}
        <button
          className={adding ? "icon-btn on" : "icon-btn"}
          data-tip={adding ? "Cancel" : "Write another instruction"}
          onClick={() => setAdding((v) => !v)}
        >
          <IconPlus />
        </button>
      </div>

      {adding && (
        <div className="make-new">
          <input
            className="field"
            placeholder="What the button says — “A talk”"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <textarea
            className="field preset-prompt"
            rows={3}
            placeholder="What it asks for. Write it as an instruction, in full — that is the part you will want to argue with later."
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
          />
          <div className="row">
            <button className="btn" disabled={!newName.trim() || !newPrompt.trim()} onClick={() => void addPreset()}>
              Keep it
            </button>
            <span className="row-meta">Editable afterwards in Settings, under Prompts.</span>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {saved && <p className="blurb">{saved}</p>}

      <div className="make-thread">
        {thread.length === 0 && packed && (
          <p className="empty">
            <strong>Ask for something.</strong>
            <span className="muted"> Everything said in {here} is in front of the model.</span>
          </p>
        )}

        {thread.map((x, i) => (
          <div key={i} className="make-turn">
            <p className="make-asked">{x.asked}</p>
            <div className="make-answer">
              {x.answer ? <Markdown>{x.answer}</Markdown> : <span className="spinner" aria-hidden="true" />}
            </div>
            {x.answer && !busy && (
              <div className="row">
                <button
                  className="btn"
                  data-tip="Copy the whole answer"
                  onClick={() => void navigator.clipboard.writeText(x.answer)}
                >
                  Copy
                </button>
                <button className="btn" onClick={() => void keep(x.answer)}>
                  Save this
                </button>
              </div>
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
