import { useCallback, useEffect, useMemo, useState } from "react";
import {
  emptyTrash,
  listTrash,
  purgeTrashed,
  restoreTrashed,
  type TrashedItem,
  type TrashedKind,
} from "../lib/trash";
import { onIdeasChanged } from "../lib/ideas";
import { longDate } from "../lib/format";
import { ConfirmThrice } from "./Confirm";
import Sheet from "./Sheet";
import { IconRewind, IconTrash } from "./Icons";

/** The bin's sections, in the order they are shown. */
const KINDS: { kind: TrashedKind; heading: string; one: string; many: string }[] = [
  { kind: "session", heading: "Conversations", one: "conversation", many: "conversations" },
  { kind: "idea", heading: "Ideas", one: "idea", many: "ideas" },
  { kind: "make_output", heading: "Outputs", one: "output", many: "outputs" },
  { kind: "message", heading: "Messages", one: "message", many: "messages" },
];

/**
 * The bin.
 *
 * Every delete lands here instead of gone: conversations with their turns and
 * their ideas, ideas with their quotes, outputs with their text. A restore
 * puts the whole thing back where it was. This is the only place anything can
 * be destroyed for good, and it asks three times before it does — for one
 * thing, for a selection, or for the whole bin.
 */
export default function Trash({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<TrashedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  /** What is about to be destroyed, once the three questions are answered. */
  const [purging, setPurging] = useState<{ ids: number[] | "all"; what: string } | null>(null);
  const [category, setCategory] = useState<TrashedKind | "all">("all");

  const refresh = useCallback(() => {
    listTrash()
      .then((rows) => {
        setItems(rows);
        // A selection only ever holds what is still in the bin.
        setPicked((prev) => new Set(rows.filter((r) => prev.has(r.id)).map((r) => r.id)));
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const p = onIdeasChanged(refresh);
    return () => {
      void p.then((un) => un());
    };
  }, [refresh]);

  const sections = useMemo(
    () =>
      KINDS.map((k) => ({ ...k, rows: (items ?? []).filter((i) => i.kind === k.kind) })).filter(
        (s) => s.rows.length > 0,
      ),
    [items],
  );
  // A category that has just been emptied falls back to showing everything.
  const current = sections.some((s) => s.kind === category) ? category : "all";
  const shown = sections.find((s) => s.kind === current);
  const shownSections = shown ? [shown] : sections;

  function toggle(ids: number[], on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function restore(ids: number[]) {
    try {
      // A deleted message has no conversation to go back into, so it is
      // kept to be read here and nothing else.
      for (const id of ids) if (id > 0) await restoreTrashed(id);
    } catch (e) {
      setError(String(e));
    }
    refresh();
    onChanged();
  }

  async function purge(ids: number[] | "all") {
    try {
      if (ids === "all") await emptyTrash();
      else for (const id of ids) await purgeTrashed(id);
    } catch (e) {
      setError(String(e));
    }
    refresh();
  }

  const count = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

  return (
    <Sheet onClose={onClose}>
      <div className="pane-inner">
        <header className="head">
          <button className="btn" onClick={onClose}>
            Back
          </button>
          <h1>Trash bin</h1>
          <span className="muted">{items === null ? "Loading…" : count(items.length)}</span>
          {items !== null && items.length > 0 &&
            (shown ? (
              <button
                className="btn danger head-end"
                onClick={() =>
                  setPurging({
                    ids: shown.rows.map((r) => r.id),
                    what: `every ${shown.one} in the trash (${shown.rows.length})`,
                  })
                }
              >
                Empty {shown.heading.toLowerCase()}
              </button>
            ) : (
              <button
                className="btn danger head-end"
                onClick={() => setPurging({ ids: "all", what: `everything in the trash (${count(items.length)})` })}
              >
                Empty the trash
              </button>
            ))}
        </header>

        {error && <p className="error">{error}</p>}

        {sections.length > 1 && (
          <div className="row source-tabs bin-tabs" role="tablist">
            <button
              className={current === "all" ? "btn on" : "btn"}
              role="tab"
              aria-selected={current === "all"}
              onClick={() => setCategory("all")}
            >
              All <span className="muted">{items?.length ?? 0}</span>
            </button>
            {sections.map((s) => (
              <button
                key={s.kind}
                className={current === s.kind ? "btn on" : "btn"}
                role="tab"
                aria-selected={current === s.kind}
                onClick={() => setCategory(s.kind)}
              >
                {s.heading} <span className="muted">{s.rows.length}</span>
              </button>
            ))}
          </div>
        )}

        {picked.size > 0 && (
          <div className="row bin-bar">
            <span>{picked.size} selected</span>
            <button className="btn grow" onClick={() => void restore([...picked])}>
              <IconRewind />
              <span className="btn-label">Restore</span>
            </button>
            <button
              className="btn danger grow"
              onClick={() => setPurging({ ids: [...picked], what: count(picked.size) })}
            >
              <IconTrash />
              <span className="btn-label">Delete for good</span>
            </button>
            <button className="btn" onClick={() => setPicked(new Set())}>
              Clear
            </button>
          </div>
        )}

        {items === null ? (
          <p className="empty">Loading…</p>
        ) : items.length === 0 ? (
          <p className="empty">
            Nothing here. Deleted conversations, ideas, outputs and messages wait in this
            bin rather than vanishing — restore them, or delete them for good
            from here.
          </p>
        ) : (
          shownSections.map((s) => {
            const ids = s.rows.map((r) => r.id);
            const all = ids.every((id) => picked.has(id));
            return (
              <section key={s.kind} className="bin-section">
                <label className="bin-heading">
                  <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} />
                  <h3 className="section">{s.heading}</h3>
                  <span className="muted">{s.rows.length}</span>
                </label>
                <ul className="list">
                  {s.rows.map((item) => (
                    <li key={item.id} className={picked.has(item.id) ? "chat-line picked" : "chat-line"}>
                      <label className="row-btn bin-row">
                        <input
                          type="checkbox"
                          checked={picked.has(item.id)}
                          onChange={(e) => toggle([item.id], e.target.checked)}
                        />
                        <span className="row-main">{item.label || `Untitled ${s.one}`}</span>
                        <span className="row-meta">
                          {item.detail ? `${item.detail} · ` : ""}deleted{" "}
                          {item.deleted_at ? longDate(item.deleted_at) : ""}
                        </span>
                      </label>
                      <span className="chat-actions">
                        {item.kind !== "message" && (
                          <button
                            className="icon-btn"
                            data-tip="Put it back where it was"
                            onClick={() => void restore([item.id])}
                          >
                            <IconRewind />
                          </button>
                        )}
                        <button
                          className="icon-btn"
                          data-tip="Delete for good"
                          onClick={() =>
                            setPurging({ ids: [item.id], what: `the ${s.one} “${item.label || item.id}”` })
                          }
                        >
                          <IconTrash />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}

        {purging !== null && (
          <ConfirmThrice
            what={purging.what}
            onCancel={() => setPurging(null)}
            onConfirm={() => {
              const ids = purging.ids;
              setPurging(null);
              if (ids !== "all") toggle(ids, false);
              void purge(ids);
            }}
          />
        )}
      </div>
    </Sheet>
  );
}
