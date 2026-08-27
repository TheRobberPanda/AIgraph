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
  /** File a conversation by itself once it has gone quiet. Off. */
  auto_file: boolean;
  /** Minutes of quiet before that happens, when it is switched on. */
  idle_minutes: number;
  transcripts_dir: string;
  chat: ModelChoice | null;
  extraction: ModelChoice | null;
  /** Short answers, read aloud — for talking rather than reading. */
  call_mode: boolean;
  voice: Voice;
  /** Hand the chat the titles of ideas already recorded. */
  recall: boolean;
  /** Let the model think out loud before answering. */
  reasoning: boolean;
  /** The language everything is written in. "auto" follows the text. */
  language: Language;
  /** Whether the chat pushes back on what's said, or just helps lay it out. */
  chat_stance: ChatStance;
  /** Seconds of quiet in a call before what you said is sent. */
  call_silence_seconds: number;
  /** Seconds of open microphone with nothing said before dictation stops
   *  itself outside a call. 0 means never. */
  mic_timeout_seconds: number;
  runtime: Runtime;
  layout: Layout;
}

/** One place at a time, or everything around the conversation at once. */
export type Layout = "simple" | "advanced";

export type Voice = "off" | "system" | "neural";

/** Argue the substance, or just help lay it out. */
export type ChatStance = "challenge" | "organize";

export type Language = "auto" | "english" | "polish" | "spanish";

/** The languages on offer, and what to call them on screen. */
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "auto", label: "Follow what I write" },
  { value: "english", label: "English" },
  { value: "polish", label: "Polski" },
  { value: "spanish", label: "Espa\u00f1ol" },
];

/** How the model that runs inside the app is run. */
export interface Runtime {
  /** Layers handed to the GPU. 0 keeps everything on the CPU. */
  gpu_layers: number;
  context_length: number;
  kv_cache_on_gpu: boolean;
  keep_in_memory: boolean;
  /** 0 lets llama.cpp decide from the machine. */
  threads: number;
  parallel: number;
  batch_size: number;
  ubatch_size: number;
  kv_unified: boolean;
  flash_attention: boolean;
  mlock: boolean;
  temperature: number;
  top_p: number;
  top_k: number;
  repeat_penalty: number;
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

/** Move where transcripts are written from here on. "" means the default. */
export function setTranscriptsDir(path: string): Promise<string> {
  return invoke<string>("set_transcripts_dir", { path });
}

/** Re-read every conversation, or only those in one folder. */
export function reextractAll(folder?: number | null): Promise<number> {
  return invoke<number>("reextract_all", { folder: folder ?? null });
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

/** The model the app runs itself. */
export interface EmbeddedStatus {
  /** Which build we installed, if we installed it. */
  server_build?: string | null;
  /** Whether a vendor-neutral GPU build exists for this platform. */
  vulkan_available?: boolean;
  model_ready: boolean;
  server_ready: boolean;
  server_path: string | null;
  running: boolean;
  /** Every GGUF already on disk. */
  downloaded: string[];
  download_gb: number;
  host: string;
}

export function embeddedStatus(): Promise<EmbeddedStatus> {
  return invoke<EmbeddedStatus>("embedded_status");
}

export function downloadEmbeddedModel(): Promise<void> {
  return invoke("download_embedded_model");
}

/** Start it and wait until it answers. Returns the host it is on. */
export function startEmbedded(file?: string | null): Promise<string> {
  return invoke<string>("start_embedded", { file: file ?? null });
}

export function stopEmbedded(): Promise<void> {
  return invoke("stop_embedded");
}

/**
 * Progress while the bundled model downloads.
 *
 * Its own channel rather than the speech model's — they are different
 * downloads, they can overlap, and crossing them showed neither.
 */
export function onModelDownload(
  cb: (p: { what: string; received: number; total: number }) => void,
): Promise<UnlistenFn> {
  return listen<{ what: string; received: number; total: number }>("model:download", (e) =>
    cb(e.payload),
  );
}

export interface RemoteModel {
  id: string;
  downloads: number;
  likes: number;
}

export interface RemoteFile {
  path: string;
  size: number;
}

/** Search Hugging Face for GGUF models. Live, so it never goes stale. */
export function searchModels(query: string): Promise<RemoteModel[]> {
  return invoke<RemoteModel[]>("search_models", { query });
}

export function modelFiles(repo: string): Promise<RemoteFile[]> {
  return invoke<RemoteFile[]>("model_files", { repo });
}

export function downloadModelFile(repo: string, file: string, size: number): Promise<void> {
  return invoke("download_model_file", { repo, file, size });
}


/** Fetch a llama-server, so a model can run without one installed. */
export function installLlamaServer(flavour: "cpu" | "vulkan" | string = "cpu"): Promise<void> {
  return invoke("install_llama_server", { flavour });
}

export function onServerDownload(
  handler: (p: { what: string; received: number; total: number }) => void,
): Promise<UnlistenFn> {
  return listen<{ what: string; received: number; total: number }>("server:download", (e) =>
    handler(e.payload),
  );
}

export function voiceStatus(): Promise<{ installed: boolean; download_mb: number }> {
  return invoke("voice_status");
}

export function installVoice(): Promise<void> {
  return invoke("install_voice");
}

export function onVoiceDownload(
  handler: (p: { what: string; received: number; total: number }) => void,
): Promise<UnlistenFn> {
  return listen<{ what: string; received: number; total: number }>("voice:download", (e) =>
    handler(e.payload),
  );
}

/** Read a reply out in the downloaded voice. */
export function speakNeural(text: string): Promise<void> {
  return invoke("speak", { text });
}


/** What the embedded model is doing right now, from llama-server's own /slots. */
export interface RuntimeStatus {
  phase: "idle" | "reading" | "writing" | "";
  prompt_done: number;
  prompt_total: number;
  prompt_cached: number;
  /** Tokens written so far in this request. */
  decoded: number;
  context: number;
  reachable: boolean;
}

export function runtimeStatus(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("runtime_status");
}


/** Put the model's own settings back where they started. */
export function resetRuntime(): Promise<Settings> {
  return invoke<Settings>("reset_runtime");
}
