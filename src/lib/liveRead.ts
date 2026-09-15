/**
 * What a read has found so far, pulled out of the model's reply while it is
 * still being written.
 *
 * The reply is one JSON object that arrives a few characters at a time, so at
 * any moment it is cut off somewhere — inside a string, after a key, halfway
 * through an idea. This walks it once, remembers the last point where
 * everything before was whole, closes whatever is open there and parses that.
 * An unfinished string value is kept (closed where it stops), so a claim shows
 * as it is being written rather than only once its quote mark arrives.
 */

export interface LiveIdea {
  title: string;
  claim: string;
  category: string;
}

export interface LiveRead {
  /** The conversation's name, once the model has written it. */
  title: string | null;
  ideas: LiveIdea[];
  definitions: { term: string; definition: string }[];
}

type Frame = { t: "o" | "a"; s: "key" | "colon" | "val" | "after" };

const closers = (stack: Frame[]) =>
  stack
    .map((f) => (f.t === "o" ? "}" : "]"))
    .reverse()
    .join("");

/** The longest whole-JSON prefix of `text`, closed off. Null if none. */
export function closePartialJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const s = text.slice(start);
  const stack: Frame[] = [];
  let safe: { at: number; close: string } | null = null;
  let inString = false;
  let isKey = false;
  let escaped = false;
  let inLiteral = false;

  /** A value just finished in the frame on top. */
  const valueDone = (at: number) => {
    const top = stack[stack.length - 1];
    if (top) top.s = "after";
    safe = { at, close: closers(stack) };
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') {
        inString = false;
        if (isKey) stack[stack.length - 1].s = "colon";
        else valueDone(i + 1);
      }
      continue;
    }
    if (inLiteral) {
      if (/[\s,}\]]/.test(c)) {
        inLiteral = false;
        valueDone(i);
      } else continue;
    }
    const top = stack[stack.length - 1];
    if (c === '"') {
      inString = true;
      isKey = top?.t === "o" && top.s === "key";
    } else if (c === "{" || c === "[") {
      stack.push({ t: c === "{" ? "o" : "a", s: c === "{" ? "key" : "val" });
      safe = { at: i + 1, close: closers(stack) };
    } else if (c === "}" || c === "]") {
      stack.pop();
      if (stack.length === 0) return s.slice(0, i + 1);
      valueDone(i + 1);
    } else if (c === ":") {
      if (top) top.s = "val";
    } else if (c === ",") {
      if (top) top.s = top.t === "o" ? "key" : "val";
    } else if (!/\s/.test(c)) {
      inLiteral = true;
    }
  }

  // Cut off inside a value string: keep what there is of it.
  if (inString && !isKey) {
    let body = s;
    if (escaped) body = body.slice(0, -1);
    return body + '"' + closers(stack);
  }
  const at: { at: number; close: string } | null = safe;
  if (!at) return null;
  // A trailing comma before the cut would make the closed text invalid.
  return s.slice(0, at.at).replace(/,\s*$/, "") + at.close;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Everything readable in the reply so far. Never throws. */
export function parseLiveRead(output: string): LiveRead {
  const empty: LiveRead = { title: null, ideas: [], definitions: [] };
  if (!output.trim()) return empty;
  const closed = closePartialJson(output);
  if (closed) {
    try {
      const root = JSON.parse(closed) as Record<string, unknown>;
      // "language" comes first in the schema, so a real root has it (or its
      // ideas) early. Anything else is an idea object found in a trimmed tail.
      if (root && typeof root === "object" && ("ideas" in root || "language" in root)) {
        const ideas = Array.isArray(root.ideas) ? root.ideas : [];
        const defs = Array.isArray(root.definitions) ? root.definitions : [];
        return {
          title: str(root.title) || null,
          ideas: ideas
            .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
            .map((o) => ({ title: str(o.title), claim: str(o.claim), category: str(o.category) }))
            .filter((i) => i.title || i.claim),
          definitions: defs
            .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
            .map((o) => ({ term: str(o.term), definition: str(o.definition) }))
            .filter((d) => d.term),
        };
      }
    } catch {
      // Fall through to the scan below.
    }
  }
  // The start of a long reply can be trimmed away by the wire log, leaving no
  // root to parse. The claims are still there to be found one by one.
  const claims: LiveIdea[] = [];
  for (const m of output.matchAll(/"claim"\s*:\s*"((?:[^"\\]|\\.)*)/g)) {
    let raw = m[1];
    if (raw.endsWith("\\")) raw = raw.slice(0, -1);
    try {
      claims.push({ title: "", claim: JSON.parse(`"${raw}"`), category: "" });
    } catch {
      claims.push({ title: "", claim: raw, category: "" });
    }
  }
  return { ...empty, ideas: claims };
}
