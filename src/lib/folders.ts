import { invoke } from "@tauri-apps/api/core";

/** Root always exists and cannot be removed — unsorted thinking lands here. */
export const ROOT_FOLDER = 1;

export interface Folder {
  id: number;
  name: string;
  /** How many conversations are filed here. */
  session_count: number;
}

export function listFolders(): Promise<Folder[]> {
  return invoke<Folder[]>("folders");
}

export function createFolder(name: string): Promise<number> {
  return invoke<number>("create_folder", { name });
}

export function renameFolder(folderId: number, name: string): Promise<void> {
  return invoke("rename_folder", { folderId, name });
}

/** Remove a folder. Whatever was filed in it goes back to Root. */
export function deleteFolder(folderId: number): Promise<void> {
  return invoke("delete_folder", { folderId });
}

/** Which folder the conversation being had now will be filed into. */
export function currentFolder(): Promise<number> {
  return invoke<number>("current_folder");
}

export function setCurrentFolder(folderId: number): Promise<void> {
  return invoke("set_current_folder", { folderId });
}

/** Move a conversation, and the ideas it produced, to another folder. */
export function moveSession(sessionId: number, folderId: number): Promise<void> {
  return invoke("move_session", { sessionId, folderId });
}
