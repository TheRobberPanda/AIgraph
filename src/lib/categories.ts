/**
 * Colours for idea categories.
 *
 * A fixed, hand-picked set rather than generated hues. Random HSL produces
 * colours that fight the warm ground and each other; these are chosen to sit
 * together and to keep the palette's logic — warm tones for subjects, with the
 * cool accent reserved for conversations so the two node kinds stay legible.
 *
 * Assignment is by a hash of the category's own name. Nothing else is
 * consulted, so the same subject is the same colour everywhere it appears —
 * on the map, in the Conversations filter — without those places having to
 * agree on a shared list first. It also means a new category never reshuffles
 * the colours of the ones already there, which an index-into-a-sorted-list
 * scheme did every time a subject was coined.
 */
const CATEGORY_COLORS = [
  "#d9a34a", // gold
  "#a8c08a", // sage
  "#c98d6b", // clay
  "#9fb8d4", // haze
  "#c9899f", // rose
  "#8fbfae", // verdigris
  "#c4a86b", // straw
  "#a396c4", // iris
  "#d0866b", // ember
  "#8fae8a", // moss
];

/** The colour for an uncategorised idea — deliberately unremarkable. */
export const UNCATEGORISED = "#a8a094";

/** The colour for one subject, from its name alone. */
export function categoryColor(category: string): string {
  if (!category) return UNCATEGORISED;
  // djb2. Any stable string hash would do; this one is short and spreads
  // short lowercase words well enough across ten buckets.
  let h = 5381;
  for (let i = 0; i < category.length; i++) {
    h = ((h << 5) + h + category.charCodeAt(i)) | 0;
  }
  return CATEGORY_COLORS[Math.abs(h) % CATEGORY_COLORS.length];
}

export function categoryColors(categories: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of [...new Set(categories.filter(Boolean))].sort()) {
    map.set(c, categoryColor(c));
  }
  return map;
}
