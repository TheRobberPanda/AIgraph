import { getSettings, saveSettings } from "./settings";
import { wantsReasoning } from "./chat";

const NOTICE_EVENT = "aigraph:notice";

/**
 * A short warning that shows and fades on its own.
 *
 * For things the app did on someone's behalf that they should know about but
 * do not need to act on — an error bar would ask for attention nobody owes it.
 */
export function notify(text: string): void {
  window.dispatchEvent(new CustomEvent(NOTICE_EVENT, { detail: text }));
}

export function onNotice(cb: (text: string) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<string>).detail);
  window.addEventListener(NOTICE_EVENT, handler);
  return () => window.removeEventListener(NOTICE_EVENT, handler);
}

/**
 * Turn reasoning on when a model refused to answer without it.
 *
 * Some models cannot think less than they do — "Reasoning is mandatory for
 * this endpoint and cannot be disabled." With reasoning off in Settings every
 * message to them failed until someone found the switch. Returns whether it
 * was that refusal and the switch is now on, so the caller can ask again.
 */
export async function enableReasoningFor(error: unknown): Promise<boolean> {
  if (!wantsReasoning(String(error))) return false;
  const current = await getSettings();
  if (current.reasoning) return false;
  await saveSettings({ ...current, reasoning: true });
  notify(REASONING_TURNED_ON);
  return true;
}

export const REASONING_TURNED_ON =
  "This model only answers with reasoning on, so reasoning was turned on.";
