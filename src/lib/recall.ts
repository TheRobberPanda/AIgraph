/**
 * Pulling recall markers out of a reply.
 *
 * The model is told to end a sentence with `[[recall:N]]` when it drew on an
 * idea already recorded, immediately after the sentence's own full stop. That
 * marker never reaches the screen — it is stripped here — but the paragraph it
 * sat in is kept as its own segment so the UI can highlight it and show where
 * the idea came from on hover.
 */

const MARKER = /\[\[recall:(\d+)\]\]/g;

export interface ReplySegment {
  /** Markdown text for this paragraph, marker already removed. */
  text: string;
  /** Set when this paragraph drew on a recorded idea. */
  ideaId: number | null;
}

/** Split a reply into paragraphs, tagging any that carry a recall marker. */
export function splitRecall(text: string): ReplySegment[] {
  return text
    .split(/\n{2,}/)
    .map((para) => {
      const hits = [...para.matchAll(MARKER)];
      const clean = para.replace(MARKER, "").trim();
      return { text: clean, ideaId: hits.length ? Number(hits[hits.length - 1][1]) : null };
    })
    .filter((seg) => seg.text.length > 0);
}
