import { useEffect, useState } from "react";
import { createFolder, listFolders, moveSession, type Folder } from "../lib/folders";

/**
 * Pick a folder to move a conversation into.
 *
 * A dialog rather than entries on the context menu: one entry per folder makes
 * a menu taller than the window once there are more than a handful, and there
 * is nowhere to search.
 *
 * A new folder can be made from here too, so separating a conversation out
 * does not mean backing out, making the folder, and starting the move again.
 */
export default function MoveTo({
  sessionId,
  onDone,
  onClose,
}: {
  sessionId: number;
  onDone: () => void;
  onClose: () => void;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listFolders().then(setFolders);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function moveTo(folderId: number) {
    void moveSession(sessionId, folderId)
      .then(() => {
        onDone();
        onClose();
      })
      .catch((e) => setError(String(e)));
  }

  async function createAndMove(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const id = await createFolder(name);
      moveTo(id);
    } catch (err) {
      setError(String(err));
    }
  }

  const shown = folders.filter((f) =>
    f.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal folder-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="section">Move this conversation to</h2>
        {error && <p className="error">{error}</p>}
        {folders.length > 6 && (
          <input
            className="field"
            autoFocus
            placeholder="Find a folder"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <ul className="folder-list">
          {shown.map((f) => (
            <li key={f.id}>
              <button className="folder-row" onClick={() => moveTo(f.id)}>
                <span className="folder-name">{f.name}</span>
                <span className="row-meta">
                  {f.session_count} {f.session_count === 1 ? "conversation" : "conversations"}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {/* Separate it into somewhere new without leaving this dialog. */}
        <form className="row folder-new" onSubmit={createAndMove}>
          <input
            className="field"
            placeholder="New folder"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!newName.trim()}>
            Create and move
          </button>
        </form>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
