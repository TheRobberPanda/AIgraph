import { useEffect, useState } from "react";
import { listFolders, moveSession, type Folder } from "../lib/folders";

/**
 * Pick a folder to move a conversation into.
 *
 * A dialog rather than entries on the context menu: one entry per folder makes
 * a menu taller than the window once there are more than a handful, and there
 * is nowhere to search.
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

  useEffect(() => {
    void listFolders().then(setFolders);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = folders.filter((f) =>
    f.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal folder-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="section">Move this conversation to</h2>
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
              <button
                className="folder-row"
                onClick={() => {
                  void moveSession(sessionId, f.id).then(() => {
                    onDone();
                    onClose();
                  });
                }}
              >
                <span className="folder-name">{f.name}</span>
                <span className="row-meta">
                  {f.session_count} {f.session_count === 1 ? "conversation" : "conversations"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
