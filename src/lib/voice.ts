/**
 * Speaking replies aloud, and letting a reply open part of the app.
 *
 * Two voices. The machine's own is the default and the fallback: it needs no
 * download and it uses whatever voice and rate is already configured, which for
 * anyone who relies on speech is usually what they have already tuned. The
 * downloaded one sounds better and is synthesised in the backend.
 */

import { speakNeural } from "./settings";

export type OpenTarget = "map" | "ideas" | "conversations";

/** Where a reply asked the app to go, and the reply with the marker removed. */
export interface Parsed {
  open: OpenTarget | null;
  text: string;
}

const MARKER = /^\s*\[\[open:(map|ideas|conversations)\]\]\s*/i;

/**
 * Pull a navigation marker off the front of a reply.
 *
 * The marker is stripped before anything is displayed or archived, so the
 * transcript keeps what was actually said and not the app's own plumbing.
 */
export function parseReply(text: string): Parsed {
  const m = text.match(MARKER);
  if (!m) return { open: null, text };
  return { open: m[1].toLowerCase() as OpenTarget, text: text.slice(m[0].length) };
}

/** Strip markdown that has no spoken equivalent, so it isn't read out. */
function forSpeech(text: string): string {
  return text
    .replace(MARKER, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

let current: SpeechSynthesisUtterance | null = null;

/**
 * Read a reply out. Any reply already being spoken is cut off first.
 *
 * The downloaded voice falls back to the system one on any failure — a missing
 * voice file or no audio device should cost the neural quality, not the
 * speech.
 */
export function speak(text: string, neural = false): void {
  const said = forSpeech(text);
  if (!said) return;
  stopSpeaking();
  if (neural) {
    void speakNeural(said).catch(() => system(said));
    return;
  }
  system(said);
}

function system(said: string): void {
  const synth = window.speechSynthesis;
  if (!synth) return;
  current = new SpeechSynthesisUtterance(said);
  current.onend = () => {
    current = null;
  };
  synth.speak(current);
}

export function stopSpeaking(): void {
  window.speechSynthesis?.cancel();
  current = null;
}

/** Whether this machine can speak at all — the setting is hidden if not. */
export function canSpeak(): boolean {
  return typeof window !== "undefined" && !!window.speechSynthesis;
}
