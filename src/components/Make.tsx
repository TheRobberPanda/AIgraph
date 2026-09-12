import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import Sheet from "./Sheet";
import {
  composeClear,
  composeLoad,
  composeSelect,
  composeSelectable,
  composeSend,
  onComposeToken,
  saveDocument,
  stopGeneration,
  type ExportedFile,
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
import { REASONING_REFUSED, wantsReasoning } from "../lib/chat";
import PresetPreview from "./PresetPreview";
import { listFolders, ROOT_FOLDER, type Folder } from "../lib/folders";
import { composeSaveOutput, listMakeOutputs, type MakeOutput } from "../lib/outputs";
import { onMaking, setMaking, takeMakeOpenRequest } from "../lib/making";
import { useUndoable } from "../lib/undo";
import Markdown from "./Markdown";
import { DocThumb, ExportFiles, MakeOutputs, OutputFile } from "./Outputs";
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
  format: OutputFormat;
  /** The button it came from, for naming the file something recognisable. */
  name?: string;
  /**
   * The reply, streamed in whole but never shown here.
   *
   * A two-thousand-word document pasted into the conversation buried the next
   * instruction under it and made the thread unreadable. What is shown is the
   * archive card; the full text lives in the output, one click away.
   */
  answer: string;
  /** Set once the reply has been filed as an output. */
  output: MakeOutput | null;
  /** Files the reply's own export command wrote. */
  exports: ExportedFile[];
  /** Why one of those exports did not land, when it did not. */
  exportError?: string;
  /** Filing the output failed. The raw reply is shown rather than lost. */
  raw?: boolean;
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
  /** Which page of the tab is on: asking, or what has been made. */
  const [page, setPage] = useState<"compose" | "outputs">("compose");
  /** A document is open over the archive, so the page tabs step out of its way. */
  const [outputOpen, setOutputOpen] = useState(false);
  /** An output the nav bar asked this tab to open. */
  const [requestedOutput, setRequestedOutput] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const undoDraft = useUndoable(draft, setDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The ask that just failed, so an error that one switch fixes can also
  // ask it again.
  const failedAsk = useRef<{ text: string; format: OutputFormat; name?: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /** An output opened from an archive card, over this tab. */
  const [opening, setOpening] = useState<MakeOutput | null>(null);
  /** How much this folder has been made into — the number on the tab. */
  const [outputCount, setOutputCount] = useState(0);
  const takeCounts = useCallback(
    (c: { archived: number; current: number }) => {
      setOutputCount(c.current);
    },
    [],
  );

  useEffect(() => {
    void listMakeOutputs(folder)
      .then((os) => {
        setOutputCount(os.filter((o) => !o.archived).length);
      })
      .catch(() => {});
  }, [folder]);
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

  // The bar can ask for an output to be opened — the result of a make that
  // finished while the person was looking at something else. The request is
  // taken now if it is already waiting, and on every change after that.
  useEffect(() => {
    const apply = () => {
      const id = takeMakeOpenRequest();
      if (id !== null) {
        setPage("outputs");
        setRequestedOutput(id);
      }
    };
    apply();
    return onMaking(apply);
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

  /**
   * The conversations this exchange is being made out of, for the record.
   *
   * Everything ticks by default, and "everything" means every conversation in
   * the tree; a narrowed selection is itself, plus the conversations of any
   * ideas ticked loose of their transcripts.
   */
  function sourceSessions(): number[] {
    if (useAll) return tree.map((c) => c.session_id);
    const ids = new Set(pickedSessions);
    for (const c of tree) {
      if (!pickedIdeas.size) break;
      if (c.ideas.some((i) => pickedIdeas.has(i.idea_id))) ids.add(c.session_id);
    }
    return [...ids];
  }

  const ask = useCallback(
    async (instruction: string, format: OutputFormat = "markdown", name?: string) => {
    const text = instruction.trim();
    if (!text) return;
    setError(null);
    setSaved(null);
    setBusy(true);
    setDraft("");
    const label = (name?.trim() || text).slice(0, 60);
    setMaking({ name: label, status: "working", outputId: null, error: null });
    setThread((t) => [
      ...t,
      { asked: text, answer: "", output: null, format, name, exports: [] },
    ]);
    try {
      // The shape reaches the model, not just the file writer. A deck and an
      // essay are not the same text in two wrappers, and asking for one and
      // then wrapping the other is how you get an essay cut into slides.
      const { reply, exports, export_error } = await composeSend(text + SHAPE[format]);
      // The model may have run its own export line; those files are the
      // answer's doing, shown under the card as soon as they land — or the
      // reason one of them did not, which is not a lost document.
      if (exports.length > 0 || export_error) {
        setThread((t) => {
          const next = [...t];
          next[next.length - 1] = {
            ...next[next.length - 1],
            exports,
            exportError: export_error ?? undefined,
          };
          return next;
        });
      }
      // Filed as an output the moment it lands — that is the point of the
      // tab. If the filing fails, the reply falls back to being shown here
      // in full, which is worse than a card but better than losing it.
      try {
        const output = await composeSaveOutput(reply, format, text, folder, sourceSessions());
        setOutputCount((n) => n + 1);
        setThread((t) => {
          const next = [...t];
          next[next.length - 1] = { ...next[next.length - 1], output };
          return next;
        });
        setMaking({ name: label, status: "done", outputId: output.id, error: null });
      } catch {
        setThread((t) => {
          const next = [...t];
          next[next.length - 1] = { ...next[next.length - 1], answer: reply, raw: true };
          return next;
        });
        setMaking({
          name: label,
          status: "failed",
          outputId: null,
          error: "It came back but could not be filed.",
        });
      }
    } catch (e) {
      failedAsk.current = { text, format, name };
      setError(String(e));
      setMaking({ name: label, status: "failed", outputId: null, error: String(e) });
      // The question goes too — it never reached the model, and leaving it on
      // screen under an error reads as an answer that failed rather than one
      // that was never asked.
      setThread((t) => t.slice(0, -1));
    } finally {
      setBusy(false);
    }
  },
    // `sourceSessions` reads state that is current when the ask is made, not
    // when the callback was first built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folder, tree, pickedSessions, pickedIdeas, useAll],
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
    const format = (x.output?.format as OutputFormat) ?? x.format ?? "markdown";
    const chosen = OUTPUT_FORMATS.find((f) => f.value === format);
    const stem = `${here} — ${x.output?.title ?? x.name ?? "made"}`.replace(/[/\\?%*:|"<>]/g, "-");
    const path = await save({
      title: "Save this",
      defaultPath: `${stem}.${formatExt(format)}`,
      filters: chosen
        ? [{ name: chosen.label, extensions: [chosen.ext] }]
        : [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    try {
      setSaved(
        `Saved to ${await saveDocument(
          path,
          x.output?.content ?? x.answer,
          format,
          x.output?.title ?? x.name ?? here,
        )}`,
      );
    } catch (e) {
      setError(String(e));
    }
  }

  // Make / Outputs, one switch with two faces. It lives at the top right of
  // the window, above the material, rather than on the left where it was one
  // more thing between the instructions and the conversation.
  const makeViews = (
    <span className="make-views">
      <button
        className={page === "compose" ? "make-view on" : "make-view"}
        onClick={() => setPage("compose")}
      >
        Make
      </button>
      <button
        className={page === "outputs" ? "make-view on" : "make-view"}
        data-tip="Everything this folder has been made into"
        onClick={() => setPage("outputs")}
      >
        Outputs{outputCount > 0 && ` · ${outputCount}`}
      </button>
    </span>
  );

  return (
    <div className={compact ? "pane-inner make" : "pane-inner make roomy"}>
      {/* Two columns where there is room: the asking on the left with the
          instructions in its header, what it is being made from on the right.
          It used to be a dropdown over the answers — which meant the material
          was invisible unless you went looking, and covered the thing you were
          reading when you did. */}
      {page === "outputs" ? (
        <div className="make-main">
          {/* The tabs belong to the archive, not the document: opening one
              takes the page over, and a Make/Outputs switch floating above a
              document being read is two things where there is one. They sit at
              the top right, where they are in the Make view too. */}
          {!outputOpen && <div className="make-head make-head-right">{makeViews}</div>}
          <MakeOutputs
            folder={folder}
            compact={compact}
            onOpenChange={setOutputOpen}
            openId={requestedOutput}
            onOpenConsumed={() => setRequestedOutput(null)}
            showArchived={false}
            onCounts={takeCounts}
            onRetry={(o) => {
              // Ask the same instruction again, from the Make page, so the
              // result is a fresh output rather than an overwrite.
              setPage("compose");
              void ask(o.prompt, o.format as OutputFormat, o.title);
            }}
          />
        </div>
      ) : (
      <>
      <aside className="make-chat">
      <div className="make-head">
        {/* The instructions, at the top left of the chat. Pressing one fills
            the box below with its wording and sends it — nothing happens that
            you cannot see. */}
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

      {error && (
        <p className="error">
          {wantsReasoning(error) ? REASONING_REFUSED : error}
          {wantsReasoning(error) && (
            <button
              className="btn error-action"
              onClick={async () => {
                const again = failedAsk.current;
                failedAsk.current = null;
                try {
                  await saveSettings({ ...(await getSettings()), reasoning: true });
                } catch (e) {
                  setError(String(e));
                  return;
                }
                setError(null);
                if (again) void ask(again.text, again.format, again.name);
              }}
            >
              {failedAsk.current ? "Turn reasoning on and ask again" : "Turn reasoning on"}
            </button>
          )}
        </p>
      )}
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
            {x.output ? (
              // The archive card, not the text: a miniature of the document
              // itself, the way the outputs page draws it, rather than a title
              // and a summary of what it says.
              <button
                className="make-output-card"
                data-tip="Open it"
                onClick={() => setOpening(x.output)}
              >
                <DocThumb
                  content={x.output.content}
                  format={x.output.format as OutputFormat}
                  title={x.output.title || "Made something"}
                />
                <span className="make-output-title">{x.output.title || "Made something"}</span>
                <span className="make-output-meta">
                  {formatLabel(x.output.format as OutputFormat)} · from{" "}
                  {x.output.sessions.length === 1
                    ? "1 conversation"
                    : `${x.output.sessions.length} conversations`}{" "}
                  · open
                </span>
              </button>
            ) : x.raw ? (
              // Filing failed; the reply is shown rather than lost.
              <div className="make-answer">
                <Markdown>{x.answer}</Markdown>
              </div>
            ) : (
              <div className="make-answer">
                {x.answer ? (
                  <span className="muted">Filing what came back…</span>
                ) : (
                  <span className="spinner" aria-hidden="true" />
                )}
              </div>
            )}
            {/* Files the model's own export command wrote. A file is the
                point of the ask; it is named where it went, and opens with
                whatever the system opens PDFs and decks with. */}
            {x.exportError && <p className="error">{x.exportError}</p>}
            <ExportFiles files={x.exports} />
            {x.output && !busy && (
              <div className="row">
                <button className="btn" onClick={() => void keep(x)}>
                  Save as {formatLabel(x.output.format as OutputFormat)}
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
              ? "Nothing is chosen — tick something on the left"
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
      </aside>

      <aside className="make-side">
      {/* Make / Outputs at the top right, above and inside this column. */}
      <div className="make-side-head">{makeViews}</div>
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
                          <span
                            className={
                              c.ideas.length === 0 ? "row-meta idea-count none" : "row-meta idea-count"
                            }
                          >
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
      </>
      )}

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

      {opening && (
        <Sheet onClose={() => setOpening(null)}>
          <OutputFile
            output={opening}
            compact={compact}
            onClose={() => {
              setOpening(null);
              void listMakeOutputs(folder).then((os) => setOutputCount(os.filter((o) => !o.archived).length)).catch(() => {});
            }}
          />
        </Sheet>
      )}
    </div>
  );
}
