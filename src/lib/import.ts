import { invoke } from "@tauri-apps/api/core";

export type Basis = "recognised" | "length_heuristic" | "unlabelled";

export interface ImportedTurn {
  role: "user" | "assistant";
  text: string;
  label: string;
}

export interface Import {
  turns: ImportedTurn[];
  labels: string[];
  basis: Basis;
}

export function previewImport(text: string): Promise<Import> {
  return invoke<Import>("preview_import", { text });
}

export function importConversation(
  text: string,
  swapRoles: boolean,
  source: string,
): Promise<number> {
  return invoke<number>("import_conversation", { text, swapRoles, source });
}
