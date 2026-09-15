/**
 * Asking a folder questions.
 *
 * The same material the Make tab hands the model — a folder's conversations,
 * whole — but a question wants an answer to read, not a document to file. So
 * it has its own conversation on the backend, and a Make in progress in one
 * folder is not wiped by a question asked of another.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Packed } from "./compose";

/** Load a folder for asking. `null` is every folder at once. */
export function askLoad(folder: number | null): Promise<Packed> {
  return invoke<Packed>("ask_load", { folder });
}

/** Forget the questions asked so far, keeping the folder loaded. */
export function askClear(): Promise<void> {
  return invoke("ask_clear");
}

/** Ask one question. Resolves with the whole answer; tokens arrive on the way. */
export function askSend(question: string): Promise<string> {
  return invoke<string>("ask_send", { question });
}

export function onAskToken(cb: (text: string) => void): Promise<UnlistenFn> {
  return listen<{ text: string }>("ask:token", (e) => cb(e.payload.text));
}
