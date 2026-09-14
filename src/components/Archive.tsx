import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteSession, setSessionArchived, type SessionSummary } from "../lib/chat";
import {
  archivedIdeas,
  archivedSessions,
  deleteIdea,
  onIdeasChanged,
  type ArchivedIdea,
} from "../lib/ideas";
import {
  deleteMakeOutput,
  listMakeOutputs,
  setMakeOutputArchived,
  type MakeOutput,
} from "../lib/outputs";
import { longDate } from "../lib/format";
import Confirm from "./Confirm";
import Sheet from "./Sheet";
import { IconRewind, IconTrash } from "./Icons";

type Kind = "session" | "idea" | "output";

interface Row {
  key: string;
  kind: Kind;
  id: number;
  title: string;
  sub: string;
  meta: string;
}

const KINDS: { kind: Kind; heading: string; restore: string | null }[] = [
  { kind: "session", heading: "Conversations", restore: "Put it back in the waiting list" },
  { kind: "idea", heading: "Ideas", restore: null },
  { kind: "output", heading: "Outputs", restore: "Put it back with the other outputs" },
];

/** A conversation's name when it has no title yet: its first spoken line. */
function titleOf(s: SessionSummary): string {
  if (s.title.trim()) return s.title;
  const first = s.opening
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (first ?? "").slice(0, 90) || `Conversation ${s.id}`;
}

/**
 * What was set aside — out of the way, not gone.
 *
 * Conversations put aside before they were read, ideas a re-read left with no
 * conversation to stand on, and outputs archived from Make. From here any of
 * it goes back, or on to the trash bin; nothing here is destroyed.
 */
export default function Archive({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [ideas, setIdeas] = useState<ArchivedIdea[] | null>(null);
  const [outputs, setOutputs] = useState<MakeOutput[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [binning, setBinning] = useState<Row[] | null>(null);
  const [category, setCategory] = useState<Kind | "all">("all");

  const refresh = useCallback(() => {
    archivedSessions().then(setSessions).catch((e) => setError(String(e)));
    archivedIdeas().then(setIdeas).catch((e) => setError(String(e)));
    listMakeOutputs(null)
      .then((all) => setOutputs(all.filter((o) => o.archived)))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const p = onIdeasChanged(refresh);
    return () => {
      void p.then((un) => un());
    };
  }, [refresh]);

  const rows = useMemo<Row[]>(
    () => [
      ...(sessions ?? []).map((s) => ({
        key: `session-${s.id}`,
        kind: "session" as const,
        id: s.id,
        title: titleOf(s),
        sub: titleOf(s) !== s.opening.trim() ? s.opening.trim() : "",
        meta: `${s.started_at ? longDate(s.started_at) : ""} · ${s.turn_count} turns`,
      })),
      ...(ideas ?? []).map((i) => ({
        key: `idea-${i.id}`,
        kind: "idea" as const,
        id: i.id,
        title: i.title,
        sub: i.title !== i.claim.trim() ? i.claim.trim() : "",
        meta: i.category || "idea",
      })),
      ...(outputs ?? []).map((o) => ({
        key: `output-${o.id}`,
        kind: "output" as const,
        id: o.id,
        title: o.title || `Output ${o.id}`,
        sub: o.summary,
        meta: o.created_at ? longDate(o.created_at) : "",
      })),
    ],
    [sessions, ideas, outputs],
  );
  const loading = sessions === null || ideas === null || outputs === null;
  const sections = KINDS.map((k) => ({ ...k, rows: rows.filter((r) => r.kind === k.kind) })).filter(
    (s) => s.rows.length > 0,
  );
  // A category that has just been emptied falls back to showing everything.
  const current = sections.some((s) => s.kind === category) ? category : "all";
  const shownSections = current === "all" ? sections : sections.filter((s) => s.kind === current);
  const shownRows = shownSections.flatMap((s) => s.rows);

  function toggle(keys: string[], on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  async function run(list: Row[], what: "restore" | "bin") {
    try {
      for (const r of list) {
        if (what === "restore") {
          if (r.kind === "session") await setSessionArchived(r.id, false);
          else if (r.kind === "output") await setMakeOutputArchived(r.id, false);
        } else if (r.kind === "session") await deleteSession(r.id);
        else if (r.kind === "idea") await deleteIdea(r.id);
        else await deleteMakeOutput(r.id);
      }
    } catch (e) {
      setError(String(e));
    }
    toggle(
      list.map((r) => r.key),
      false,
    );
    refresh();
    onChanged();
  }

  const selected = rows.filter((r) => picked.has(r.key));
  const restorable = selected.filter((r) => r.kind !== "idea");

  return (
    <Sheet onClose={onClose}>
      <div className="pane-inner">
        <header className="head">
          <button className="btn" onClick={onClose}>
            Back
          </button>
          <h1>Archived</h1>
          <span className="muted">{loading ? "Loading…" : `${rows.length} set aside`}</span>
          {shownRows.length > 0 && (
            <button className="btn grow head-end" onClick={() => setBinning(shownRows)}>
              <IconTrash />
              <span className="btn-label">
                {current === "all"
                  ? "Move all to the trash bin"
                  : `Move all ${KINDS.find((k) => k.kind === current)!.heading.toLowerCase()} to the trash bin`}
              </span>
            </button>
          )}
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
              All <span className="muted">{rows.length}</span>
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

        {selected.length > 0 && (
          <div className="row bin-bar">
            <span>{selected.length} selected</span>
            {restorable.length > 0 && (
              <button className="btn grow" onClick={() => void run(restorable, "restore")}>
                <IconRewind />
                <span className="btn-label">Put back</span>
              </button>
            )}
            <button className="btn grow" onClick={() => setBinning(selected)}>
              <IconTrash />
              <span className="btn-label">Move to the trash bin</span>
            </button>
            <button className="btn" onClick={() => setPicked(new Set())}>
              Clear
            </button>
          </div>
        )}

        {!loading && rows.length === 0 ? (
          <p className="empty">
            Nothing set aside. Conversations you archive before they are read,
            ideas a re-read leaves without a conversation, and outputs you
            archive in Make wait here.
          </p>
        ) : (
          shownSections.map((s) => {
            const keys = s.rows.map((r) => r.key);
            return (
              <section key={s.kind} className="bin-section">
                <label className="bin-heading">
                  <input
                    type="checkbox"
                    checked={keys.every((k) => picked.has(k))}
                    onChange={(e) => toggle(keys, e.target.checked)}
                  />
                  <h3 className="section">{s.heading}</h3>
                  <span className="muted">{s.rows.length}</span>
                </label>
                <ul className="list">
                  {s.rows.map((r) => (
                    <li key={r.key} className={picked.has(r.key) ? "chat-line picked" : "chat-line"}>
                      <label className="row-btn bin-row">
                        <input
                          type="checkbox"
                          checked={picked.has(r.key)}
                          onChange={(e) => toggle([r.key], e.target.checked)}
                        />
                        <span className="row-main">
                          <span className="queue-title">{r.title}</span>
                          {r.sub && <span className="queue-opening">{r.sub}</span>}
                        </span>
                        <span className="row-meta">{r.meta}</span>
                      </label>
                      <span className="chat-actions">
                        {s.restore && (
                          <button
                            className="icon-btn"
                            data-tip={s.restore}
                            onClick={() => void run([r], "restore")}
                          >
                            <IconRewind />
                          </button>
                        )}
                        <button
                          className="icon-btn"
                          data-tip="Move to the trash bin"
                          onClick={() => void run([r], "bin")}
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

        {binning && (
          <Confirm
            title={`Move ${binning.length} ${binning.length === 1 ? "item" : "items"} to the trash bin? You can restore them from there.`}
            onCancel={() => setBinning(null)}
            onConfirm={() => {
              const list = binning;
              setBinning(null);
              void run(list, "bin");
            }}
          />
        )}
      </div>
    </Sheet>
  );
}
