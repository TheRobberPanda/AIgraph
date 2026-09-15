import { useState, type ReactNode } from "react";
import { IconChevron } from "./Icons";

/**
 * The app's own tick, for the bin and the archive. A native checkbox looked
 * like it came from another program; this is the one the Make picker uses,
 * with its third state for "some of this section".
 */
export function Tick({
  state,
  onChange,
  label,
}: {
  state: "on" | "part" | "off";
  onChange: (on: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "on" ? true : state === "part" ? "mixed" : false}
      aria-label={label}
      className={state === "off" ? "tick" : `tick ${state}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(state !== "on");
      }}
    >
      {state === "on" ? "✓" : state === "part" ? "–" : ""}
    </button>
  );
}

export interface BinRow {
  key: string;
  title: string;
  sub?: string;
  meta: string;
}

/**
 * One kind of thing in the bin or the archive: a folding head like the
 * conversations rail's, and rows shaped like the rail's too.
 */
export function BinSection({
  heading,
  rows,
  picked,
  onToggle,
  actions,
}: {
  heading: string;
  rows: BinRow[];
  picked: Set<string>;
  onToggle: (keys: string[], on: boolean) => void;
  /** The hover buttons at the end of a row. */
  actions: (row: BinRow) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const keys = rows.map((r) => r.key);
  const n = keys.filter((k) => picked.has(k)).length;
  return (
    <section className="bin-section">
      <div className="bin-heading">
        <Tick
          state={n === 0 ? "off" : n === keys.length ? "on" : "part"}
          onChange={(on) => onToggle(keys, on)}
          label={`Select every one of ${heading.toLowerCase()}`}
        />
        <button className="rail-section-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <IconChevron className={open ? "queue-chevron d1" : "queue-chevron d0"} />
          {heading} · {rows.length}
        </button>
      </div>
      {open && (
        <ul className="bin-list">
          {rows.map((r) => {
            const on = picked.has(r.key);
            return (
              <li key={r.key} className={on ? "bin-item picked" : "bin-item"}>
                <Tick state={on ? "on" : "off"} onChange={(v) => onToggle([r.key], v)} label={r.title} />
                <button className="bin-row" onClick={() => onToggle([r.key], !on)}>
                  <span className="bin-name">{r.title}</span>
                  {r.sub && <span className="bin-sub">{r.sub}</span>}
                  <span className="bin-meta">{r.meta}</span>
                </button>
                <span className="chat-actions">{actions(r)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
