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

/** One markdown note in an Obsidian vault, as an import. */
export interface ObsidianNote {
  path: string;
  title: string;
  modified: string;
  chars: number;
}

export function listObsidianNotes(path: string): Promise<ObsidianNote[]> {
  return invoke<ObsidianNote[]>("list_obsidian_notes", { path });
}

export function importObsidianNote(path: string, source: string): Promise<number> {
  return invoke<number>("import_obsidian_note", { path, source });
}

/** One conversation Claude has already had on this machine. */
export interface ClaudeImport {
  path: string;
  project: string;
  modified: string;
  turns: number;
  first: string;
  title: string | null;
}

export function listClaudeImports(): Promise<ClaudeImport[]> {
  return invoke<ClaudeImport[]>("list_claude_imports");
}

export function importClaudeConversation(path: string, source: string): Promise<number> {
  return invoke<number>("import_claude_conversation", { path, source });
}
