/**
 * Something to read while a local model thinks.
 *
 * A 12B model on a half-offloaded GPU can take a while, and a static spinner
 * makes that feel broken. These rotate slowly.
 *
 * They stay light because they appear during *your* thinking, not the app's
 * results — but this app is used to think about whatever is on your mind, which
 * is sometimes grief or a diagnosis. So nothing here comments on what you said,
 * makes a joke about thinking hard, or implies the machine is impressed,
 * amused, or concerned. They describe the machine, not you.
 */
const THINKING = [
  "warming up the silicon",
  "consulting the weights",
  "arranging tokens in a line",
  "shuffling probabilities",
  "the GPU is doing its best",
  "assembling a sentence",
  "picking words out of a hat",
  "loading opinions",
];

const DIGESTING = [
  "reading it back",
  "sifting for ideas",
  "underlining the good bits",
  "checking the quotes are real",
  "filing things away",
  "comparing with what you said before",
];

function rotate(pool: string[], seed: number): string {
  return pool[seed % pool.length];
}

export function thinkingMessage(tick: number): string {
  return rotate(THINKING, tick);
}

export function digestingMessage(tick: number): string {
  return rotate(DIGESTING, tick);
}
