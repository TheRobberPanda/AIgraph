import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  bookCheck,
  bookExport,
  bookOutline,
  bookProject,
  bookSave,
  bookWriteChapter,
  onBookToken,
  type BookChapter,
  type BookNote,
  type BookProject,
} from "../lib/book";
import { stopGeneration } from "../lib/compose";
import { getSettings, saveSettings } from "../lib/settings";
import Markdown from "./Markdown";
import Mic from "./Mic";
import { IconChevron, IconDownload, IconStop } from "./Icons";

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** One more phrase, dictated onto the end of what is there. */
const joinPhrase = (have: string, heard: string) =>
  have.trim() ? `${have.trimEnd()} ${heard}` : heard;

/**
 * The book writer (beta).
 *
 * A folder's ideas, written up as a book in the person's own voice. One reply
 * cannot hold a book, so it is written the way a person writes one: an
 * outline first — edited here before anything else is written — then a
 * chapter at a time, each carrying summaries of the ones before it, the ideas
 * and quotes recall finds for it, and samples of how the person talks.
 *
 * Everything is kept per folder and saved as it changes, so a book can be
 * written over days, a chapter at a sitting.
 */
export default function BookWriter({ folder }: { folder: number | null }) {
  const [project, setProject] = useState<BookProject | null>(null);
  const [brief, setBrief] = useState("");
  const [count, setCount] = useState(8);
  /** What the model is doing: planning, checking, or writing chapter n. */
  const [busy, setBusy] = useState<null | "outline" | "check" | number>(null);
  /** The chapter being written, as far as it has got. */
  const [live, setLive] = useState<{ index: number; text: string } | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [notes, setNotes] = useState<BookNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** Redrafting over written chapters asks twice. */
  const [confirmRedo, setConfirmRedo] = useState(false);
  const [micTimeout, setMicTimeout] = useState(0);
  /** Set by Stop, read between chapters of "write the rest". */
  const stopRest = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<BookProject | null>(null);

  useEffect(() => {
    setProject(null);
    setNotes(null);
    setError(null);
    bookProject(folder)
      .then((p) => {
        // A draft that comes back misshapen opens as no book, not as a crash.
        const safe: BookProject =
          p && Array.isArray(p.chapters)
            ? p
            : { title: "", brief: "", language: "", chapters: [] };
        setProject(safe);
        setBrief(safe.brief ?? "");
      })
      .catch((e) => setError(String(e)));
  }, [folder]);

  useEffect(() => {
    void getSettings()
      .then((s) => setMicTimeout(s.mic_timeout_seconds))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const p = onBookToken((t) =>
      setLive((l) => ({ index: t.index, text: (l && l.index === t.index ? l.text : "") + t.text })),
    );
    return () => {
      void p.then((un) => un());
    };
  }, []);

  /** Keep an edit: shown at once, saved after a pause in typing. */
  function edit(next: BookProject) {
    setProject(next);
    pending.current = next;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flush(), 600);
  }

  /** Save now what is waiting — before anything the backend reads the file for. */
  async function flush() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) await bookSave(folder, p).catch((e) => setError(String(e)));
  }

  function editChapter(i: number, patch: Partial<BookChapter>) {
    if (!project) return;
    const chapters = project.chapters.map((c, j) => (j === i ? { ...c, ...patch } : c));
    edit({ ...project, chapters });
  }

  function moveChapter(i: number, by: -1 | 1) {
    if (!project) return;
    const j = i + by;
    if (j < 0 || j >= project.chapters.length) return;
    const chapters = [...project.chapters];
    [chapters[i], chapters[j]] = [chapters[j], chapters[i]];
    setOpen(new Set());
    edit({ ...project, chapters });
  }

  function removeChapter(i: number) {
    if (!project) return;
    setOpen(new Set());
    edit({ ...project, chapters: project.chapters.filter((_, j) => j !== i) });
  }

  function addChapter() {
    if (!project) return;
    const blank: BookChapter = { title: "New chapter", plan: "", ideas: [], text: "", summary: "", used: [] };
    edit({ ...project, chapters: [...project.chapters, blank] });
  }

  const written = project?.chapters.filter((c) => c.text.trim()).length ?? 0;

  async function draftOutline() {
    if (written > 0 && !confirmRedo) {
      setConfirmRedo(true);
      return;
    }
    setConfirmRedo(false);
    await flush();
    setBusy("outline");
    setError(null);
    setNotes(null);
    try {
      setProject(await bookOutline(folder, brief, count));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  /** Write one chapter. True when it landed. */
  async function write(i: number): Promise<boolean> {
    await flush();
    setBusy(i);
    setLive({ index: i, text: "" });
    setError(null);
    setDone(null);
    try {
      const p = await bookWriteChapter(folder, i);
      setProject(p);
      setOpen((o) => new Set(o).add(i));
      return true;
    } catch (e) {
      if (!stopRest.current) setError(String(e));
      return false;
    } finally {
      setBusy(null);
      setLive(null);
    }
  }

  /** Every chapter not yet written, in order, until done or stopped. */
  async function writeRest() {
    if (!project) return;
    stopRest.current = false;
    for (let i = 0; i < project.chapters.length; i++) {
      if (stopRest.current) break;
      if (project.chapters[i].text.trim()) continue;
      if (!(await write(i))) break;
    }
  }

  function stop() {
    stopRest.current = true;
    void stopGeneration();
  }

  async function check() {
    await flush();
    setBusy("check");
    setError(null);
    try {
      setNotes(await bookCheck(folder));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function exportBook() {
    await flush();
    const name = (project?.title || "book").replace(/[\\/:*?"<>|]/g, "").trim() || "book";
    const path = await save({
      defaultPath: `${name}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    try {
      await bookExport(folder, path);
      setDone(`Saved to ${path}`);
    } catch (e) {
      setError(String(e));
    }
  }

  const locked = busy !== null;

  return (
    <div className="pane-inner book">
      <header className="head">
        <h1>Book</h1>
        <span className="tag beta" data-tip="New, and still changing — keep a copy of anything you care about">
          beta
        </span>
        <span className="muted">
          {project?.chapters.length
            ? `${written} of ${project.chapters.length} chapters written`
            : "Your ideas, written up in your own voice"}
        </span>
      </header>

      {error && <p className="error">{error}</p>}
      {done && <p className="blurb">{done}</p>}

      <section className="book-brief">
        <textarea
          className="field book-brief-text"
          rows={3}
          value={brief}
          disabled={locked}
          placeholder="What should the book be? Who it's for, what it argues, what it must include or leave out. Leave it empty and it's built from the ideas alone."
          onChange={(e) => setBrief(e.target.value)}
        />
        <div className="bar">
          <Mic
            onPhrase={(text) => setBrief((b) => joinPhrase(b, text))}
            disabled={locked}
            timeoutSeconds={micTimeout}
            onTimeoutChange={(secs) => {
              setMicTimeout(secs);
              void getSettings().then((s) => saveSettings({ ...s, mic_timeout_seconds: secs }));
            }}
          />
          <select
            className="field"
            value={count}
            disabled={locked}
            aria-label="Chapters"
            onChange={(e) => setCount(Number(e.target.value))}
          >
            {[4, 6, 8, 10, 12, 16].map((n) => (
              <option key={n} value={n}>
                about {n} chapters
              </option>
            ))}
          </select>
          <button
            className={confirmRedo ? "btn danger" : "btn btn-send"}
            disabled={locked}
            onClick={() => void draftOutline()}
            data-tip="Plan the chapters from this folder's ideas. Nothing is written yet."
          >
            {busy === "outline" ? (
              <>
                <span className="spinner" aria-hidden="true" /> Planning…
              </>
            ) : confirmRedo ? (
              "Redraft? Chapters whose title changes lose their text"
            ) : project?.chapters.length ? (
              "Redraft the outline"
            ) : (
              "Draft the outline"
            )}
          </button>
          {confirmRedo && (
            <button className="btn subtle" onClick={() => setConfirmRedo(false)}>
              Keep it
            </button>
          )}
        </div>
      </section>

      {project && project.chapters.length > 0 ? (
        <>
          <input
            className="field book-title"
            value={project.title}
            disabled={locked}
            aria-label="Book title"
            onChange={(e) => edit({ ...project, title: e.target.value })}
          />

          <div className="row book-actions">
            {typeof busy === "number" ? (
              <button className="btn" onClick={stop} data-tip="Stop writing; nothing half-written is kept">
                <IconStop /> Stop
              </button>
            ) : (
              <button
                className="btn btn-send"
                disabled={locked || written === project.chapters.length}
                onClick={() => void writeRest()}
                data-tip="Write every chapter not written yet, in order"
              >
                Write the rest
              </button>
            )}
            <button
              className="btn"
              disabled={locked || written === 0}
              onClick={() => void check()}
              data-tip="Read the book against its outline and point out where it drifted"
            >
              {busy === "check" ? <span className="spinner" aria-hidden="true" /> : "Check against the outline"}
            </button>
            <button className="btn" disabled={locked || written === 0} onClick={() => void exportBook()}>
              <IconDownload /> Markdown
            </button>
          </div>

          {notes && (
            <div className="book-notes">
              {notes.length === 0 ? (
                <p className="blurb">Nothing found — the chapters do what the outline says.</p>
              ) : (
                <ul>
                  {notes.map((n, k) => (
                    <li key={k}>
                      <b>{n.chapter}.</b> {n.note}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <ol className="book-chapters">
            {project.chapters.map((c, i) => {
              const writing = busy === i;
              const shown = open.has(i) && c.text && !writing;
              return (
                <li key={i} className={writing ? "book-chapter writing" : "book-chapter"}>
                  <div className="book-ch-head">
                    <span className="book-ch-no">{i + 1}</span>
                    <input
                      className="field book-ch-title"
                      value={c.title}
                      disabled={locked}
                      aria-label={`Chapter ${i + 1} title`}
                      onChange={(e) => editChapter(i, { title: e.target.value })}
                    />
                    <span className={c.text ? "tag ready" : "tag"}>
                      {writing ? "writing…" : c.text ? `${words(c.text)} words` : "not written"}
                    </span>
                    <button className="btn" disabled={locked} onClick={() => void write(i)}>
                      {writing ? <span className="spinner" aria-hidden="true" /> : c.text ? "Rewrite" : "Write"}
                    </button>
                    {c.text && !writing && (
                      <button
                        className="icon-btn"
                        data-tip={open.has(i) ? "Fold it away" : "Read it"}
                        onClick={() =>
                          setOpen((o) => {
                            const next = new Set(o);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          })
                        }
                      >
                        <IconChevron className={open.has(i) ? "flip" : undefined} />
                      </button>
                    )}
                  </div>
                  <textarea
                    className="field book-ch-plan"
                    rows={2}
                    value={c.plan}
                    disabled={locked}
                    placeholder="What this chapter argues"
                    onChange={(e) => editChapter(i, { plan: e.target.value })}
                  />
                  <div className="book-ch-tools">
                    <button className="btn subtle" disabled={locked || i === 0} onClick={() => moveChapter(i, -1)}>
                      Up
                    </button>
                    <button
                      className="btn subtle"
                      disabled={locked || i === project.chapters.length - 1}
                      onClick={() => moveChapter(i, 1)}
                    >
                      Down
                    </button>
                    <button className="btn subtle" disabled={locked} onClick={() => removeChapter(i)}>
                      Remove
                    </button>
                  </div>

                  {writing && live?.index === i && (
                    <div className="book-ch-text live">
                      {live.text ? <Markdown>{live.text}</Markdown> : <p className="blurb">Starting…</p>}
                    </div>
                  )}
                  {shown &&
                    (editing === i ? (
                      <>
                        <textarea
                          className="field book-ch-edit"
                          value={c.text}
                          onChange={(e) => editChapter(i, { text: e.target.value })}
                        />
                        <div className="book-ch-tools">
                          <button className="btn" onClick={() => setEditing(null)}>
                            Done editing
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="book-ch-text">
                          <Markdown>{c.text}</Markdown>
                        </div>
                        <div className="book-ch-tools">
                          <button className="btn subtle" disabled={locked} onClick={() => setEditing(i)}>
                            Edit the text
                          </button>
                        </div>
                      </>
                    ))}
                </li>
              );
            })}
          </ol>
          <button className="btn subtle book-add" disabled={locked} onClick={addChapter}>
            Add a chapter
          </button>
        </>
      ) : (
        project && (
          <p className="empty">
            <strong>No outline yet.</strong>
            <span className="empty-hint">
              Say what the book should be — or say nothing — and draft the outline. You edit it
              before a single chapter is written.
            </span>
          </p>
        )
      )}
    </div>
  );
}
