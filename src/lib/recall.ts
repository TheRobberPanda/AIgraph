/**
 * Pulling recall markers out of a reply.
 *
 * The model is told to end the one sentence that connects to an earlier idea
 * with `[[recall:N]]`, right after its full stop. The marker never reaches the
 * screen, but the sentence in front of it is turned into an inline highlight
 * the UI can show the idea's source on.
 *
 * Only that sentence. Highlighting the whole paragraph it sat in painted
 * everything around the connection as though all of it rested on the old
 * idea, when usually one sentence did.
 *
 * Models follow the shape loosely: `[[Recall: 3]]`, or the marker alone on
 * the line after its paragraph. Both are accepted.
 */

const MARKER = /\[\[\s*recall\s*:\s*(\d+)\s*\]\]/gi;

/** The scheme the highlight travels under through the markdown renderer. */
export const RECALL_SCHEME = "recall:";

/**
 * Drop a marker still arriving at the very end of a streamed reply, so
 * `[[reca` is not typed out and then snatched away a token later.
 */
function dropPartial(text: string): string {
  let at = text.lastIndexOf("[");
  if (at === -1) return text;
  if (at > 0 && text[at - 1] === "[") at -= 1;
  const tail = text.slice(at).toLowerCase().replace(/\s+/g, "");
  const partial = "[[recall:".startsWith(tail) || /^\[\[recall:\d+\]?$/.test(tail);
  return partial ? text.slice(0, at) : text;
}

/** Where the sentence ending at the end of `body` begins. */
function sentenceStart(body: string): number {
  // From the character before the closing punctuation, back to the previous
  // sentence end or line break.
  for (let j = body.length - 2; j >= 0; j--) {
    if (body[j] === "\n") return j + 1;
    if (/[.!?…]/.test(body[j]) && /\s/.test(body[j + 1] ?? "")) return j + 1;
  }
  return 0;
}

/**
 * Whether a span can be wrapped in a link without breaking the markdown
 * around it — an emphasis or code run opened outside it and closed inside,
 * or a link of its own.
 */
function wrappable(span: string): boolean {
  if (/[[\]]/.test(span)) return false;
  const count = (re: RegExp) => (span.match(re) ?? []).length;
  return count(/\*\*/g) % 2 === 0 && count(/`/g) % 2 === 0 && count(/(?<!\*)\*(?!\*)/g) % 2 === 0;
}

/**
 * Rewrite a reply so each marked sentence becomes `[sentence](recall:N)`, and
 * every marker is gone.
 *
 * A link, because it is the one inline span markdown already has: the
 * renderer then hands it to a component that draws the highlight, and the
 * rest of the reply — lists, emphasis, headings — renders exactly as it would
 * without recall in it.
 */
export function markRecall(text: string): string {
  const src = dropPartial(text);
  let out = "";
  let from = 0;
  for (const m of src.matchAll(MARKER)) {
    const seg = src.slice(from, m.index);
    from = (m.index ?? 0) + m[0].length;
    const body = seg.replace(/\s+$/, "");
    const trailing = seg.slice(body.length);
    let start = sentenceStart(body);
    // A list bullet, a heading mark or a quote mark belongs to the line, not
    // to the sentence.
    const lead = body.slice(start).match(/^\s*(?:(?:[-*+]|\d+[.)]|#{1,6}|>)\s+)*/);
    start += lead ? lead[0].length : 0;
    const sentence = body.slice(start);
    if (sentence.trim() && wrappable(sentence)) {
      out += body.slice(0, start) + `[${sentence}](${RECALL_SCHEME}${m[1]})` + trailing;
    } else {
      out += seg;
    }
  }
  return out + src.slice(from);
}

/** A reply with every marker removed, for anywhere that cannot highlight. */
export function stripRecall(text: string): string {
  return dropPartial(text).replace(MARKER, "");
}
