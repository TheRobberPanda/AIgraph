import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  composeClear,
  composeLoad,
  composeSelect,
  composeSelectable,
  composeSend,
  onComposeToken,
  saveDocument,
  stopGeneration,
  type Packed,
  type Selectable,
} from "../lib/compose";
import {
  OUTPUT_FORMATS,
  formatExt,
  formatLabel,
  getSettings,
  onSettingsChanged,
  saveSettings,
  type OutputFormat,
  type Preset,
} from "../lib/settings";
import PresetPreview from "./PresetPreview";
import { listFolders, ROOT_FOLDER, type Folder } from "../lib/folders";
import { useUndoable } from "../lib/undo";
import Markdown from "./Markdown";
import { IconSend, IconPlus, IconChevron, IconStop } from "./Icons";

/**
 * What each format asks the model to actually write.
 *
 * Appended to the instruction rather than put in the system prompt: the system
 * prompt is about the material and is the same for every question asked of a
 * folder, and this is about one question. Markdown in every case — it is the
 * one shape every model writes well — and the difference is what the markdown
 * is *of*. The file writer turns that into the format afterwards.
 */
const SHAPE: Record<OutputFormat, string> = {
  markdown: "",
  pdf:
    "\n\nWrite this as a document to be read on a page: a title on the first " +
    "line as `# Title`, then sections under `## ` headings, then paragraphs. " +
    "No slide breaks, no speaker notes, and no closing summary of what you " +
    "just wrote.",
  docx:
    "\n\nWrite this as a document somebody will edit afterwards: a title on " +
    "the first line as `# Title`, then `## ` headings, then paragraphs and " +
    "bulleted lists where a list is genuinely the right shape.",
  pptx:
    "\n\nWrite this as a deck, not as prose. The first line is `# ` and the " +
    "deck's title. Then one `## ` heading per slide, and under each of them " +
    "at most five short lines beginning with `- `. A line is a phrase, not a " +
    "paragraph — if a point needs a paragraph it needs its own slide. Nothing " +
    "outside that structure: no introduction, no notes, no conclusion slide " +
    "that only restates the titles.",
};

interface Exchange {
  asked: string;
  answer: string;
  /** What this answer was asked to come out as, so saving it writes that kind
   *  of file without asking again. A typed question is prose. */
  format: OutputFormat;
  /** The button it came from, for naming the file something recognisable. */
  name?: string;
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
  /**
   * Whether "the whole folder" is the deliberate answer.
   *
   * An empty selection is how the backend has always been told "use
   * everything", which made "nothing chosen" impossible to express and
   * "deselect all" a button that quietly selected everything: the ticks
   * emptied and the heading said "Everything in this folder" over them. So
   * the two are told apart here — emptying the ticks means nothing is chosen,
   * and there is a separate way to ask for the lot.
   */
  const [useAll, setUseAll] = useState(true);
  const [picking, setPicking] = useState(false);
  /** A preset whose wording is being read before it is sent. */
  const [previewing, setPreviewing] = useState<Preset | null>(null);
  /** Writing a new instruction to sit beside the others. */
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newFormat, setNewFormat] = useState<OutputFormat>("markdown");
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
    setUseAll(true);
    composeLoad(folder)
      .then(setPacked)
      .catch((e) => setError(String(e)));
    composeSelectable(folder)
      .then((t) => {
        setTree(t);
        // Ticked on arrival, because everything is what gets used. The rows
        // used to sit empty under a label saying "Everything in Root", which
        // reads as nothing chosen and invites ticking things that were
        // already included.
        //
        // The ideas under them are ticked too. They were not, so expanding a
        // conversation that was plainly ticked showed a list of empty boxes —
        // the material was going in, and the screen said it was not.
        setPickedSessions(new Set(t.map((c) => c.session_id)));
        setPickedIdeas(new Set(t.flatMap((c) => c.ideas.map((i) => i.idea_id))));
      })
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

  const ask = useCallback(
    async (instruction: string, format: OutputFormat = "markdown", name?: string) => {
    const text = instruction.trim();
    if (!text) return;
    setError(null);
    setSaved(null);
    setBusy(true);
    setDraft("");
    setThread((t) => [...t, { asked: text, answer: "", format, name }]);
    try {
      // The shape reaches the model, not just the file writer. A deck and an
      // essay are not the same text in two wrappers, and asking for one and
      // then wrapping the other is how you get an essay cut into slides.
      const reply = await composeSend(text + SHAPE[format]);
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
  },
    [],
  );

  /** Push the current ticks to the backend and take the new context back. */
  const apply = useCallback(
    async (sessions: Set<number>, ideas: Set<number>) => {
      setUseAll(false);
      // Nothing ticked is not something the backend can be told: empty lists
      // are how it is asked for the whole folder. So it is simply not asked —
      // there is nothing to pack, and asking anything is blocked until
      // something is chosen again.
      if (sessions.size === 0 && ideas.size === 0) return;
      try {
        setPacked(await composeSelect(folder, [...sessions], [...ideas]));
      } catch (e) {
        setError(String(e));
      }
    },
    [folder],
  );

  /** Go back to the whole folder, deliberately. */
  const takeEverything = useCallback(async () => {
    setPickedSessions(new Set());
    setPickedIdeas(new Set());
    setUseAll(true);
    try {
      setPacked(await composeSelect(folder, [], []));
    } catch (e) {
      setError(String(e));
    }
  }, [folder]);

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
    // Untick one idea out of a whole conversation and what you meant is "all
    // of it except this" — so the rest of it becomes explicit as the
    // conversation stops being whole.
    if (sessions.has(c.session_id)) for (const i of c.ideas) ideas.add(i.idea_id);
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
        { id: `own-${Date.now().toString(36)}`, name, prompt, format: newFormat },
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

  // Everything is what an empty selection means to the backend. It just never
  // looked like it: the rows sat unticked while the label said "Everything",
  // so the ticks read as "nothing chosen yet" rather than as the state they
  // describe. They are ticked now, and clearing them is one press.
  const everything = useAll && pickedSessions.size === 0 && pickedIdeas.size === 0;
  /** Ticks emptied on purpose. There is nothing to make anything out of. */
  const nothing = !useAll && pickedSessions.size === 0 && pickedIdeas.size === 0;
  // What the ticks say, not what an empty selection happens to mean. Folding
  // "nothing is ticked" into this made the button a switch that could only be
  // pressed one way: deselecting everything left it reading "Deselect all"
  // over an empty list, with no way back except the second button — which the
  // same condition had just removed from the row.
  const allOn = tree.length > 0 && pickedSessions.size === tree.length;

  async function keep(x: Exchange) {
    const format = x.format ?? "markdown";
    const chosen = OUTPUT_FORMATS.find((f) => f.value === format);
    const stem = `${here} — ${x.name ?? "made"}`.replace(/[/\\?%*:|"<>]/g, "-");
    const path = await save({
      title: "Save this",
      defaultPath: `${stem}.${formatExt(format)}`,
      filters: chosen
        ? [{ name: chosen.label, extensions: [chosen.ext] }]
        : [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    try {
      setSaved(`Saved to ${await saveDocument(path, x.answer, format, x.name ?? here)}`);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    // Simple mode gives this the whole page, so the picker goes to the right
    // edge and out of the reading column; the narrow advanced panel has no
    // right edge to speak of and keeps everything stacked.
    <div className={compact ? "pane-inner make" : "pane-inner make roomy"}>
      {/* Two columns where there is room: what is being made on the left,
          what it is being made from on the right, standing open. It used to
          be a dropdown over the answers — which meant the material was
          invisible unless you went looking, and covered the thing you were
          reading when you did. */}
      <div className="make-main">
      <div className="make-head">
        <span className="row-main">
          Making something out of <strong>{here}</strong>
        </span>
      </div>

      {/* The instructions, as buttons. Pressing one fills the box below with
          its wording and sends it — nothing happens that you cannot see. */}
      <div className="make-presets">
        {presets.map((p) => (
          <button
            key={p.id}
            className="btn"
            disabled={busy || !packed || nothing}
            data-tip={nothing ? "Nothing is chosen to make this out of" : p.prompt}
            // Not straight to the model. What a button asks for is the thing
            // most worth arguing with, and it used to be invisible until you
            // opened Settings in another tab to read it.
            onClick={() => setPreviewing(p)}
          >
            {p.name}
            {/* What it will come out as, on the button that makes it. */}
            <span className="make-format">{formatLabel(p.format ?? "markdown")}</span>
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
            {OUTPUT_FORMATS.map((f) => (
              <button
                key={f.value}
                className={newFormat === f.value ? "btn on" : "btn"}
                data-tip={f.blurb}
                onClick={() => setNewFormat(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
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
                <button className="btn" onClick={() => void keep(x)}>
                  Save as {formatLabel(x.format ?? "markdown")}
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
          placeholder={
            nothing
              ? "Nothing is chosen — tick something on the right"
              : packed
                ? "Or ask for something else"
                : "Loading the folder…"
          }
          disabled={!packed || busy || nothing}
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
          {busy ? (
            <button
              className="btn"
              data-tip="Stop writing and keep what has arrived"
              onClick={() => void stopGeneration()}
            >
              <IconStop />
              Stop
            </button>
          ) : (
            <button
              className="btn btn-send"
              disabled={!draft.trim() || !packed || nothing}
              onClick={() => void ask(draft)}
            >
              <IconSend />
              Ask
            </button>
          )}
        </div>
      </div>
      </div>

      <aside className="make-side">
      {/* What the model will actually be reading. A count alone asks to be
          trusted; this says which, and lets any of it be dropped. Ticking a
          conversation takes it whole; ticking one idea takes that idea's own
          material and leaves the rest of the transcript behind. */}
      {tree.length > 0 && (
        <div className="make-picker">
          {/* Standing open in its own column, so the header is a heading. The
              narrow advanced panel has no room for that and keeps the toggle. */}
          <button
            className="make-picker-head"
            disabled={!compact}
            onClick={() => setPicking((v) => !v)}
          >
            {compact && <IconChevron className={picking ? "flip" : undefined} />}
            {nothing ? (
              // Said plainly rather than left to be inferred from a row of
              // empty boxes under a heading claiming the opposite.
              <span className="warn">Nothing chosen</span>
            ) : everything ? (
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

          {(picking || !compact) && (
            <div className="make-picker-body">
              <div className="row pick-all">
                <button
                  className="link"
                  onClick={() => {
                    if (allOn) {
                      // Deselecting everything means choosing nothing, which
                      // is a real state — not the same as "use everything".
                      const none = new Set<number>();
                      setPickedSessions(none);
                      setPickedIdeas(none);
                      void apply(none, none);
                      return;
                    }
                    const all = new Set(tree.map((c) => c.session_id));
                    const everyIdea = new Set(tree.flatMap((c) => c.ideas.map((i) => i.idea_id)));
                    setPickedSessions(all);
                    setPickedIdeas(everyIdea);
                    void apply(all, everyIdea);
                  }}
                >
                  {allOn ? "Deselect all" : "Select all"}
                </button>
                {/* Always here, whatever is ticked. It used to be hidden
                    whenever nothing was — which is exactly the state you
                    reach it from. */}
                <button className="link" disabled={everything} onClick={() => void takeEverything()}>
                  Use everything again
                </button>
              </div>
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
                          {c.ideas.map((i) => {
                            // Its conversation going in whole is what puts it
                            // in — its transcript already carries the idea, so
                            // an unticked box under a ticked conversation was
                            // describing something that was not true.
                            const ideaOn = on || pickedIdeas.has(i.idea_id);
                            return (
                              <li key={i.idea_id} className="pick-row">
                                <button
                                  className={ideaOn ? "tick on" : "tick"}
                                  aria-pressed={ideaOn}
                                  onClick={() => toggleIdea(c, i.idea_id)}
                                >
                                  {ideaOn ? "✓" : ""}
                                </button>
                                <span className="pick-idea-name">{i.title}</span>
                              </li>
                            );
                          })}
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

      </aside>

      {previewing && (
        <PresetPreview
          preset={previewing}
          onClose={() => setPreviewing(null)}
          onStart={(prompt, format) => {
            const name = previewing.name;
            setPreviewing(null);
            void ask(prompt, format, name);
          }}
        />
      )}
    </div>
  );
}
