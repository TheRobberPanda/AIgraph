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

export function listIdeas(): Promise<Idea[]> {
  return invoke<Idea[]>("ideas");
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
}

export interface LastExtraction {
  session_id: number;
  ideas: number;
  dropped: number;
  drop_rate: number;
  seconds: number;
  retried: boolean;
  error: string | null;
}

export interface ExtractionProgress {
  running: RunningExtraction | null;
  last: LastExtraction | null;
  pending: number;
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
