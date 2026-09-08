/**
 * Ctrl+Z in a box whose value lives in React state.
 *
 * A controlled `<textarea>` has no working undo. The browser keeps its own
 * history, but every render sets `value` from outside, which discards it — so
 * the shortcut either does nothing or jumps back to something arbitrary from
 * before the last render. Typing a paragraph and pressing the most reflexive
 * shortcut there is should not be a way to lose it.
 *
 * Steps coalesce: a sentence typed straight through is one undo, not forty.
 */

import { useCallback, useEffect, useRef } from "react";

/** A pause this long ends the current step. */
const SETTLE_MS = 500;
/** So does a change this big — a paste is its own step, never half of one. */
const JUMP = 24;
/** Deep enough to get back out of a mistake, bounded so it cannot grow for
 *  the lifetime of the window. */
const DEPTH = 200;

export function useUndoable(value: string, setValue: (v: string) => void) {
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  /** The value this hook has already accounted for. */
  const at = useRef(value);
  const when = useRef(0);

  useEffect(() => {
    // Already ours — this is the render caused by our own undo or redo.
    if (value === at.current) return;

    const now = Date.now();
    if (now - when.current > SETTLE_MS || Math.abs(value.length - at.current.length) > JUMP) {
      past.current.push(at.current);
      if (past.current.length > DEPTH) past.current.shift();
      // Anything typed after an undo abandons the redo branch, which is what
      // every editor does and what the hand expects.
      future.current = [];
    }
    at.current = value;
    when.current = now;
  }, [value]);

  return useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return false;
      e.preventDefault();

      // Ctrl+Shift+Z and Ctrl+Y both redo; people arrive with either.
      const stack = e.shiftKey ? future : past;
      const other = e.shiftKey ? past : future;
      const to = stack.current.pop();
      if (to === undefined) return true;

      other.current.push(at.current);
      at.current = to;
      // Set before the effect can see it, so the change is not recorded as a
      // fresh edit and undone again on the next press.
      setValue(to);
      when.current = 0;
      return true;
    },
    [setValue],
  );
}
