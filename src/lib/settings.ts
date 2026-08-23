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
  ui_scale: number;
  idle_minutes: number;
  transcripts_dir: string;
  chat: ModelChoice | null;
  extraction: ModelChoice | null;
  /** Short answers, read aloud — for talking rather than reading. */
  call_mode: boolean;
  voice: Voice;
  runtime: Runtime;
}

export type Voice = "off" | "system";

/** How the model that runs inside the app is run. */
export interface Runtime {
  /** Layers handed to the GPU. 0 keeps everything on the CPU. */
  gpu_layers: number;
  context_length: number;
  kv_cache_on_gpu: boolean;
  keep_in_memory: boolean;
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

/**
 * Scale the whole interface, not just its text.
 *
 * Set on the root font-size, since every dimension in the stylesheet is in rem —
 * a control that only enlarged type would leave the buttons and spacing behind,
 * which reads as broken rather than as bigger.
 */
export function applyUiScale(percent: number): void {
  document.documentElement.style.fontSize = `${(percent / 100) * 15}px`;
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
