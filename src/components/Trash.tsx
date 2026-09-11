import { useCallback, useEffect, useState } from "react";
import {
  emptyTrash,
  listTrash,
  purgeTrashed,
  restoreTrashed,
  type TrashedItem,
} from "../lib/trash";
import { onIdeasChanged } from "../lib/ideas";
import { longDate } from "../lib/format";
import Confirm from "./Confirm";
import Sheet from "./Sheet";
import { IconArchive, IconTrash } from "./Icons";

/**
 * The bin.
 *
 * Every delete lands here instead of gone: conversations with their turns and
 * their ideas, ideas with their quotes, outputs with their text. A restore
 * puts the whole thing back where it was; emptying the bin is the one delete
 * that cannot be taken back, so it is the only one that asks twice.
 */
export default function Trash({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<TrashedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which entry is one click from being destroyed for good. */
  const [purging, setPurging] = useState<TrashedItem | null>(null);
  const [emptying, setEmptying] = useState(false);

  const refresh = useCallback(() => {
    listTrash().then(setItems).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    // A restore puts ideas back on the map; the bin's own list is what this
    // is here for.
    const p = onIdeasChanged(refresh);
    return () => {
      void p.then((un) => un());
    };
  }, [refresh]);

  function kindName(kind: TrashedItem["kind"]): string {
    switch (kind) {
      case "session":
        return "Conversation";
      case "idea":
        return "Idea";
      case "make_output":
        return "Output";
    }
  }

  return (
    <Sheet onClose={onClose}>
      <div className="pane-inner">
        <header className="head">
          <button className="btn" onClick={onClose}>
            Back
          </button>
          <span className="muted">
            {items === null ? "Loading…" : `${items.length} in the trash`}
          </span>
          {items !== null && items.length > 0 && (
            <button className="btn danger" onClick={() => setEmptying(true)}>
              Empty the trash
            </button>
          )}
        </header>

        {error && <p className="error">{error}</p>}

        {items === null ? (
          <p className="empty">Loading…</p>
        ) : items.length === 0 ? (
          <p className="empty">
            Nothing here. Deleted conversations and ideas wait in this bin
            rather than vanishing — restore them, or empty the trash to be rid
            of them for good.
          </p>
        ) : (
          <ul className="list">
            {items.map((item) => (
              <li key={item.id} className="chat-line">
                <span className="row-btn">
                  <span className="row-main">
                    <i
                      className="tag-swatch"
                      style={
                        {
                          "--tag-color": item.kind === "session" ? "var(--accent)" : "var(--muted)",
                        } as React.CSSProperties
                      }
                      aria-hidden="true"
                    />{" "}
                    {item.label || `Conversation ${item.id}`}
                  </span>
                  <span className="row-meta">
                    {kindName(item.kind)}
                    {item.detail ? ` · ${item.detail}` : ""} · deleted{" "}
                    {item.deleted_at ? longDate(item.deleted_at) : ""}
                  </span>
                </span>
                <span className="chat-actions">
                  <button
                    className="icon-btn"
                    data-tip="Put it back where it was"
                    onClick={() =>
                      void restoreTrashed(item.id)
                        .then(() => {
                          refresh();
                          onChanged();
                        })
                        .catch((e) => setError(String(e)))
                    }
                  >
                    <IconArchive />
                  </button>
                  <button
                    className="icon-btn"
                    data-tip="Delete for good"
                    onClick={() => setPurging(item)}
                  >
                    <IconTrash />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {purging !== null && (
          <Confirm
            title={`Destroy “${purging.label}” for good? This cannot be undone.`}
            danger
            onConfirm={() => {
              const id = purging.id;
              setPurging(null);
              purgeTrashed(id)
                .then(refresh)
                .catch((e) => setError(String(e)));
            }}
            onCancel={() => setPurging(null)}
          />
        )}

        {emptying && (
          <Confirm
            title="Empty the trash? Everything in it is destroyed for good."
            danger
            onConfirm={() => {
              setEmptying(false);
              emptyTrash()
                .then(refresh)
                .catch((e) => setError(String(e)));
            }}
            onCancel={() => setEmptying(false)}
          />
        )}
      </div>
    </Sheet>
  );
}