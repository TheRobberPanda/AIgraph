import { useEffect, useState } from "react";
import {
  createFolder,
  deleteFolder,
  folderColor,
  listFolders,
  moveSession,
  ROOT_FOLDER,
  type Folder,
} from "../lib/folders";
import FolderMark from "./FolderMark";

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
  const [dropOn, setDropOn] = useState<number | null>(null);
  /** Deleting takes two clicks: the first arms it, the second does it. A
   *  folder is easy to hit by accident and there is no undo. */
  const [arming, setArming] = useState<number | null>(null);

  const refresh = () => listFolders().then(setFolders).catch((e) => setError(String(e)));

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
                  (f.id === current ? "folder-row on" : "folder-row") +
                  (dropOn === f.id ? " drop" : "")
                }
                style={{ "--folder-color": folderColor(f.name) } as React.CSSProperties}
                onClick={() => {
                  onPick(f.id);
                  onClose();
                }}
                // Conversations can be dragged here from the list.
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropOn(f.id);
                }}
                onDragLeave={() => setDropOn((d) => (d === f.id ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropOn(null);
                  const id = Number(e.dataTransfer.getData("text/session"));
                  if (Number.isFinite(id) && id > 0) void moveSession(id, f.id).then(refresh);
                }}
              >
                <FolderMark name={f.name} id={f.id} />
                <span className="folder-name">{f.name}</span>
                <span className="row-meta">
                  {f.session_count} {f.session_count === 1 ? "conversation" : "conversations"}
                </span>
              </button>
              {f.id !== ROOT_FOLDER &&
                (arming === f.id ? (
                  <button
                    className="btn folder-remove armed"
                    onClick={() => {
                      setArming(null);
                      void deleteFolder(f.id).then(refresh);
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
            </li>
          ))}
        </ul>

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
