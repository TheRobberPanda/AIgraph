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
 * Sentences waiting to be spoken, and whether one is being spoken now.
 *
 * A reply is generated at twenty-odd tokens a second, so waiting for all of it
 * before saying any of it is several seconds of silence at the exact moment a
 * call feels broken. Spoken a sentence at a time as they arrive, the wait is
 * the first sentence rather than the whole answer — and speech is slower than
 * generation, so after the first one the queue is never the thing you are
 * waiting for.
 */
const queue: string[] = [];
let draining = false;
/** Bumped on stop, so a drain in flight knows it has been cancelled. */
let generation = 0;

/** Split off whatever complete sentences are at the front of a growing text. */
export function takeSentences(buffer: string): { spoken: string[]; rest: string } {
  const spoken: string[] = [];
  let rest = buffer;
  // A sentence ends at .?!… or a newline, followed by space or end. Decimals
  // and abbreviations get through occasionally; the cost of that is a pause in
  // the wrong place, against seconds of silence for the alternative.
  const end = /([.!?\u2026]+["')\]]?\s|\n+)/;
  for (;;) {
    const m = rest.match(end);
    if (!m || m.index === undefined) break;
    const cut = m.index + m[0].length;
    const piece = rest.slice(0, cut).trim();
    rest = rest.slice(cut);
    if (piece) spoken.push(piece);
  }
  return { spoken, rest };
}

/** Say one piece now, or as soon as whatever is being said finishes. */
export function speakNext(text: string, neural = false): void {
  const said = forSpeech(text);
  if (!said) return;
  queue.push(said);
  if (!draining) void drain(neural);
}

async function drain(neural: boolean) {
  draining = true;
  const mine = generation;
  while (queue.length && generation === mine) {
    const next = queue.shift()!;
    try {
      if (neural) await speakNeural(next);
      else await sayWithSystemVoice(next);
    } catch {
      // A voice that fails should not take the rest of the answer with it.
      try {
        await sayWithSystemVoice(next);
      } catch {
        /* nothing left to fall back to */
      }
    }
  }
  draining = false;
}

/** Resolves when the utterance has finished, so the queue paces itself. */
function sayWithSystemVoice(said: string): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve();
    const u = new SpeechSynthesisUtterance(said);
    current = u;
    u.onend = () => {
      if (current === u) current = null;
      resolve();
    };
    u.onerror = () => resolve();
    synth.speak(u);
  });
}

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
  generation += 1;
  queue.length = 0;
  window.speechSynthesis?.cancel();
  current = null;
}

/** Whether this machine can speak at all — the setting is hidden if not. */
export function canSpeak(): boolean {
  return typeof window !== "undefined" && !!window.speechSynthesis;
}
