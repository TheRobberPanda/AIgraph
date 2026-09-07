/**
 * Making something out of a folder's conversations.
 *
 * The other side of the app: everything else reads the transcripts down into
 * ideas, and this hands them across to a model whole, to be turned into
 * whatever was asked for. Nothing here is written back into the record — see
 * the note on the Rust module for why.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** What actually fitted into the context, so the screen can say so. */
export interface Packed {
  conversations: number;
  /** Left out entirely, oldest first, because the budget ran out. */
  dropped: number;
  /** Replies shortened to their first part. */
  shortened: number;
  characters: number;
}

/** Load a folder's conversations as context. Cheap; no model involved. */
export function composeLoad(folder: number | null): Promise<Packed> {
  return invoke<Packed>("compose_load", { folder });
}

/** Throw away the exchange, keeping the loaded folder. */
export function composeClear(): Promise<void> {
  return invoke("compose_clear");
}

/** Ask for something. Resolves with the whole answer; tokens arrive on the way. */
export function composeSend(instruction: string): Promise<string> {
  return invoke<string>("compose_send", { instruction });
}

export function onComposeToken(cb: (text: string) => void): Promise<UnlistenFn> {
  return listen<{ text: string }>("compose:token", (e) => cb(e.payload.text));
}

/** Write an answer out. Whatever it is, it is text. */
export function saveText(path: string, text: string): Promise<string> {
  return invoke<string>("save_text", { path, text });
}
