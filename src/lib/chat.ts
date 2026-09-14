import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Role = "user" | "assistant";
export type LocalKind =
  | "ollama"
  | "lmstudio"
  | "embedded"
  | "anthropic"
  | "claudecli"
  | "openrouter";

export interface Turn {
  role: Role;
  content: string;
  /** How long the reply took, on replies written in this window. */
  timing?: ReplyTiming;
}

/** Where the time went for one reply — see `ReplyTiming` in commands.rs. */
export interface ReplyTiming {
  recall_ms: number | null;
  recall_titles: number;
  recall_considered: number;
  recall_ranked: boolean;
  system_chars: number;
  first_token_ms: number | null;
  first_content_ms: number | null;
  total_ms: number;
  reply_chars: number;
}

function secs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** One line for under a reply. */
export function timingLine(t: ReplyTiming): string {
  const parts: string[] = [];
  if (t.recall_ms !== null) {
    const of = t.recall_considered > t.recall_titles ? ` of ${t.recall_considered}` : "";
    const how = t.recall_ranked ? ", by relevance" : "";
    parts.push(`recall ${secs(t.recall_ms)} (${t.recall_titles}${of} titles${how})`);
  } else if (t.recall_titles > 0) {
    parts.push(`${t.recall_titles} recall titles`);
  }
  // Roughly four characters a token — near enough to see what a prompt costs.
  parts.push(`prompt ~${Math.round(t.system_chars / 4)} tok`);
  if (t.first_token_ms !== null) parts.push(`first token ${secs(t.first_token_ms)}`);
  if (t.first_content_ms !== null && t.first_token_ms !== null && t.first_content_ms > t.first_token_ms) {
    parts.push(`thinking ${secs(t.first_content_ms - t.first_token_ms)}`);
  }
  const writingFrom = (t.recall_ms ?? 0) + (t.first_content_ms ?? t.first_token_ms ?? 0);
  const writing = Math.max(0, t.total_ms - writingFrom);
  if (t.first_content_ms !== null) {
    const rate = writing > 0 ? ` · ~${Math.round(t.reply_chars / 4 / (writing / 1000))} tok/s` : "";
    parts.push(`writing ${secs(writing)}${rate}`);
  }
  parts.push(`total ${secs(t.total_ms)}`);
  return parts.join(" · ");
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
): Promise<{ reply: string; timing: ReplyTiming }> {
  const unlisten: UnlistenFn[] = [
    await listen<{ text: string }>("chat:token", (e) => onContent(e.payload.text)),
    await listen<{ text: string }>("chat:reasoning", (e) => onReasoning(e.payload.text)),
  ];
  try {
    return await invoke<{ reply: string; timing: ReplyTiming }>("send_message", { text });
  } finally {
    // Leaking these would cross-wire the next message's tokens into this turn.
    unlisten.forEach((u) => u());
  }
}

/**
 * Whether a failure is the model refusing to answer with reasoning off.
 *
 * Some models behind OpenRouter cannot think less than they do — "Reasoning is
 * mandatory for this endpoint and cannot be disabled." The fix is one setting,
 * so the error offers it rather than sending anyone to find it.
 */
export const REASONING_REFUSED =
  "This model will not answer with reasoning switched off.";

export function wantsReasoning(error: string): boolean {
  return (
    /reasoning/i.test(error) &&
    /mandatory|cannot be disabled|must be enabled|is required|required for this/i.test(error)
  );
}

/** Keep what is typed and not yet sent, on disk. */
export function saveDraft(text: string): Promise<void> {
  return invoke("save_draft", { text });
}

export function loadDraft(): Promise<string> {
  return invoke<string>("load_draft");
}

/** A conversation the last run left unfiled and this launch filed, if any. */
export function recoveredSession(): Promise<number | null> {
  return invoke<number | null>("recovered_session");
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
