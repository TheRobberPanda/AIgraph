import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Role = "user" | "assistant";
export type LocalKind = "ollama" | "lmstudio" | "anthropic" | "claudecli";

export interface Turn {
  role: Role;
  content: string;
}

export interface ModelInfo {
  id: string;
  /** null when the server doesn't report load state (Ollama, remote APIs). */
  loaded: boolean | null;
  kind: "chat" | "embedding";
}

export interface Detected {
  kind: LocalKind;
  host: string;
  models: ModelInfo[];
}

export interface Selected {
  kind: LocalKind;
  label: string;
  model: string;
}

export interface Startup {
  servers: Detected[];
  selected: Selected | null;
}

/** Probe for local model servers; auto-selects when there's no real choice. */
export function startup(): Promise<Startup> {
  return invoke<Startup>("startup");
}

export function selectProvider(
  kind: LocalKind,
  host: string,
  model: string,
): Promise<Selected> {
  return invoke<Selected>("select_provider", { kind, host, model });
}

/**
 * Send a message and stream the reply.
 *
 * Reasoning models emit their scratchpad on a separate channel. It's surfaced so
 * the screen isn't frozen while the model thinks, but it is never part of the
 * reply and never reaches the archived transcript.
 */
export async function sendMessage(
  text: string,
  onContent: (chunk: string) => void,
  onReasoning: (chunk: string) => void,
): Promise<string> {
  const unlisten: UnlistenFn[] = [
    await listen<{ text: string }>("chat:token", (e) => onContent(e.payload.text)),
    await listen<{ text: string }>("chat:reasoning", (e) => onReasoning(e.payload.text)),
  ];
  try {
    return await invoke<string>("send_message", { text });
  } finally {
    // Leaking these would cross-wire the next message's tokens into this turn.
    unlisten.forEach((u) => u());
  }
}

/** Remove one turn from the conversation still being had. */
export function deleteTurn(index: number): Promise<void> {
  return invoke("delete_turn", { index });
}

/** Rewind to before a turn, dropping it and everything said after it. */
export function rewindConversation(index: number): Promise<void> {
  return invoke("rewind_conversation", { index });
}

export type EndReason = "done" | "idle" | "app_closing";

export interface Archived {
  session_id: number;
  reason: EndReason;
  turn_count: number;
}

export interface SessionSummary {
  id: number;
  started_at: string;
  ended_at: string | null;
  md_path: string | null;
  model: string;
  extract_state: string;
  turn_count: number;
  idea_count: number;
  tags: string[];
  opening: string;
  title: string;
  archived: boolean;
  folder_id: number;
}

/** Archive the current session and clear the stream. Returns null if nothing was said. */
export function endSession(reason: EndReason = "done"): Promise<Archived | null> {
  return invoke<Archived | null>("end_session", { reason });
}

/** Conversations in one folder, or every folder when null. */
export function listSessions(folder?: number | null): Promise<SessionSummary[]> {
  return invoke<SessionSummary[]>("list_sessions", { folder: folder ?? null });
}

export function renameSession(sessionId: number, title: string): Promise<void> {
  return invoke("rename_session", { sessionId, title });
}

export function setSessionArchived(sessionId: number, archived: boolean): Promise<void> {
  return invoke("set_session_archived", { sessionId, archived });
}

export function deleteSession(sessionId: number): Promise<void> {
  return invoke("delete_session", { sessionId });
}

/** Fires when a session is archived — including by idle timeout, with no user action. */
export function onArchived(cb: (a: Archived) => void): Promise<UnlistenFn> {
  return listen<Archived>("session:archived", (e) => cb(e.payload));
}


/**
 * Pick an archived conversation back up as the live one.
 *
 * Anything currently being said is filed first. Returns how many turns were
 * loaded back in.
 */
export function continueSession(sessionId: number): Promise<number> {
  return invoke<number>("continue_session", { sessionId });
}
