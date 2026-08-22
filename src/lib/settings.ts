import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LocalKind, Selected } from "./chat";

export type Theme = "auto" | "dark" | "light";

export interface ModelChoice {
  kind: LocalKind;
  host: string;
  model: string;
}

export interface Settings {
  theme: Theme;
  idle_minutes: number;
  transcripts_dir: string;
  chat: ModelChoice | null;
  extraction: ModelChoice | null;
}

export interface ActiveModels {
  chat: Selected | null;
  extraction: Selected | null;
}

export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export function saveSettings(settings: Settings): Promise<Settings> {
  return invoke<Settings>("save_settings", { settings });
}

export function activeModels(): Promise<ActiveModels> {
  return invoke<ActiveModels>("active_models");
}

export function chooseModel(
  role: "chat" | "extraction",
  kind: LocalKind,
  host: string,
  model: string,
): Promise<void> {
  return invoke("choose_model", { role, kind, host, model });
}

export function transcriptsDir(): Promise<string> {
  return invoke<string>("transcripts_dir");
}

export function reextractAll(): Promise<number> {
  return invoke<number>("reextract_all");
}

export function onSettingsChanged(cb: (s: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>("settings:changed", (e) => cb(e.payload));
}

/**
 * Apply the theme to the document.
 *
 * "auto" removes the attribute so the CSS falls back to the system preference;
 * an explicit choice sets it and wins over the media query.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export interface KeyStatus {
  anthropic: boolean;
  claude_cli: boolean;
}

export function keyStatus(): Promise<KeyStatus> {
  return invoke<KeyStatus>("key_status");
}

/** Store an Anthropic key. Validated against the API before it is saved. */
export function setAnthropicKey(key: string): Promise<string[]> {
  return invoke<string[]>("set_anthropic_key", { key });
}

export function clearAnthropicKey(): Promise<void> {
  return invoke("clear_anthropic_key");
}
