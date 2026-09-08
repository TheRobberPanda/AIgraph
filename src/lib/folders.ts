import { invoke } from "@tauri-apps/api/core";

/** Root always exists and cannot be removed — unsorted thinking lands here. */
export const ROOT_FOLDER = 1;

export interface Folder {
  id: number;
  name: string;
  /** How many conversations are filed here. */
  session_count: number;
  /** What this folder is thought in. `""` follows the global setting — a
   *  folder is where one line of thinking lives, and one person's lines are
   *  not all in the same language. */
  language: string;
}

/** A folder's colour and mark, from its name — same trick the subjects use,
 *  so a folder looks the same everywhere without storing anything extra. */
const FOLDER_COLORS = [
  "#e08659", "#7ead6f", "#9fb8d4", "#dba53f",
  "#c9899f", "#8fbfae", "#a396c4", "#c98d6b",
];
const FOLDER_MARKS = ["◆", "●", "▲", "■", "★", "✦", "◇", "▬"];

function hash(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function folderColor(name: string): string {
  return FOLDER_COLORS[hash(name) % FOLDER_COLORS.length];
}

export function folderMark(name: string): string {
  return FOLDER_MARKS[hash(name) % FOLDER_MARKS.length];
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
/** Say which language a folder is thought in. `""` follows the setting. */
export function setFolderLanguage(folderId: number, language: string): Promise<void> {
  return invoke("set_folder_language", { folderId, language });
}

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
