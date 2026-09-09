import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LocalKind, Selected } from "./chat";

export type Theme = "auto" | "dark" | "light" | "ember" | "ink" | "slate" | "paper";

export interface ModelChoice {
  kind: LocalKind;
  host: string;
  model: string;
}

/** Accent colours on offer, one swatch each. */
export const ACCENTS: { id: string; label: string; hex: string }[] = [
  { id: "", label: "Theme default", hex: "" },
  { id: "coral", label: "Coral", hex: "#e08659" },
  { id: "gold", label: "Gold", hex: "#dba53f" },
  { id: "verdant", label: "Verdant", hex: "#7ead6f" },
  { id: "haze", label: "Haze", hex: "#9fb8d4" },
  { id: "rose", label: "Rose", hex: "#c9899f" },
  { id: "iris", label: "Iris", hex: "#a396c4" },
];

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
  /** Whether explanations sit on the page or wait under a hint. */
  show_explanations: boolean;
  /** Whether an idea's notes are followed by a question about them. */
  ask_why: boolean;
  map_style: MapStyle;
  /** How hard the map's nodes push each other apart. */
  map_spread: MapSpread;
  /** Advanced layout order: conversations left, Make right. */
  advanced_swap: boolean;
  /** The accent colour id. Empty means the theme's own. */
  accent: string;
  /** The one-click instructions on the Make tab, yours to edit. */
  presets: Preset[];
}

/** A named instruction, one button on the Make tab. */
export interface Preset {
  /** Stable across renames, so editing the label does not orphan the entry. */
  id: string;
  name: string;
  prompt: string;
  /** What pressing it is meant to produce. The model is told the shape to
   *  write in, and saving the answer writes that kind of file. */
  format: OutputFormat;
}

/**
 * What an instruction is asking the model to make.
 *
 * Not a save-time choice, a write-time one. A deck and an essay are not the
 * same text in two wrappers — one is a sequence of slides with a title and
 * four bullets each, the other is prose with headings — so the format has to
 * reach the model, not just the file writer. That is why it lives on the
 * preset beside the wording rather than on the Save button.
 */
export type OutputFormat = "markdown" | "pdf" | "docx" | "pptx";

export const OUTPUT_FORMATS: {
  value: OutputFormat;
  label: string;
  /** What the file ends in, and what the save dialog offers. */
  ext: string;
  blurb: string;
}[] = [
  {
    value: "markdown",
    label: "Markdown",
    ext: "md",
    blurb: "Plain text with headings. Opens anywhere, and stays readable in fifty years.",
  },
  {
    value: "pdf",
    label: "PDF",
    ext: "pdf",
    blurb: "Typeset for reading and printing. Nobody can edit it, which is sometimes the point.",
  },
  {
    value: "docx",
    label: "Word",
    ext: "docx",
    blurb: "A document to be edited by somebody else, in Word or anything that reads it.",
  },
  {
    value: "pptx",
    label: "Slides",
    ext: "pptx",
    blurb: "A deck. The model writes in slides — a title and a few lines each — rather than prose.",
  },
];

export function formatLabel(f: OutputFormat): string {
  return OUTPUT_FORMATS.find((x) => x.value === f)?.label ?? "Markdown";
}

export function formatExt(f: OutputFormat): string {
  return OUTPUT_FORMATS.find((x) => x.value === f)?.ext ?? "md";
}

/** One place at a time, or everything around the conversation at once. */
export type Layout = "simple" | "advanced";

/**
 * How the map arranges itself.
 *
 * Three arrangements of the same material, not three skins: each decides
 * where nodes go. Nothing is ever hidden by one — a style that dropped nodes
 * would be a filter wearing an appearance setting's clothes.
 */
export type MapStyle = "nodes" | "forest" | "galaxy";

/**
 * How much room the map's nodes claim from each other.
 *
 * Separate from the arrangement, which decides *where* things go. This decides
 * how insistently they push apart once they are there.
 */
export type MapSpread = "loose" | "balanced" | "tight";

export const MAP_SPREADS: { value: MapSpread; label: string; blurb: string }[] = [
  { value: "loose", label: "Roomy", blurb: "Nothing overlaps. The map gets large." },
  { value: "balanced", label: "Balanced", blurb: "The default." },
  { value: "tight", label: "Close", blurb: "The whole shape without panning." },
];

export const MAP_STYLES: { value: MapStyle; label: string; blurb: string }[] = [
  {
    value: "forest",
    label: "Forest",
    blurb: "A tree per conversation, side by side, with its ideas as the roots beneath it.",
  },
  {
    value: "nodes",
    // Renamed in the interface only. The stored value stays "nodes" — it is
    // in everyone's settings file already, and a rename that reaches the disk
    // costs a migration to buy nothing.
    label: "Neuron",
    blurb: "A force-directed graph. Everything is a peer; the shape comes from what connects to what.",
  },
  {
    value: "galaxy",
    label: "Galaxy",
    blurb: "Ideas orbit the conversation they came from. Ideas linked to each other share a ring.",
  },
];
export type Voice = "off" | "system" | "neural";

/** Argue the substance, or just help lay it out. */
export type ChatStance = "neutral" | "challenge" | "organize";

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

/** Put the Make tab's instructions back to what they shipped as. */
export function resetPresets(): Promise<Settings> {
  return invoke<Settings>("reset_presets");
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
 * Apply the accent choice. Empty string clears the attribute so the theme's
 * own accent shows through; anything else is a key into the stylesheet's
 * accent overrides, which carry a dark and a light tint per colour.
 */
export function applyAccent(accent: string): void {
  const root = document.documentElement;
  if (accent) root.setAttribute("data-accent", accent);
  else root.removeAttribute("data-accent");
}

/**
 * Scale the whole interface, not just its text.
 *
 * Set on the root font-size, since every dimension in the stylesheet is in rem —
 * a control that only enlarged type would leave the buttons and spacing behind,
 * which reads as broken rather than as bigger.
 *
 * The topbar degrades with the *effective* width — the window's width at the
 * reference scale — because how much room its contents take scales with the
 * interface while the window does not. At 135% on the same monitor, five
 * labelled tabs are a third again as wide and no fixed pixel breakpoint can
 * decide for every scale.
 */
const TOPBAR_ROOMY = 1310;
const TOPBAR_ICONS = 1190;
const REFERENCE_FONT = 15;

let topbarResizeInstalled = false;

function applyTopbarClasses(): void {
  const root = document.documentElement;
  const scale = parseFloat(root.style.fontSize) / REFERENCE_FONT || 1;
  const effective = window.innerWidth / scale;
  const icons = effective < TOPBAR_ICONS;
  root.classList.toggle("topbar-icons", icons);
  root.classList.toggle("topbar-tight", !icons && effective < TOPBAR_ROOMY);
}

export function applyUiScale(percent: number): void {
  document.documentElement.style.fontSize = `${(percent / 100) * REFERENCE_FONT}px`;
  applyTopbarClasses();
  if (!topbarResizeInstalled) {
    topbarResizeInstalled = true;
    window.addEventListener("resize", applyTopbarClasses);
  }
}

export interface KeyStatus {
  anthropic: boolean;
  claude_cli: boolean;
  openrouter: boolean;
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

/** Checked against OpenRouter before it is saved, so a typo fails here. */
export function setOpenRouterKey(key: string): Promise<string[]> {
  return invoke<string[]>("set_openrouter_key", { key });
}

export function clearOpenRouterKey(): Promise<void> {
  return invoke("clear_openrouter_key");
}

/** The model the app runs itself. */
export interface EmbeddedStatus {
  /** Which build we installed, if we installed it. */
  server_build?: string | null;
  /** Whether a vendor-neutral GPU build exists for this platform. */
  vulkan_available?: boolean;
  /** Whether a prebuilt CUDA llama-server exists for this platform. Windows
   *  only — llama.cpp publishes no CUDA archive for Linux. */
  cuda_available?: boolean;
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
