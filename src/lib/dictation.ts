import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface SpeechModelStatus {
  installed: boolean;
  download_mb: number;
}

export interface DownloadProgress {
  what: string;
  received: number;
  total: number;
}

export function speechModelStatus(): Promise<SpeechModelStatus> {
  return invoke<SpeechModelStatus>("speech_model_status");
}

export function downloadSpeechModel(): Promise<void> {
  return invoke("download_speech_model");
}

export function startDictation(): Promise<void> {
  return invoke("start_dictation");
}

export function stopDictation(): Promise<void> {
  return invoke("stop_dictation");
}

/**
 * Subscribe to dictation events.
 *
 * Phrases arrive whole, on silence boundaries, rather than word by word —
 * Parakeet isn't a streaming model, and a per-syllable ticker would invite you
 * to watch the text instead of following your own thought.
 */
export async function onDictation(handlers: {
  phrase: (text: string) => void;
  speaking: (on: boolean) => void;
  error: (message: string) => void;
}): Promise<UnlistenFn> {
  const subs = [
    await listen<string>("dictation:phrase", (e) => handlers.phrase(e.payload)),
    await listen<boolean>("dictation:speaking", (e) => handlers.speaking(e.payload)),
    await listen<string>("dictation:error", (e) => handlers.error(e.payload)),
  ];
  return () => subs.forEach((u) => u());
}

export function onDownloadProgress(
  cb: (p: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgress>("speech:download", (e) => cb(e.payload));
}
