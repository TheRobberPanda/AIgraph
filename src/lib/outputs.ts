/**
 * What a folder has been made into, and the editing that follows.
 *
 * A Make answer is not a chat reply — it is a document. These are the calls
 * that keep it as one: filed the moment the model stops writing, listed on
 * the outputs page with the conversations it came from, revisable by hand or
 * by instruction.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ExportedFile } from "./compose";

export interface MakeOutputSource {
  session_id: number;
  title: string;
  /** active | archived | trashed | missing — what has become of the
   *  conversation since this output was made from it. */
  status: "active" | "archived" | "trashed" | "missing";
  /** The bin entry to restore, when the conversation is in the trash. */
  trash_id: number | null;
}

export interface MakeOutput {
  id: number;
  folder_id: number;
  title: string;
  /** Cut from the top of the text, not written about it. */
  summary: string;
  content: string;
  format: string;
  prompt: string;
  sessions: MakeOutputSource[];
  /** Put out of the way without being thrown away. */
  archived: boolean;
  created_at: string;
  updated_at: string;
}

/** File a finished Make reply as an output, and get it back. */
export function composeSaveOutput(
  content: string,
  format: string,
  prompt: string,
  folder: number | null,
  sessions: number[],
): Promise<MakeOutput> {
  return invoke<MakeOutput>("compose_save_output", {
    content,
    format,
    prompt,
    folder,
    sessions,
  });
}

/** Everything a folder has been made into. Null folder is all of them. */
export function listMakeOutputs(folder: number | null): Promise<MakeOutput[]> {
  return invoke<MakeOutput[]>("make_outputs", { folder });
}

export function getMakeOutput(id: number): Promise<MakeOutput> {
  return invoke<MakeOutput>("make_output", { id });
}

/** Write the text back after editing it by hand. */
export function updateMakeOutput(
  id: number,
  content: string,
  title?: string,
): Promise<void> {
  return invoke("update_make_output", { id, content, title: title ?? null });
}

/** Run one export command the model asked for, by hand, from a file's chat. */
export function exportComposed(
  content: string,
  format: string,
  name: string,
): Promise<ExportedFile> {
  return invoke<ExportedFile>("export_composed", { content, format, name });
}

export function deleteMakeOutput(id: number): Promise<void> {
  return invoke("delete_make_output", { id });
}

/** Put an output out of the way, or bring it back. */
export function setMakeOutputArchived(id: number, archived: boolean): Promise<void> {
  return invoke("set_make_output_archived", { id, archived });
}

/** What a revision came back with: the document, and any files it exported. */
export interface ReviseResult {
  output: MakeOutput;
  exports: ExportedFile[];
  /** Why an export the model asked for did not land, if it did not. */
  export_error: string | null;
}

/**
 * Ask for a revision. The thread is kept per output on the far side, so each
 * instruction builds on the one before. Resolves with the revised output, and
 * any files the revision asked to be written out.
 */
export function reviseMakeOutput(id: number, instruction: string): Promise<ReviseResult> {
  return invoke<ReviseResult>("compose_revise_output", { id, instruction });
}

/** Forget the revision thread but keep the document. */
export function clearOutputThread(id: number): Promise<void> {
  return invoke("clear_output_thread", { id });
}
