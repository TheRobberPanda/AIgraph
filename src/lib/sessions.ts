import { invoke } from "@tauri-apps/api/core";

export interface StoredTurn {
  id: number;
  ord: number;
  role: "user" | "assistant";
  text: string;
  start_byte: number;
  end_byte: number;
}

export function sessionTurns(sessionId: number): Promise<StoredTurn[]> {
  return invoke<StoredTurn[]>("session_turns", { sessionId });
}
