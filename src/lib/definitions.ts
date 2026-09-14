import { invoke } from "@tauri-apps/api/core";

/**
 * Something the person said a word means, found when a conversation is read.
 *
 * Their meaning, not a dictionary's — "by discipline I mean doing it on the
 * days you don't want to" — with the exact words it was said in, checked
 * against the transcript the same way an idea's quote is.
 */
export interface Definition {
  id: number;
  term: string;
  definition: string;
  quote: string;
  session_id: number;
  started_at: string;
  session_title: string;
}

/** Definitions in one folder, or every folder when null. */
export function listDefinitions(folder?: number | null): Promise<Definition[]> {
  return invoke<Definition[]>("definitions", { folder: folder ?? null });
}

/** Take one off the list. Kept in the database, so a re-read does not bring it back. */
export function removeDefinition(definitionId: number): Promise<void> {
  return invoke("remove_definition", { definitionId });
}

/** Reword a term or what it means. Kept as written through a re-read. */
export function editDefinition(definitionId: number, term: string, definition: string): Promise<void> {
  return invoke("edit_definition", { definitionId, term, definition });
}
