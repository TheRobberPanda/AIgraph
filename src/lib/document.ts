/**
 * A made document read the way its file will be written.
 *
 * Mirrors `export/markdown.rs` and the deck writer in `export/ooxml.rs`: the
 * same `# Title` rule, a slide per heading, the same six lines before a slide
 * continues. The deck on screen has to be the deck that gets saved, or the
 * preview is a promise the file breaks.
 */

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "bullet"; text: string };

export interface Slide {
  head: string;
  lines: { text: string; bullet: boolean }[];
}

/** Lines a slide holds before the rest is continued on the next one. */
export const LINES_PER_SLIDE = 6;

/** The inline marks a slide cannot carry come off; the words stay. */
export function plain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

function heading(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6}) (.*)$/.exec(line);
  return m ? { level: Math.min(3, m[1].length), text: m[2] } : null;
}

function bullet(line: string): string | null {
  const m = /^(?:[-*+] |\d{1,3}[.)] )(.*)$/.exec(line);
  return m ? m[1].trimStart() : null;
}

/** Markdown read into headings, paragraphs and bullets. */
export function parseBlocks(md: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const text = plain(para.join(" "));
    para = [];
    if (text) out.push({ kind: "para", text });
  };

  let fenced = false;
  for (const raw of md.split("\n")) {
    const trimmed = raw.trimEnd().trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      if (trimmed) out.push({ kind: "para", text: trimmed });
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    const h = heading(trimmed);
    if (h) {
      flush();
      const text = plain(h.text);
      if (text) out.push({ kind: "heading", level: h.level, text });
      continue;
    }
    const item = bullet(trimmed);
    if (item !== null) {
      flush();
      const text = plain(item);
      if (text) out.push({ kind: "bullet", text });
      continue;
    }
    if (trimmed.length >= 3 && /^[-*_]+$/.test(trimmed)) {
      flush();
      continue;
    }
    para.push(trimmed);
  }
  flush();
  return out;
}

/** A deck: the title slide's words, then one slide per heading. */
export function toDeck(md: string, fallback: string): { title: string; slides: Slide[] } {
  let blocks = parseBlocks(md);
  let title = fallback.trim();
  const first = blocks[0];
  if (first && first.kind === "heading" && first.level === 1) {
    title = first.text;
    blocks = blocks.slice(1);
  }

  const grouped: Slide[] = [];
  for (const b of blocks) {
    if (b.kind === "heading") {
      grouped.push({ head: b.text, lines: [] });
      continue;
    }
    const line = { text: b.text, bullet: b.kind === "bullet" };
    const last = grouped[grouped.length - 1];
    if (last) last.lines.push(line);
    // Anything before the first heading is its own opening slide.
    else grouped.push({ head: "", lines: [line] });
  }

  const slides: Slide[] = [];
  for (const s of grouped) {
    if (s.lines.length <= LINES_PER_SLIDE) {
      slides.push(s);
      continue;
    }
    for (let i = 0; i < s.lines.length; i += LINES_PER_SLIDE) {
      slides.push({
        head: i === 0 ? s.head : `${s.head} (cont.)`,
        lines: s.lines.slice(i, i + LINES_PER_SLIDE),
      });
    }
  }
  return { title, slides };
}
