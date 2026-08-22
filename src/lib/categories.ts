/**
 * Colours for idea categories.
 *
 * A fixed, hand-picked set rather than generated hues. Random HSL produces
 * colours that fight the warm ground and each other; these are chosen to sit
 * together and to keep the palette's logic — warm tones for subjects, with the
 * cool accent reserved for conversations so the two node kinds stay legible.
 *
 * Assignment is by first appearance in a sorted category list, so a category
 * keeps its colour between sessions instead of shuffling on every reload.
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

export function categoryColors(categories: string[]): Map<string, string> {
  const sorted = [...new Set(categories.filter(Boolean))].sort();
  const map = new Map<string, string>();
  sorted.forEach((c, i) => map.set(c, CATEGORY_COLORS[i % CATEGORY_COLORS.length]));
  return map;
}
