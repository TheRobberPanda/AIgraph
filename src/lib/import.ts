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

/**
 * Learning mode: read a document as an output and turn it back into ideas.
 *
 * The document is imported as a conversation, filed like any other import —
 * it waits in the queue until the reading is asked for. Returns the session id.
 */
export function learnDocument(path: string): Promise<number> {
  return invoke<number>("learn_document", { path });
}

/**
 * Whether a conversation is an import rather than something that was lived.
 *
 * Imports carry their kind in the session's `model` label — `imported/…` for
 * pasted transcripts, Claude logs and Obsidian notes, `learned/…` for
 * documents read back. They read as documents, so the rail marks them and
 * opening one previews the document instead of a transcript.
 */
export function isImportConversation(model: string | null | undefined): boolean {
  return !!model && (model.startsWith("imported") || model.startsWith("learned"));
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
