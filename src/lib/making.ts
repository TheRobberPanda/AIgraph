/**
 * What the Make tab is making right now, for the bar at the top.
 *
 * A book or a deck can take minutes, and the tab it was asked for it from is
 * not where the person is looking. This is one line about it that follows them
 * around the app: working, finished with a way to the result, or failed with
 * the reason. The output id is what the finished notice opens.
 */

export interface Making {
  /** What was asked for — the preset's name, or the first words of the ask. */
  name: string;
  status: "working" | "done" | "failed";
  /** The finished output, when there is one to open. */
  outputId: number | null;
  /** Why it failed, when it did. */
  error: string | null;
}

let current: Making | null = null;
let openRequest: number | null = null;
const listeners = new Set<(m: Making | null) => void>();

function emit() {
  for (const l of listeners) l(current);
}

export function getMaking(): Making | null {
  return current;
}

export function setMaking(m: Making | null) {
  current = m;
  emit();
}

/** Clear the notice once the person has seen it. */
export function clearMaking() {
  current = null;
  emit();
}

export function onMaking(cb: (m: Making | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Ask the Make tab to open one output. The bar is not inside Make, and Make
 * may not even be mounted when the notice is pressed, so the request waits
 * until it is.
 */
export function requestOpenMakeOutput(id: number) {
  openRequest = id;
  emit();
}

export function takeMakeOpenRequest(): number | null {
  const id = openRequest;
  openRequest = null;
  return id;
}
