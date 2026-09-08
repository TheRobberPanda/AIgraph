/**
 * A stack of overlays that close on Escape, so only the topmost closes.
 *
 * Without this, every overlay that listens for Escape on `document` closes at
 * once — `stopPropagation` does nothing between listeners on the same element,
 * so a Sheet opened over a Drawer closed both. Each overlay pushes its closer
 * here on mount; a single listener calls the top of the stack, and closing
 * unmounts the overlay, popping its closer and revealing the one beneath.
 */

type Closer = () => void;

const stack: Closer[] = [];
let installed = false;

function ensure(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const top = stack[stack.length - 1];
    if (top) top();
  });
}

/** Register an overlay's close handler. Returns an unregister function. */
export function onEscapeLayer(closer: Closer): () => void {
  ensure();
  stack.push(closer);
  return () => {
    const i = stack.indexOf(closer);
    if (i >= 0) stack.splice(i, 1);
  };
}
