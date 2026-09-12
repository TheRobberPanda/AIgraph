import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import {
  deleteMakeOutput,
  listMakeOutputs,
  reviseMakeOutput,
  setMakeOutputArchived,
  updateMakeOutput,
  clearOutputThread,
  type MakeOutput,
  type MakeOutputSource,
} from "../lib/outputs";
import { formatExt, formatLabel, type OutputFormat } from "../lib/settings";
import { saveDocument, stopGeneration, type ExportedFile } from "../lib/compose";
import { setSessionArchived } from "../lib/chat";
import { restoreTrashed } from "../lib/trash";
import { parseBlocks, toDeck } from "../lib/document";
import { useUndoable } from "../lib/undo";
import Markdown from "./Markdown";
import Sheet from "./Sheet";
import ContextMenu from "./ContextMenu";
import Confirm from "./Confirm";
import { ConversationFile } from "./Deep";
import { IconClose, IconMaximize, IconSend, IconStop } from "./Icons";

/**
 * Everything a folder has been made into, and the page where it is worked on.
 *
 * A Make answer used to live and die in the conversation that produced it:
 * the full text sat in the thread, and finding last week's essay meant
 * scrolling last week's asks. Here each one is a document with the
 * conversations it came from beside it — shown the way its file will look,
 * and changed by telling the model what to change.
 */

// ---------------------------------------------------------------- the page

/**
 * A miniature of the document itself.
 *
 * Not a summary of it — the first headings and lines, at the size they can be
 * read at in a tile. A deck is drawn as its first slides, a document as its
 * opening page; the same parse the file writers use, so the thumbnail and the
 * file cannot disagree.
 */
export function DocThumb({
  content,
  format,
  title,
}: {
  content: string;
  format: OutputFormat;
  title: string;
}) {
  if (format === "pptx") {
    const deck = toDeck(content, title);
    const first = deck.slides[0];
    return (
      <span className="thumb thumb-deck" aria-hidden="true">
        <span className="thumb-slide is-title">{deck.title || title || "Untitled"}</span>
        <span className="thumb-slide">
          {first && <span className="thumb-h">{first.head}</span>}
          {first?.lines.slice(0, 4).map((l, i) => (
            <span key={i} className="thumb-line">
              {l.bullet ? "· " : ""}{l.text}
            </span>
          ))}
        </span>
      </span>
    );
  }
  const blocks = parseBlocks(content).slice(0, 11);
  return (
    <span className="thumb thumb-page" aria-hidden="true">
      {blocks.map((b, i) =>
        b.kind === "heading" ? (
          <span key={i} className={`thumb-h h${b.level}`}>{b.text}</span>
        ) : (
          <span key={i} className={b.kind === "bullet" ? "thumb-line" : "thumb-para"}>
            {b.kind === "bullet" ? "· " : ""}{b.text}
          </span>
        ),
      )}
    </span>
  );
}

/** One file a model's export command wrote, named and openable. */
export function ExportFiles({ files }: { files: ExportedFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="make-exports">
      {files.map((f) => (
        <button
          key={f.path}
          className="make-export"
          data-tip={f.path}
          onClick={() => void openPath(f.path)}
        >
          <span className="make-export-kind">{f.format.toLowerCase()}</span>
          <span className="row-main">{f.name}</span>
          <span className="row-meta">open</span>
        </button>
      ))}
    </div>
  );
}

export function MakeOutputs({
  folder,
  compact = false,
  onOpenChange,
  openId,
  onOpenConsumed,
  onRetry,
  showArchived,
  onCounts,
}: {
  folder: number | null;
  compact?: boolean;
  /** Told when a document is opened or closed, so the page can drop its tabs. */
  onOpenChange?: (open: boolean) => void;
  /** An output the bar asked to open, once. */
  openId?: number | null;
  onOpenConsumed?: () => void;
  /** Ask again with the same prompt, filing the result as a new output. */
  onRetry?: (output: MakeOutput) => void;
  /** Whether the archived ones are showing. Owned by the page, so the toggle
   *  can sit up beside the Make/Outputs buttons rather than floating over the
   *  grid. */
  showArchived: boolean;
  /** How many are archived, so the toggle can say so where it now lives. */
  onCounts?: (counts: { archived: number; current: number }) => void;
}) {
  const [outputs, setOutputs] = useState<MakeOutput[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The one being worked on. */
  const [open, setOpen] = useState<number | null>(null);
  /** Right-clicked tile, and where. */
  const [menu, setMenu] = useState<{ x: number; y: number; output: MakeOutput } | null>(null);
  /** The title being renamed in place. */
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  /** The one waiting on a delete confirmation. */
  const [deleting, setDeleting] = useState<MakeOutput | null>(null);

  const refresh = useCallback(() => {
    void listMakeOutputs(folder)
      .then(setOutputs)
      .catch((e) => setError(String(e)));
  }, [folder]);

  useEffect(refresh, [refresh]);

  const shown = outputs.filter((o) => o.archived === showArchived);
  const archivedCount = outputs.filter((o) => o.archived).length;
  const currentCount = outputs.filter((o) => !o.archived).length;

  // Report the counts up so the page's toggle can describe them.
  useEffect(() => {
    onCounts?.({ archived: archivedCount, current: currentCount });
  }, [archivedCount, currentCount, onCounts]);

  // Opened on request from the bar — the result of a make that finished while
  // this tab was elsewhere. The list may not have loaded yet; `openOutput`
  // resolves against it as soon as it does.
  useEffect(() => {
    if (openId === null || openId === undefined) return;
    setOpen(openId);
    onOpenChange?.(true);
    onOpenConsumed?.();
  }, [openId, onOpenChange, onOpenConsumed]);

  const openOutput = outputs.find((o) => o.id === open) ?? null;

  if (openOutput) {
    return (
      <OutputFile
        output={openOutput}
        compact={compact}
        onClose={() => {
          setOpen(null);
          onOpenChange?.(false);
          refresh();
        }}
      />
    );
  }

  async function commitRename(id: number) {
    const edit = renaming;
    setRenaming(null);
    const name = edit?.value.trim();
    if (!edit || !name) return;
    const output = outputs.find((o) => o.id === id);
    if (!output || name === output.title) return;
    try {
      await updateMakeOutput(id, output.content, name);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="pane-inner outputs-page">
      {error && <p className="error">{error}</p>}
      {shown.length === 0 ? (
        <p className="empty">
          <strong>{showArchived ? "Nothing archived." : "Nothing made yet."}</strong>
          <span className="muted">
            {showArchived
              ? "Outputs you put out of the way turn up here."
              : "What comes out of a request on the Make tab is kept here, with the conversations it came from."}
          </span>
        </p>
      ) : (
        <ul className="outputs-grid">
          {shown.map((o) => (
            <li key={o.id}>
              {renaming?.id === o.id ? (
                <input
                  className="field output-tile-rename"
                  autoFocus
                  aria-label="Rename this output"
                  value={renaming.value}
                  onChange={(e) => setRenaming({ id: o.id, value: e.target.value })}
                  onBlur={() => void commitRename(o.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setRenaming(null);
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitRename(o.id);
                    }
                  }}
                />
              ) : (
                <button
                  className={o.archived ? "output-tile archived" : "output-tile"}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, output: o });
                  }}
                  onClick={() => {
                    onOpenChange?.(true);
                    setOpen(o.id);
                  }}
                >
                  <span className="output-thumb">
                    <DocThumb
                      content={o.content}
                      format={o.format as OutputFormat}
                      title={o.title || "Untitled"}
                    />
                  </span>
                  <span className="output-tile-name">{o.title || "Untitled"}</span>
                  <span className="output-tile-meta">
                    {[
                      o.created_at &&
                        new Date(o.created_at).toLocaleDateString(undefined, {
                          day: "numeric",
                          month: "short",
                        }),
                      o.sessions.length > 0 &&
                        `from ${o.sessions.length === 1 ? "1 conversation" : `${o.sessions.length} conversations`}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {o.archived && <span className="output-tile-tag">archived</span>}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Rename",
              onSelect: () => setRenaming({ id: menu.output.id, value: menu.output.title || "" }),
            },
            {
              // The same instruction, asked again from scratch: the reply is
              // filed as a new output rather than written over this one.
              label: "Re-try — make a new file",
              onSelect: () => onRetry?.(menu.output),
            },
            {
              label: menu.output.archived ? "Unarchive" : "Archive",
              onSelect: () =>
                void setMakeOutputArchived(menu.output.id, !menu.output.archived)
                  .then(refresh)
                  .catch((e) => setError(String(e))),
            },
            {
              label: "Delete",
              danger: true,
              confirm: "Yes, move it to the trash",
              onSelect: () => setDeleting(menu.output),
            },
          ]}
        />
      )}

      {deleting && (
        <Confirm
          title="Move this output to the trash?"
          danger
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(null);
            void deleteMakeOutput(id).then(refresh).catch((e) => setError(String(e)));
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the file

/** One instruction given to the model, and what came of it. */
interface Said {
  you: string;
  excerpts: string[];
  /** "working", "done", or the error it failed with. */
  outcome: string;
  /** Files the revision's export command wrote, if any. */
  files?: ExportedFile[];
  /** Why one of those exports did not land, when it did not. */
  exportError?: string | null;
}

/** A passage shortened to fit a chip or a quote in the chat. */
function clip(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/**
 * The instruction as the model receives it: the passages pointed at, then
 * what was asked about them. The model revises the whole document either
 * way — this only tells it where to look.
 */
function withExcerpts(said: string, excerpts: string[]): string {
  if (!excerpts.length) return said;
  const quoted = excerpts
    .map((x, i) => `> ${excerpts.length > 1 ? `[${i + 1}] ` : ""}${x.replace(/\s*\n\s*/g, " ")}`)
    .join("\n");
  return `These parts of the document are what this is about:\n${quoted}\n\n${said}`;
}

/**
 * A small dropdown that hangs off a label in the output's header — the
 * conversations it came from, or what it was asked for.
 *
 * These used to stand in the page as a row of chips and a folded panel,
 * taking a band of height above the document whether or not they were being
 * read. As a dropdown beside the title they cost no space until opened.
 */
function HeadMenu({
  label,
  tip,
  wide = false,
  children,
}: {
  label: string;
  tip?: string;
  /** Give the trigger and its panel more room — the prompt needs it. */
  wide?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="pick" ref={ref}>
      <button
        className={
          (open ? "pick-head open" : "pick-head") + (wide ? " pick-head-wide" : "")
        }
        onClick={() => setOpen((o) => !o)}
        data-tip={tip}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="pick-label">{label}</span>
        <span className="pick-caret" aria-hidden="true" />
      </button>
      {open && <div className="pick-list output-menu">{children}</div>}
    </div>
  );
}

/**
 * One output, open: the document as its file will look, in a viewer of its
 * own, and beside it a chat that changes it.
 *
 * A PDF or Word document reads as pages, a deck as slides — the same slides
 * the saved file will have. Markdown is the one format that is its own text,
 * so it is the one that can be edited by hand as well. Any of them can be
 * pointed at: select a passage, add it to the chat, add another, and the
 * instruction goes with all of them attached.
 */
export function OutputFile({
  output,
  compact = false,
  onClose,
}: {
  output: MakeOutput;
  /** The advanced Make panel is narrow; the chat goes under the document. */
  compact?: boolean;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState<MakeOutput>(output);
  const [text, setText] = useState(output.content);
  const undoText = useUndoable(text, setText);
  /** Markdown only: the text itself rather than the reading of it. */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const undoDraft = useUndoable(draft, setDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  /** The document viewer taken over the screen. */
  const [maximized, setMaximized] = useState(false);
  /** The title being renamed by hand. */
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  /** Set when the rename was abandoned, so the blur that follows keeps quiet. */
  const skipRename = useRef(false);
  /** A conversation this was made out of, opened whole over the file. */
  const [source, setSource] = useState<number | null>(null);
  /** A source that is archived or in the trash, waiting on a decision to
   *  bring it back before it can be opened. */
  const [recover, setRecover] = useState<MakeOutputSource | null>(null);
  /** Passages pointed at, in the order they were selected, waiting to go with
   *  the next instruction. Multiple selections made before it is sent are all
   *  affected by the same change; once it is sent this empties, so the next
   *  selection begins the next change. */
  const [excerpts, setExcerpts] = useState<string[]>([]);
  const [log, setLog] = useState<Said[]>([]);
  const viewerRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrent(output);
    setText(output.content);
    setEditing(false);
    setExcerpts([]);
    setLog([]);
  }, [output]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [log]);

  // The text grows the page rather than scrolling inside it: the viewer
  // already scrolls, and a second scroll inside the first hides the text
  // that wrapped past the row count.
  useEffect(() => {
    const ta = editRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [text, editing]);

  const format = current.format as OutputFormat;
  const editable = format === "markdown";
  const dirty = text !== current.content;
  const deck = format === "pptx" ? toDeck(text, current.title) : null;

  /** Type the changes back into the record. */
  async function keep(): Promise<boolean> {
    if (!dirty) return true;
    try {
      await updateMakeOutput(current.id, text);
      setCurrent({ ...current, content: text });
      setKept(true);
      window.setTimeout(() => setKept(false), 2500);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  /** Rename the output by hand, keeping any text changed alongside it. */
  async function rename() {
    setNaming(false);
    if (skipRename.current) {
      skipRename.current = false;
      return;
    }
    const next = nameDraft.trim();
    if (!next || next === current.title) return;
    try {
      await updateMakeOutput(current.id, text, next);
      setCurrent({ ...current, title: next, content: text });
    } catch (e) {
      setError(String(e));
    }
  }

  async function revise() {
    const said = draft.trim();
    if (!said || busy) return;
    setError(null);
    // The model revises the saved copy, so hand edits are kept first rather
    // than silently written over.
    if (!(await keep())) return;
    const using = excerpts;
    setBusy(true);
    setDraft("");
    // The passages pointed at are handed to this change and to nothing after
    // it: the next selection begins a new change, in its own order.
    setExcerpts([]);
    setLog((l) => [...l, { you: said, excerpts: using, outcome: "working" }]);
    const settle = (outcome: string, files?: ExportedFile[], exportError?: string | null) =>
      setLog((l) =>
        l.map((s, i) =>
          i === l.length - 1
            ? { ...s, outcome, files: files ?? s.files, exportError: exportError ?? s.exportError }
            : s,
        ),
      );
    try {
      const { output, exports, export_error } = await reviseMakeOutput(
        current.id,
        withExcerpts(said, using),
      );
      setCurrent(output);
      setText(output.content);
      settle("done", exports, export_error);
    } catch (e) {
      settle(String(e));
      // Given back, so a failed ask is not a lost one.
      setDraft(said);
      setExcerpts(using);
    } finally {
      setBusy(false);
    }
  }

  async function startOver() {
    try {
      await clearOutputThread(current.id);
      setLog([]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveAs() {
    const stem = (current.title || "made").replace(/[/\\?%*:|"<>]/g, "-");
    const path = await save({
      title: "Save this",
      defaultPath: `${stem}.${formatExt(format)}`,
      filters: [{ name: formatLabel(format), extensions: [formatExt(format)] }],
    });
    if (!path) return;
    try {
      await saveDocument(path, current.content, format, current.title || stem);
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove() {
    try {
      await deleteMakeOutput(current.id);
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  /**
   * Put a source conversation back, then open it.
   *
   * An archived conversation only needs un-archiving; one in the trash is
   * restored from its bin entry. Only after it is back on its feet is the
   * reader dropped into it, since a file fetched for a session that does not
   * exist yet would show nothing.
   */
  async function recoverSource(s: MakeOutputSource) {
    try {
      if (s.status === "archived") await setSessionArchived(s.session_id, false);
      else if (s.status === "trashed" && s.trash_id !== null) await restoreTrashed(s.trash_id);
      setRecover(null);
      setSource(s.session_id);
    } catch (e) {
      setError(String(e));
    }
  }

  /**
   * Point at the passage just selected.
   *
   * Selecting is the act: the passage joins the change being built, in the
   * order it was selected, and the instruction typed next is scoped to it.
   * There is no "add to chat" step to remember — a selection that is not
   * wanted is taken back off the chip row.
   *
   * Read a frame later: at the moment the pointer comes up the selection is
   * not always final yet, and a drag read too early offered nothing.
   */
  function noticeSelection(e: ReactMouseEvent) {
    const at = { inField: e.target === editRef.current };
    requestAnimationFrame(() => readSelection(at));
  }

  function readSelection(at: { inField: boolean }) {
    const box = viewerRef.current;
    if (!box) return;
    let picked = "";
    const ta = editRef.current;
    if (editing && ta && at.inField) {
      picked = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    } else {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && box.contains(sel.anchorNode) && box.contains(sel.focusNode)) {
        picked = sel.toString();
      }
    }
    picked = picked.trim();
    if (!picked) return;
    // Appended, not replaced: several parts pointed at before an instruction
    // is sent are all affected by it, and they keep the order they were
    // selected in.
    setExcerpts((xs) => (xs.includes(picked) ? xs : [...xs, picked]));
  }

  return (
    <div
      className={`pane-inner output-file${compact ? "" : " divided"}${maximized ? " maximized" : ""}`}
    >
      {error && <p className="error">{error}</p>}

      {/* The document on the left, the conversation that changes it on the
          right. The narrow advanced panel stacks them. */}
      <div className="output-split">
        <div className="output-reading">
          {/* Everything about the file rather than one instruction: its name,
              the conversations it came from, what it was asked for, and the
              buttons that write it out, enlarge it or throw it away. Above the
              preview, leaving the chat beside it to the work of changing it. */}
          <div className="doc-toolbar">
            <button className="btn" onClick={onClose}>← Back</button>
            {naming ? (
              <input
                className="field output-title-input"
                autoFocus
                value={nameDraft}
                aria-label="The title"
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => void rename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void rename();
                  } else if (e.key === "Escape") {
                    skipRename.current = true;
                    setNaming(false);
                  }
                }}
              />
            ) : (
              <span
                className="output-head-title"
                data-tip="Double-click to rename"
                onDoubleClick={() => {
                  skipRename.current = false;
                  setNameDraft(current.title);
                  setNaming(true);
                }}
              >
                {current.title || "Untitled"}
              </span>
            )}
            {current.sessions.length > 0 && (
              <HeadMenu
                label={`from ${
                  current.sessions.length === 1
                    ? "1 conversation"
                    : `${current.sessions.length} conversations`
                }`}
                tip="The conversations this was made from"
              >
                {current.sessions.map((s) => (
                  <button
                    key={s.session_id}
                    className={`pick-option source-${s.status}`}
                    aria-disabled={s.status === "missing"}
                    data-tip={
                      s.status === "missing"
                        ? "This conversation can no longer be found and cannot be recovered"
                        : s.status === "archived"
                          ? "This conversation was archived — open it or recover it"
                          : s.status === "trashed"
                            ? "This conversation was deleted — open it or recover it"
                            : undefined
                    }
                    onClick={() => {
                      if (s.status === "missing") return;
                      if (s.status === "active") setSource(s.session_id);
                      else setRecover(s);
                    }}
                  >
                    <span className="pick-label">{s.title}</span>
                    {s.status !== "active" && (
                      <span className={`source-state ${s.status}`}>
                        {s.status === "archived"
                          ? "archived"
                          : s.status === "trashed"
                            ? "deleted"
                            : "not found"}
                      </span>
                    )}
                  </button>
                ))}
              </HeadMenu>
            )}
            {current.prompt && (
              <HeadMenu label="Prompt used" tip="The instruction behind this" wide>
                <div className="output-prompt-body">
                  <Markdown>{current.prompt}</Markdown>
                </div>
              </HeadMenu>
            )}
            <span className="spacer" />
            {deck && (
              <span className="muted doc-count">
                {deck.slides.length + 1} slides
              </span>
            )}
            {editable && (
              <button
                className={editing ? "btn on" : "btn"}
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? "Reading view" : "Edit text"}
              </button>
            )}
            {editable && (dirty || kept) && (
              <button className="btn" disabled={!dirty} onClick={() => void keep()}>
                {kept && !dirty ? "Kept" : "Keep changes"}
              </button>
            )}
            <button
              className={maximized ? "btn on" : "btn"}
              aria-pressed={maximized}
              data-tip={maximized ? "Give the preview back its column" : "Take the preview over the screen"}
              onClick={() => setMaximized((v) => !v)}
            >
              <IconMaximize />
            </button>
            <button className="btn" data-tip="Write this file out" onClick={() => void saveAs()}>
              Export
            </button>
            <button className="btn subtle danger" onClick={() => void remove()}>
              Delete
            </button>
          </div>

          <div
            ref={viewerRef}
            className={`doc-viewer${deck ? " doc-viewer-deck" : ""}`}
            onMouseUp={noticeSelection}
          >
            {deck ? (
              <div className="deck">
                <section className="slide slide-title">
                  <h1>{deck.title || "Untitled"}</h1>
                  <span className="slide-no">1</span>
                </section>
                {deck.slides.map((s, i) => (
                  <section key={i} className="slide">
                    {s.head && <h2>{s.head}</h2>}
                    <ul>
                      {s.lines.map((l, j) => (
                        <li key={j} className={l.bullet ? undefined : "slide-para"}>
                          {l.text}
                        </li>
                      ))}
                    </ul>
                    <span className="slide-no">{i + 2}</span>
                  </section>
                ))}
              </div>
            ) : editable && editing ? (
              <div className="doc-page doc-md">
                <textarea
                  ref={editRef}
                  className="doc-edit"
                  value={text}
                  aria-label="The text"
                  spellCheck={false}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => undoText(e)}
                />
              </div>
            ) : (
              <article className={`doc-page${editable ? " doc-md" : ""}`}>
                <Markdown>{text}</Markdown>
              </article>
            )}
          </div>
        </div>

        <aside className="output-chat-col">
          <div className="output-log">
            {log.length === 0 ? (
              <p className="blurb output-hint">
                Tell the model what to change. Select a passage and it joins the
                change in the order it was picked — point at as many parts as you
                like before sending. Once sent, the next selection starts the
                next change.
              </p>
            ) : (
              log.map((s, i) => (
                <div key={i} className="output-said">
                  <div className="output-you">
                    {s.excerpts.length > 0 && (
                      <div className="output-quotes">
                        {s.excerpts.map((x, j) => (
                          <blockquote key={j}>
                            <span className="output-quote-no">{j + 1}</span>
                            {clip(x)}
                          </blockquote>
                        ))}
                      </div>
                    )}
                    <p>{s.you}</p>
                  </div>
                  <p
                    className={
                      s.outcome === "working" || s.outcome === "done"
                        ? "output-reply"
                        : "output-reply failed"
                    }
                  >
                    {s.outcome === "working" ? (
                      <>
                        <span className="spinner" aria-hidden="true" /> Rewriting the
                        document…
                      </>
                    ) : s.outcome === "done" ? (
                      "Rewrote the document."
                    ) : (
                      s.outcome
                    )}
                  </p>
                  {s.exportError && <p className="error">{s.exportError}</p>}
                  {s.files && <ExportFiles files={s.files} />}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>

          <div className="composer-box output-chat">
            {excerpts.length > 0 && (
              <div className="output-chips">
                {excerpts.map((x, i) => (
                  <span key={i} className="output-chip" title={x}>
                    <i className="output-chip-no">{i + 1}</i>
                    <span>{clip(x, 60)}</span>
                    <button
                      aria-label="Take this passage out"
                      data-tip="Take this out"
                      onClick={() => setExcerpts((xs) => xs.filter((_, j) => j !== i))}
                    >
                      <IconClose />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={draft}
              disabled={busy}
              aria-label="What to change"
              placeholder={
                excerpts.length
                  ? "What should change about these parts?"
                  : "Ask for a change — “cut the third section”, “open with the strongest claim”"
              }
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                undoDraft(e);
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void revise();
                }
              }}
            />
            <div className="bar">
              <button
                className="btn"
                disabled={busy || log.length === 0}
                data-tip="Forget the model's memory of this document"
                onClick={() => void startOver()}
              >
                Start over
              </button>
              <span className="spacer" />
              {busy ? (
                <button className="btn" onClick={() => void stopGeneration()}>
                  <IconStop />
                  Stop
                </button>
              ) : (
                <button
                  className="btn btn-send"
                  disabled={!draft.trim()}
                  onClick={() => void revise()}
                >
                  <IconSend />
                  Send
                </button>
              )}
            </div>
          </div>
        </aside>
      </div>

      {recover && (
        <div className="modal-overlay" onClick={() => setRecover(null)}>
          <div className="modal source-recover" onClick={(e) => e.stopPropagation()}>
            <h2 className="section">
              {recover.status === "archived"
                ? "This conversation was archived"
                : "This conversation was deleted"}
            </h2>
            <p className="blurb">
              {recover.status === "archived"
                ? "It is still filed away. Open it and it comes back to the current ones."
                : "It is still in the trash. Nothing has been destroyed, and it can be put back."}
            </p>
            <div className="modal-actions">
              <button className="btn subtle" onClick={() => setRecover(null)}>
                Leave it
              </button>
              <button className="btn on" onClick={() => void recoverSource(recover)}>
                {recover.status === "archived"
                  ? "Unarchive and open"
                  : "Recover from trash and open"}
              </button>
            </div>
          </div>
        </div>
      )}

      {source !== null && (
        <Sheet depth={1} onClose={() => setSource(null)}>
          <ConversationFile sessionId={source} onClose={() => setSource(null)} />
        </Sheet>
      )}
    </div>
  );
}
