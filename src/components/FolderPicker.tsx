import { useEffect, useState } from "react";
import { onEscapeLayer } from "../lib/escape";
import {
  createFolder,
  deleteFolder,
  folderColor,
  listFolders,
  mergeFolders,
  ROOT_FOLDER,
  type Folder,
} from "../lib/folders";
import FolderMark from "./FolderMark";
import { reextractAll } from "../lib/settings";

/**
 * Choose where this stretch of thinking gets filed, or start a new folder.
 *
 * Opened from the composer, because the decision belongs at the moment of
 * talking rather than in a settings screen visited afterwards.
 */
export default function FolderPicker({
  current,
  onPick,
  onClose,
}: {
  current: number;
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Deleting takes two clicks: the first arms it, the second does it. A
   *  folder is easy to hit by accident and there is no undo. */
  const [arming, setArming] = useState<number | null>(null);
  /**
   * Re-reading a folder, armed the same way deleting is.
   *
   * Here rather than in Settings because this is where folders are, and it is
   * the only screen that lists all of them — the point being to re-read *a*
   * folder, not just the one you happen to be in. Deliberately quiet: it can
   * take a very long time and it is almost never the answer.
   */
  const [rereading, setRereading] = useState<number | null>(null);
  /** The folder being merged into another, so the target can be chosen. */
  const [merging, setMerging] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = () => listFolders().then(setFolders).catch((e) => setError(String(e)));

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => onEscapeLayer(onClose), [onClose]);

  async function doMerge(from: number, into: number) {
    setMerging(null);
    try {
      await mergeFolders(from, into);
      await refresh();
      // Standing in the folder that just went away: follow its contents.
      if (current === from) onPick(into);
    } catch (err) {
      setError(String(err));
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const id = await createFolder(trimmed);
      setName("");
      await refresh();
      onPick(id);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal folder-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="section">File this conversation in</h2>

        {error && <p className="error">{error}</p>}

        <ul className="folder-list">
          {folders.map((f) => (
            <li key={f.id}>
              <button
                className={
                  f.id === current ? "folder-row on" : "folder-row"
                }
                style={{ "--folder-color": folderColor(f.name) } as React.CSSProperties}
                onClick={() => {
                  onPick(f.id);
                  onClose();
                }}
              >
                <FolderMark name={f.name} id={f.id} />
                <span className="folder-name">{f.name}</span>
                <span className="row-meta">
                  {f.session_count} {f.session_count === 1 ? "conversation" : "conversations"}
                </span>
              </button>
              {rereading === f.id ? (
                <button
                  className="btn folder-remove armed"
                  onClick={() => {
                    setRereading(null);
                    reextractAll(f.id)
                      .then((n) =>
                        setNote(`Re-reading ${n} conversation${n === 1 ? "" : "s"} in ${f.name}.`),
                      )
                      .catch((e) => setError(String(e)));
                  }}
                  onMouseLeave={() => setRereading(null)}
                >
                  Re-read
                </button>
              ) : (
                <button
                  className="icon-btn folder-remove"
                  data-tip={`Read ${f.name} again from scratch — slow, and rarely needed`}
                  onClick={() => setRereading(f.id)}
                >
                  ↻
                </button>
              )}
              {f.id !== ROOT_FOLDER && (
                <button
                  className="icon-btn folder-remove"
                  data-tip={`Merge ${f.name} into another folder — nothing is deleted`}
                  onClick={() => setMerging((m) => (m === f.id ? null : f.id))}
                >
                  ⇄
                </button>
              )}
              {f.id !== ROOT_FOLDER &&
                (arming === f.id ? (
                  <button
                    className="btn folder-remove armed"
                    onClick={() => {
                      setArming(null);
                      void deleteFolder(f.id).then(refresh).catch((e) => setError(String(e)));
                    }}
                    onMouseLeave={() => setArming(null)}
                  >
                    Delete
                  </button>
                ) : (
                  <button
                    className="icon-btn folder-remove"
                    data-tip="Delete folder — its conversations go back to Root"
                    onClick={() => setArming(f.id)}
                  >
                    ×
                  </button>
                ))}
              {merging === f.id && (
                <div className="merge-targets">
                  <span className="row-meta">Merge {f.name} into</span>
                  {folders
                    .filter((t) => t.id !== f.id)
                    .map((t) => (
                      <button
                        key={t.id}
                        className="btn"
                        onClick={() => void doMerge(f.id, t.id)}
                      >
                        {t.name}
                      </button>
                    ))}
                  <button className="btn subtle" onClick={() => setMerging(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {note && <p className="blurb">{note}</p>}

        <form className="row folder-new" onSubmit={add}>
          <input
            className="field"
            placeholder="New folder"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!name.trim()}>
            Create
          </button>
        </form>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
