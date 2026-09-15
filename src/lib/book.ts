/**
 * The book writer (beta): a folder's ideas, written up as a book in the
 * person's own voice.
 *
 * An outline first, which the person edits, then one chapter per call — so no
 * single reply has to hold the whole book. Each chapter is handed the outline,
 * short summaries of the chapters before it, the ideas and quotes that recall
 * finds for it, and samples of how the person actually talks.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface BookChapter {
  title: string;
  /** What the chapter argues — the outline's line for it. */
  plan: string;
  /** Ideas the outline gave it. */
  ideas: number[];
  /** The written chapter, markdown. Empty until written. */
  text: string;
  /** Written after the chapter, and what later chapters are given of it. */
  summary: string;
  /** Ideas the chapter actually made use of. */
  used: number[];
}

export interface BookProject {
  title: string;
  /** What the person wants the book to be, in their words. */
  brief: string;
  language: string;
  chapters: BookChapter[];
}

/** Something the final check found: a chapter that drifted from its plan. */
export interface BookNote {
  chapter: number;
  note: string;
}

export function bookProject(folder: number | null): Promise<BookProject> {
  return invoke<BookProject>("book_project", { folder });
}

export function bookSave(folder: number | null, project: BookProject): Promise<void> {
  return invoke("book_save", { folder, project });
}

export function bookOutline(
  folder: number | null,
  brief: string,
  chapters: number,
): Promise<BookProject> {
  return invoke<BookProject>("book_outline", { folder, brief, chapters });
}

export function bookWriteChapter(folder: number | null, index: number): Promise<BookProject> {
  return invoke<BookProject>("book_write_chapter", { folder, index });
}

export function bookCheck(folder: number | null): Promise<BookNote[]> {
  return invoke<BookNote[]>("book_check", { folder });
}

export function bookExport(folder: number | null, path: string): Promise<void> {
  return invoke("book_export", { folder, path });
}

/** A chapter as it is written, piece by piece. */
export function onBookToken(
  cb: (t: { index: number; text: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ index: number; text: string }>("book:token", (e) => cb(e.payload));
}
