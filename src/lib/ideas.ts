import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Evidence {
  id: number;
  session_id: number;
  turn_id: number;
  quote: string;
  start_byte: number;
  end_byte: number;
  /** Found via the normalized fallback rather than an exact match. */
  normalized: boolean;
  /** The quote appears more than once; the first occurrence was taken. */
  ambiguous: boolean;
}

export interface Idea {
  id: number;
  claim: string;
  /** A short, glanceable name, written from context rather than sliced from the claim. */
  title: string;
  /** What the idea is about — coloured the same way on the map and in lists. */
  category: string;
  evidence: Evidence[];
  strong: string[];
  weak: string[];
}

export interface Diagnostics {
  ideas: number;
  rejected: number;
  drop_rate: number;
  normalized: number;
  sessions_extracted: number;
  sessions_pending: number;
  by_reason: [string, number][];
}

/** Ideas from conversations in one folder, or every folder when null. */
export function listIdeas(folder?: number | null): Promise<Idea[]> {
  return invoke<Idea[]>("ideas", { folder: folder ?? null });
}

export function getDiagnostics(): Promise<Diagnostics> {
  return invoke<Diagnostics>("diagnostics");
}

export function extractSession(sessionId: number): Promise<number> {
  return invoke<number>("extract_session", { sessionId });
}

/** Fires when extraction finishes and the idea set has changed. */
export function onIdeasChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("ideas:changed", () => cb());
}

export type Phase = "asking" | "verifying" | "retrying" | "saving";

export interface RunningExtraction {
  session_id: number;
  phase: Phase;
  /** RFC3339. Elapsed time is derived from this so the display keeps counting. */
  started_at: string;
  /** Which of the queued conversations this is, and how many there were. */
  index: number;
  total: number;
  /** Characters of reply back from the model so far, and how long since the
   *  last of them arrived. Only a streamed read reports these. */
  received: number;
  quiet_ms: number | null;
}

export interface LastExtraction {
  session_id: number;
  ideas: number;
  dropped: number;
  drop_rate: number;
  seconds: number;
  retried: boolean;
  /** What the model measured itself doing, summed over every pass. */
  cost: {
    calls: number;
    read_tokens: number;
    read_ms: number;
    wrote_tokens: number;
    wrote_ms: number;
  };
  read_per_second: number | null;
  wrote_per_second: number | null;
  error: string | null;
}

export interface ExtractionProgress {
  running: RunningExtraction | null;
  last: LastExtraction | null;
  pending: number;
  /** A stop was asked for and has not happened yet. Reading stops between
   *  conversations, never inside one, so there is a wait worth explaining. */
  stopping: boolean;
}

export function extractionProgress(): Promise<ExtractionProgress> {
  return invoke<ExtractionProgress>("extraction_progress");
}

/** Start extraction now. Resolves false if a run is already in flight. */
export function extractNow(): Promise<boolean> {
  return invoke<boolean>("extract_now");
}

export function onExtractionProgress(
  cb: (p: ExtractionProgress) => void,
): Promise<UnlistenFn> {
  return listen<ExtractionProgress>("extraction:progress", (e) => cb(e.payload));
}

export interface SourceView {
  session_id: number;
  started_at: string;
  before: string;
  highlight: string;
  after: string;
}

/**
 * The archived conversation, split around one quote.
 *
 * The split happens in Rust: its offsets are UTF-8 byte positions, while JS
 * strings index UTF-16 code units. Slicing here instead would highlight the
 * wrong text as soon as a transcript contains an emoji or an accent.
 */
export function sourceView(evidenceId: number): Promise<SourceView> {
  return invoke<SourceView>("source_view", { evidenceId });
}

/** Throw away one conversation's ideas and read it again. */
export function reextractSession(sessionId: number): Promise<unknown> {
  return invoke("reextract_session", { sessionId });
}


/** The conversations waiting to be read, in the order they will be. */
export function pendingSessions(): Promise<import("./chat").SessionSummary[]> {
  return invoke("pending_sessions");
}


/** Ask a running digest to stop after the conversation it is on. */
export function stopDigest(): Promise<void> {
  return invoke("stop_digest");
}


/**
 * Settle a contradiction: it stops being drawn and stops being brought up.
 *
 * Kept on record rather than deleted — the pair really was judged
 * incompatible, and without the record it would simply be drawn again.
 */
export function resolveRelation(relationId: number): Promise<void> {
  return invoke("resolve_relation", { relationId });
}

/** Reword an idea by hand. Kept as a revision, so it can be reverted. */
export function editIdea(ideaId: number, claim: string): Promise<void> {
  return invoke("edit_idea", { ideaId, claim });
}

/** Remove one recorded idea and everything supporting it. */
export function deleteIdea(ideaId: number): Promise<void> {
  return invoke("delete_idea", { ideaId });
}

/** What one of these turns a folder into. */
export type BookFormat = "pdf" | "markdown";

export interface BookWritten {
  path: string;
  ideas: number;
  chapters: number;
  /** Set when the book came out missing something worth mentioning. */
  note: string | null;
}

/**
 * Set this folder's ideas as a book and write it to `path`.
 *
 * The folder is what decides the book — the same scope the map and the ideas
 * list already use — so there is nothing to choose but the shape and where it
 * goes.
 */
export function exportBook(
  folder: number | null,
  path: string,
  format: BookFormat,
): Promise<BookWritten> {
  return invoke<BookWritten>("export_book", { folder, path, format });
}

/** A conversation that could not be read, and why. */
export interface Stalled {
  session_id: number;
  title: string;
  error: string;
  state: string;
  /** How long until it is tried again, when a backoff is running. */
  retry_in_minutes: number | null;
  attempts: number;
}

/**
 * Why nothing is happening, when nothing appears to be happening.
 *
 * A digest that has quietly stopped and a digest with nothing to do look the
 * same from outside; this is the difference.
 */
export function extractionTrouble(): Promise<Stalled[]> {
  return invoke<Stalled[]>("extraction_trouble");
}

/**
 * How a read in flight is going, in a few words.
 *
 * Elapsed time alone cannot tell a working read from a hung one — it counts up
 * at the same rate either way. What has actually come back can, so that is
 * what this says when there is anything to say.
 */
export function pace(r: RunningExtraction): string | null {
  if (r.received === 0) return null;
  const back =
    r.received < 1000 ? `${r.received} back` : `${(r.received / 1000).toFixed(1)}k back`;
  // Several seconds of nothing after something is worth naming. Below that it
  // is just the gap between frames, and saying so every time would be noise.
  if (r.quiet_ms !== null && r.quiet_ms > 4000) {
    return `${back}, quiet ${Math.round(r.quiet_ms / 1000)}s`;
  }
  return back;
}
