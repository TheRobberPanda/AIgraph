import { useEffect, useRef, useState } from "react";
import Sheet from "./Sheet";
import { deleteIdea, editIdea, explainContradiction, resolveRelation } from "../lib/ideas";
import {
  onDictation,
  speechModelStatus,
  startDictation,
  stopDictation,
} from "../lib/dictation";
import { useUndoable } from "../lib/undo";
import { IconMic, IconPencil, IconTrash } from "./Icons";

/** One side of a contradiction, as the sheet needs it. */
export interface Side {
  idea_id: number;
  claim: string;
}

/**
 * Push-to-speak, small: one button that turns dictation on for this answer
 * and appends what is heard to the box beside it. The composer's own mic runs
 * the same recognizer, so only one of these is ever on at a time — and the
 * words go where the listener is looking, which is here while this is open.
 */
function ResolveMic({
  onPhrase,
  disabled,
}: {
  onPhrase: (text: string) => void;
  disabled?: boolean;
}) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [active, setActive] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const phraseRef = useRef(onPhrase);
  phraseRef.current = onPhrase;

  useEffect(() => {
    speechModelStatus()
      .then((s) => setInstalled(s.installed))
      .catch(() => setInstalled(false));
  }, []);

  useEffect(() => {
    const p = onDictation({
      phrase: (t) => phraseRef.current(t),
      speaking: setSpeaking,
      error: () => setActive(false),
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // The mic must not outlive the sheet it serves.
  useEffect(() => () => void stopDictation().catch(() => {}), []);

  async function toggle() {
    if (active) {
      setActive(false);
      await stopDictation().catch(() => {});
      return;
    }
    try {
      await startDictation();
      setActive(true);
    } catch {
      setActive(false);
    }
  }

  if (installed === null) return null;
  if (!installed) {
    return (
      <button
        className="resolve-mic"
        disabled
        data-tip="Dictation needs the speech model — install it on the Think tab"
      >
        <IconMic />
      </button>
    );
  }
  return (
    <button
      className={`resolve-mic${active ? " on" : ""}`}
      disabled={disabled}
      data-tip={active ? (speaking ? "Hearing you" : "Listening — speak") : "Dictate the answer"}
      aria-pressed={active}
      onClick={() => void toggle()}
    >
      <span className={speaking && active ? "mic-dot live" : "mic-dot"} aria-hidden="true" />
      <IconMic />
    </button>
  );
}

/**
 * Settling a contradiction.
 *
 * Reconciliation is good at noticing that two claims cannot both stand, and
 * has no way at all to know which one is still believed. The clash is one
 * message; the answer is written under it — or spoken — and kept on the link.
 *
 * The two claims stand next to each other, neither given the default's seat.
 * Each carries a pencil to reword it and a bin to drop it: hover the bin and
 * the claim crosses itself out, because what the press will do should be
 * visible before it is done. Rewording goes through the same revision trail
 * the model's own rewrites use, so it is undoable from the idea's file later.
 */
export default function Resolve({
  a,
  b,
  relationId,
  reasoning,
  resolution,
  onClose,
  onChanged,
}: {
  a: Side;
  b: Side;
  relationId: number;
  reasoning?: string;
  /** What was said the last time this was settled, if it was reopened. */
  resolution?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  /** Which claim is being reworded, and what is in the box so far. */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const undoDraft = useUndoable(draft, setDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stand, setStand] = useState(resolution ?? "");
  const undoStand = useUndoable(stand, setStand);
  /** Why these clash. Asked for when the link was drawn without a reason. */
  const [why, setWhy] = useState<string | null>(reasoning?.trim() || null);
  const [asking, setAsking] = useState(!reasoning?.trim());
  /** The claim a bin is pointed at, so it can cross itself out as offered. */
  const [doomed, setDoomed] = useState<number | null>(null);

  useEffect(() => {
    if (reasoning?.trim()) {
      setWhy(reasoning.trim());
      setAsking(false);
      return;
    }
    let live = true;
    setAsking(true);
    explainContradiction(relationId)
      .then((w) => live && setWhy(w.trim() || null))
      .catch(() => live && setWhy(null))
      .finally(() => live && setAsking(false));
    return () => {
      live = false;
    };
  }, [relationId, reasoning]);

  const done = () => {
    onChanged();
    onClose();
  };

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void work()
      .then(done)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const drop = (s: Side) =>
    run(async () => {
      await deleteIdea(s.idea_id);
      // Dropped to settle this, so it is settled.
      await resolveRelation(relationId);
    });

  const reword = (s: Side) =>
    run(async () => {
      await editIdea(s.idea_id, draft);
      // Reworded to settle this, so it is settled.
      await resolveRelation(relationId);
    });

  const side = (s: Side) => {
    const isEditing = editing === s.idea_id;
    const dying = doomed === s.idea_id;
    return (
      <li
        key={s.idea_id}
        className={`resolve-side${dying ? " doomed" : ""}`}
        data-tip={
          isEditing ? undefined : dying ? "Click the bin again — the claim goes, with its quotes"
            : "One of the two claims. Drop it with the bin, reword it with the pencil"
        }
        onMouseLeave={() => setDoomed((d) => (d === s.idea_id ? null : d))}
      >
        {isEditing ? (
          <>
            <textarea
              className="resolve-edit"
              value={draft}
              autoFocus
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                undoDraft(e);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !busy) {
                  e.preventDefault();
                  void reword(s);
                }
              }}
            />
            <div className="row">
              <button
                className="btn"
                disabled={busy || !draft.trim()}
                onClick={() => void reword(s)}
              >
                Save it
              </button>
              <button className="btn subtle" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="resolve-claim">{s.claim}</p>
            <div className="resolve-tools">
              <span className="spacer" />
              <button
                className="icon-btn"
                data-tip="Reword this claim — saved as a revision, so it can be undone"
                disabled={busy}
                onClick={() => {
                  setDraft(s.claim);
                  setEditing(s.idea_id);
                }}
              >
                <IconPencil />
              </button>
              <button
                className="resolve-bin"
                data-tip="Drop this idea — it is deleted, and the tension ends"
                disabled={busy}
                onMouseEnter={() => setDoomed(s.idea_id)}
                onMouseLeave={() => setDoomed((d) => (d === s.idea_id ? null : d))}
                onClick={() => void drop(s)}
              >
                <IconTrash />
              </button>
            </div>
          </>
        )}
      </li>
    );
  };

  return (
    <Sheet onClose={onClose}>
      <div className="pane-inner">
        <header className="head">
          <button className="btn" onClick={onClose}>
            ← Back
          </button>
          <span className="muted">Two things that cannot both hold</span>
        </header>

        {error && <p className="error">{error}</p>}

        {/* One next to the other, on purpose: the question this settles is
            which of the two to keep, and stacking them put one of them where
            a default answer would sit. */}
        <div className="resolve-sides">{side(a)}{side(b)}</div>

        <section className="resolve-clash">
          {/* The clash, as one message. Asked for when the link was drawn
              without a reason; the reply goes under it, small, with a way to
              say it instead of typing it. */}
          <div className="resolve-msg">
            <span className="resolve-msg-kind" aria-hidden="true">
              why these clash
            </span>
            {asking ? (
              <p className="resolve-waiting">
                <span className="spinner" aria-hidden="true" /> Asking the model what the
                conflict is…
              </p>
            ) : why ? (
              <p className="resolve-msg-text">{why}</p>
            ) : (
              <p className="muted resolve-msg-none">
                No reason was recorded for this link, and the model could not give one.
              </p>
            )}
          </div>

          <div className="resolve-reply">
            <textarea
              className="resolve-edit"
              value={stand}
              rows={2}
              autoFocus={editing === null}
              placeholder="Say how both hold at once — different circumstances, a different sense of a word, one true of a part and the other of the whole…"
              onChange={(e) => setStand(e.target.value)}
              onKeyDown={(e) => {
                undoStand(e);
                if (e.key === "Enter" && !e.shiftKey && stand.trim() && !busy) {
                  e.preventDefault();
                  run(() => resolveRelation(relationId, stand.trim()));
                }
              }}
            />
            <ResolveMic
              onPhrase={(text) => setStand((s) => (s ? `${s.trimEnd()} ${text.trim()}` : text))}
            />
          </div>
          <div className="row resolve-actions">
            <button
              className="btn btn-send"
              disabled={busy || !stand.trim()}
              onClick={() => run(() => resolveRelation(relationId, stand.trim()))}
            >
              Resolve it
            </button>
            <span className="spacer" />
            {/* The dismissal. Sometimes right — a pair that was never really in
                tension — and without it the only way to close one you disagree
                with is to delete a true idea. Quiet, because it says nothing. */}
            <button
              className="btn subtle"
              disabled={busy}
              data-tip="Close this without saying why"
              onClick={() => run(() => resolveRelation(relationId))}
            >
              Both stand
            </button>
          </div>
        </section>
      </div>
    </Sheet>
  );
}