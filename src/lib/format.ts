/** Dates, formatted the same way everywhere. */

/** "Friday, 21 August" — a day you might actually place. */
export function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** "21 August 2026" — for places where the weekday is noise. */
export function plainDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}


/**
 * A model id fit to be read.
 *
 * `llama-server` reports the path it was given, so the id is an absolute
 * filename — fine as an identifier, unreadable in a button. The last part is
 * the part that distinguishes one model from another; a provider that reports
 * a proper name is left alone.
 */
export function modelName(id: string): string {
  if (!id.includes("/") && !id.includes("\\")) return id;
  const last = id.split(/[\\/]/).pop() ?? id;
  return last.replace(/\.gguf$/i, "");
}
