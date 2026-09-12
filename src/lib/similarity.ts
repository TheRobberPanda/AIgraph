/**
 * Finding thinking that was repeated.
 *
 * A light lexical reading, not a semantic one: two claims that use largely the
 * same words are almost certainly the same claim said twice, and that is the
 * case worth pointing at. It deliberately over-matches rather than under: the
 * notice is a nudge ("you likely repeated this"), not a verdict, and a nudge
 * that is wrong costs one click while a miss leaves the repetition hidden.
 */

const STOP = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "had",
  "are", "was", "were", "not", "but", "you", "your", "they", "them", "their",
  "its", "it's", "into", "over", "than", "then", "when", "what", "which",
  "who", "whom", "will", "would", "could", "should", "can", "cant", "can't",
  "about", "there", "here", "just", "like", "also", "more", "most", "some",
  "any", "all", "one", "two", "get", "got", "make", "made", "because", "been",
  "being", "does", "did", "doing", "how", "why", "where", "out", "our",
]);

/** The words that carry meaning, lowercased and de-punctuated. */
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    const word = raw.replace(/^'+|'+$/g, "");
    if (word.length < 4 || STOP.has(word)) continue;
    out.add(word);
  }
  return out;
}

/** How alike two pieces of text are, from 0 to 1. */
export function textSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const jaccard = shared / (ta.size + tb.size - shared);
  // Containment, so a short idea fully said inside a longer one still counts.
  const contain = shared / Math.min(ta.size, tb.size);
  return Math.max(jaccard, contain * 0.88);
}

/**
 * The most similar item to each one, when it is similar enough to mention.
 *
 * Returns a map from an item's id to the id of its closest match. Every pair
 * is considered once, so the answer is symmetric where it matters and an item
 * with no close neighbour is simply absent.
 */
export function repeatedAmong<T>(
  items: T[],
  idOf: (item: T) => number,
  textOf: (item: T) => string,
  floor = 0.6,
): Map<number, number> {
  const matches = new Map<number, number>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (textSimilarity(textOf(items[i]), textOf(items[j])) < floor) continue;
      const a = idOf(items[i]);
      const b = idOf(items[j]);
      if (!matches.has(a)) matches.set(a, b);
      if (!matches.has(b)) matches.set(b, a);
    }
  }
  return matches;
}
