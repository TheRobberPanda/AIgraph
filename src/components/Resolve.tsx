import { useState } from "react";
import Sheet from "./Sheet";
import { deleteIdea, editIdea, resolveRelation } from "../lib/ideas";
import { useUndoable } from "../lib/undo";

/** One side of a contradiction, as the sheet needs it. */
export interface Side {
  idea_id: number;
  claim: string;
}

/**
 * Settling a contradiction.
 *
 * Reconciliation is good at noticing that two claims cannot both stand, and
 * has no way at all to know which one is still believed. Until now it recorded
 * that and stopped there: a red dashed line on the map, permanent, with
 * nothing to do about it. A tension you cannot act on is just a complaint.
 *
 * So this offers the three things a person actually does with one — decide the
 * conflict was only apparent, reword the side that came out wrong, or drop the
 * one they no longer hold — and nothing else. Notably it does not offer to
 * pick a winner automatically, because the whole point is that the model
 * cannot know.
 *
 * Rewording goes through the same revision trail the model's own rewrites use,
 * so it is undoable from the idea's file afterwards.
 */
export default function Resolve({
  a,
  b,
  relationId,
  reasoning,
  onClose,
  onChanged,
}: {
  a: Side;
  b: Side;
  relationId: number;
  reasoning?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = useUndoable(draft, setDraft);

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

  const side = (s: Side) => (
    <li key={s.idea_id} className="resolve-side">
      {editing === s.idea_id ? (
        <>
          <textarea
            className="resolve-edit"
            value={draft}
            autoFocus
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => undo(e)}
          />
          <div className="row">
            <button
              className="btn"
              disabled={busy || !draft.trim()}
              onClick={() =>
                run(async () => {
                  await editIdea(s.idea_id, draft);
                  // Reworded to settle this, so it is settled.
                  await resolveRelation(relationId);
                })
              }
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
          <div className="row">
            <button
              className="btn subtle"
              disabled={busy}
              onClick={() => {
                setDraft(s.claim);
                setEditing(s.idea_id);
              }}
            >
              Reword this
            </button>
            <button
              className="btn subtle danger"
              disabled={busy}
              onClick={() => run(() => deleteIdea(s.idea_id))}
            >
              Drop this
            </button>
          </div>
        </>
      )}
    </li>
  );

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

        {reasoning && <p className="blurb">{reasoning}</p>}

        <ul className="resolve-sides">
          {side(a)}
          {side(b)}
        </ul>

        {/* Last, and quiet, because it is the answer least often right — but
            it is sometimes right, and without it the only way to close a
            tension you disagree with is to delete a true idea. */}
        <div className="row">
          <button
            className="btn"
            disabled={busy}
            onClick={() => run(() => resolveRelation(relationId))}
          >
            Both can stand
          </button>
        </div>
      </div>
    </Sheet>
  );
}
