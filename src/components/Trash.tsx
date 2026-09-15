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
import { BinSection } from "./BinSection";
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

  const pickedKeys = useMemo(() => new Set([...picked].map(String)), [picked]);
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
                className="btn quiet-danger head-end"
                onClick={() =>
                  setPurging({
                    ids: shown.rows.map((r) => r.id),
                    what: `every ${shown.one} in the trash (${shown.rows.length})`,
                  })
                }
              >
                <IconTrash />
                Empty {shown.heading.toLowerCase()}
              </button>
            ) : (
              <button
                className="btn quiet-danger head-end"
                onClick={() => setPurging({ ids: "all", what: `everything in the trash (${count(items.length)})` })}
              >
                <IconTrash />
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
            <span className="bin-count">{picked.size} selected</span>
            <button className="btn" onClick={() => void restore([...picked])}>
              <IconRewind />
              Restore
            </button>
            <button
              className="btn quiet-danger"
              onClick={() => setPurging({ ids: [...picked], what: count(picked.size) })}
            >
              <IconTrash />
              Delete for good
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
          shownSections.map((s) => (
            <BinSection
              key={s.kind}
              heading={s.heading}
              rows={s.rows.map((item) => ({
                key: String(item.id),
                title: item.label || `Untitled ${s.one}`,
                meta: `${item.detail ? `${item.detail} · ` : ""}deleted ${item.deleted_at ? longDate(item.deleted_at) : ""}`,
              }))}
              picked={pickedKeys}
              onToggle={(keys, on) => toggle(keys.map(Number), on)}
              actions={(r) => {
                const item = s.rows.find((x) => String(x.id) === r.key)!;
                return (
                  <>
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
                  </>
                );
              }}
            />
          ))
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
