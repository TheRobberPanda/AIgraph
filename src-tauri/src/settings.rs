//! User settings.
//!
//! Stored as JSON next to the database rather than inside it. It is a handful of
//! values a person might reasonably want to read, edit, or copy between machines
//! without a SQL client — which fits the rest of the app's local-first, nothing-
//! locked-away stance.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::llm::detect::LocalKind;

/// Which model, on which server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelChoice {
    pub kind: LocalKind,
    pub host: String,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Auto,
    Dark,
    Light,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: Theme,
    /// Overall interface scale, as a percentage of the default (100). Applied as
    /// a root font-size multiplier, so it scales text, spacing and controls
    /// together rather than just the type.
    pub ui_scale: u32,
    /// File a conversation by itself once it has gone quiet.
    ///
    /// Off. Walking away from a half-finished thought and coming back to find
    /// it filed — and read, and turned into ideas — is the app deciding you
    /// were done when you were making tea. Pressing Done is not a burden;
    /// having a conversation ended for you is.
    pub auto_file: bool,
    /// Minutes of silence before that happens, when it is switched on.
    pub idle_minutes: u32,
    /// Where the plain-markdown copies go. Empty means the default location.
    pub transcripts_dir: String,
    /// The model you talk to.
    pub chat: Option<ModelChoice>,
    /// The model that reads sessions afterwards.
    ///
    /// Separate from `chat` on purpose. Extraction is a mechanical structured
    /// task where a small fast model does fine, while conversation may want a
    /// larger one — and tying them together means paying for the large model
    /// twice.
    pub extraction: Option<ModelChoice>,
    /// Short answers, read aloud as they arrive — for talking rather than
    /// reading. Nothing is truncated; the model is asked to be brief.
    pub call_mode: bool,
    /// How a reply is spoken. `off`, `system` for the machine's own voice, or
    /// `neural` for the downloaded one.
    pub voice: Voice,
    /// Hand the model the titles of ideas already recorded, so it can connect
    /// what is being said now to what was said before.
    pub recall: bool,
    /// Let the model think out loud before answering.
    ///
    /// Off. A reasoning model will spend thousands of tokens deliberating over
    /// a sentence, and none of it is shown or recorded — it is pure latency
    /// between asking and hearing. Worth turning on for something genuinely
    /// hard, which is not most of what gets said to this app.
    pub reasoning: bool,
    /// The language the model is asked to answer and write in.
    ///
    /// `Auto` follows whatever the person is writing, which is right until it
    /// is not: a short first message, or one with a name in it, is not much to
    /// go on, and a model that guesses wrong answers a Polish speaker in
    /// English. Naming it settles the question.
    pub language: Language,
    /// Seconds of quiet in a call before what you said is sent.
    ///
    /// Thinking out loud has pauses in it, and a short wait cuts people off
    /// mid-sentence. Five is long enough to gather a thought and short enough
    /// not to feel stuck.
    pub call_silence_seconds: u32,
    /// How the model bundled with the app is run, when that is the one in use.
    pub runtime: Runtime,
    /// Whether the map, ideas and conversations sit around the conversation
    /// or are visited one at a time.
    pub layout: Layout,
}

/// How much of the app is on screen at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Layout {
    /// One place at a time, reached from tabs. Less on screen, less to read.
    #[default]
    Simple,
    /// The map, the conversations and the ideas all around the talking.
    Advanced,
}

/// The language the app works in.
///
/// A short list on purpose: these are the ones actually tested end to end,
/// through extraction, digests and quote verification. Adding a name here that
/// nobody has run a conversation in would be a promise rather than a feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    Auto,
    English,
    Polish,
    Spanish,
}

/// The language every prompt is currently pinned to.
///
/// Held apart from the settings file because prompts are built deep inside the
/// extractor, the digest and the chat, in places that have no reason to know
/// what a settings file is. Threading one enum through all of them would touch
/// a dozen signatures to say one thing that never varies within a run.
static PINNED: std::sync::RwLock<Language> = std::sync::RwLock::new(Language::Auto);

/// Point every prompt at a language. Called when settings are loaded or saved.
pub fn pin_language(language: Language) {
    if let Ok(mut p) = PINNED.write() {
        *p = language;
    }
}

/// The pinned language, or `Auto` if nothing has pinned one.
pub fn pinned_language() -> Language {
    PINNED.read().map(|p| *p).unwrap_or_default()
}

/// The line to add to a prompt so the model answers in the chosen language.
///
/// Empty under `Auto`, where the existing rule — follow the source — stands.
pub fn language_instruction() -> String {
    match pinned_language().name() {
        None => String::new(),
        Some(name) => format!(
            "\n\nLanguage: write everything in {name}, whatever language the \
             text you are given is in. Every field, every sentence. The one \
             exception is a quote, which is copied character for character \
             from the source and never translated.\n"
        ),
    }
}

impl Language {
    /// The name to put in a prompt, in English, as the schemas expect.
    pub fn name(self) -> Option<&'static str> {
        match self {
            Language::Auto => None,
            Language::English => Some("English"),
            Language::Polish => Some("Polish"),
            Language::Spanish => Some("Spanish"),
        }
    }
}

/// How a reply gets read out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Voice {
    #[default]
    Off,
    /// The machine's own speech, through whatever it already has installed.
    /// Nothing to download, and it respects the voice already configured.
    System,
    /// A downloaded neural voice (Piper). Better, at the cost of a download
    /// and a little CPU. Falls back to `System` if the voice is missing.
    Neural,
}

/// Knobs for the model that runs inside the app.
///
/// These are the ones that decide whether a 27B model is pleasant or painful
/// on a given machine, so they are settings rather than constants.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Runtime {
    /// Layers handed to the GPU. 0 keeps everything on the CPU.
    pub gpu_layers: u32,
    /// Tokens of context to allocate. Bonsai carries 262K, but reserving all
    /// of it costs memory that most conversations never use.
    pub context_length: u32,
    /// Keep the key/value cache in GPU memory. Faster, at the cost of VRAM
    /// that the chat model may want for itself.
    pub kv_cache_on_gpu: bool,
    /// Hold the weights in memory between sessions instead of unloading.
    /// Avoids a reload on every conversation, at the cost of holding the RAM.
    pub keep_in_memory: bool,
    /// CPU threads. 0 lets llama.cpp decide from the machine.
    pub threads: u32,
    /// How many sequences are processed at once. Above one, two conversations
    /// can be answered in parallel; each costs its own slice of the context.
    pub parallel: u32,
    /// Logical batch: how many prompt tokens are handed to the backend at
    /// once. This is the one that decides how fast a long prompt is read.
    pub batch_size: u32,
    /// Physical batch: how many of those are actually computed in one pass.
    /// Bounded by memory rather than by throughput, and rarely worth raising.
    pub ubatch_size: u32,
    /// One KV cache shared across slots instead of one each. With several
    /// slots this is the difference between the cache fitting and not.
    pub kv_unified: bool,
    /// Fused attention kernels: faster and lighter on memory where the backend
    /// has them, and ignored where it does not.
    pub flash_attention: bool,
    /// Lock the weights in RAM so the OS cannot page them out. Costly on a
    /// machine that is already short, and a large win on one that is not.
    pub mlock: bool,
    /// How adventurous the wording is. Sampling settings apply to the model
    /// the app runs; a hosted provider has its own.
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: u32,
    /// Pressure against repeating itself. 1.0 is off.
    pub repeat_penalty: f32,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            // Conservative on purpose: the extraction model and the chat model
            // already contend for one card, and a bad default here shows up as
            // a crash rather than as slowness.
            gpu_layers: 0,
            context_length: 8192,
            // On. The cache is several gigabytes at a large context, and left
            // in system memory every token of it crosses the bus. It was off
            // out of caution about VRAM and the caution cost more than it
            // saved.
            kv_cache_on_gpu: true,
            keep_in_memory: true,
            threads: 0,
            parallel: 4,
            // llama.cpp's own defaults. The previous 512 was this app halving
            // the logical batch for no reason, which quartered how fast a long
            // prompt was read.
            batch_size: 2048,
            ubatch_size: 512,
            kv_unified: true,
            flash_attention: true,
            mlock: false,
            // llama.cpp's own defaults. Anything else here would be this app
            // quietly having an opinion about how every model should sound.
            temperature: 0.8,
            top_p: 0.95,
            top_k: 40,
            repeat_penalty: 1.1,
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::Auto,
            ui_scale: 100,
            auto_file: false,
            idle_minutes: 10,
            transcripts_dir: String::new(),
            chat: None,
            extraction: None,
            call_mode: false,
            voice: Voice::Off,
            recall: true,
            reasoning: false,
            language: Language::Auto,
            call_silence_seconds: 5,
            runtime: Runtime::default(),
            layout: Layout::default(),
        }
    }
}

impl Settings {
    fn path(dir: &Path) -> PathBuf {
        dir.join("settings.json")
    }

    /// Read settings, falling back to defaults.
    ///
    /// A corrupt or half-written file yields defaults rather than an error: it
    /// is a preferences file, and refusing to start over it would be absurd.
    pub fn load(dir: &Path) -> Self {
        let loaded: Self = std::fs::read_to_string(Self::path(dir))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        // Pin here rather than at the call site: every way into the app reads
        // settings, and only one of them would remember to do this.
        pin_language(loaded.language);
        loaded
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let body = serde_json::to_string_pretty(self)?;
        // Write beside, then rename, so an interrupted save cannot leave a
        // truncated file that reads back as defaults.
        let tmp = Self::path(dir).with_extension("json.tmp");
        std::fs::write(&tmp, body)?;
        std::fs::rename(tmp, Self::path(dir))
    }

    /// Where transcripts should be written.
    pub fn transcripts_path(&self, default_dir: &Path) -> PathBuf {
        if self.transcripts_dir.trim().is_empty() {
            default_dir.to_path_buf()
        } else {
            PathBuf::from(&self.transcripts_dir)
        }
    }

    pub fn idle_timeout(&self) -> std::time::Duration {
        // A zero timeout would archive a session the moment you paused to think,
        // which is exactly when people pause.
        std::time::Duration::from_secs(60 * self.idle_minutes.max(1) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory per test. Tests run in parallel, and sharing one meant they
    /// deleted each other's files mid-run.
    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ig-settings-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn round_trips() {
        let dir = tmpdir("round");
        let mut s = Settings { theme: Theme::Dark, idle_minutes: 5, ..Settings::default() };
        s.chat = Some(ModelChoice {
            kind: LocalKind::LmStudio,
            host: "http://x/v1".into(),
            model: "m".into(),
        });
        s.save(&dir).unwrap();

        let back = Settings::load(&dir);
        assert_eq!(back.theme, Theme::Dark);
        assert_eq!(back.idle_minutes, 5);
        assert_eq!(back.chat.unwrap().model, "m");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupt_file_yields_defaults_rather_than_failing() {
        let dir = tmpdir("corrupt");
        std::fs::write(Settings::path(&dir), "{ not json").unwrap();
        assert_eq!(Settings::load(&dir).idle_minutes, 10);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_fields_fall_back_rather_than_wiping_the_file() {
        // An older settings file, or one edited by hand, must still load.
        let dir = tmpdir("partial");
        std::fs::write(Settings::path(&dir), r#"{"idle_minutes": 7}"#).unwrap();
        let s = Settings::load(&dir);
        assert_eq!(s.idle_minutes, 7);
        assert_eq!(s.theme, Theme::Auto);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Coming back to an unfinished conversation is the default behaviour.
    #[test]
    fn nothing_is_filed_by_itself_unless_asked() {
        assert!(!Settings::default().auto_file);
    }

    /// A language nobody chose is a language the source decides.
    #[test]
    fn language_starts_out_following_the_text() {
        assert_eq!(Settings::default().language, Language::Auto);
        assert_eq!(Language::Auto.name(), None);
    }

    /// The pinned language is what reaches the prompts, or nothing at all.
    #[test]
    fn pinning_a_language_puts_its_name_in_the_prompt() {
        pin_language(Language::Polish);
        assert!(language_instruction().contains("Polish"));
        pin_language(Language::Auto);
        assert!(language_instruction().is_empty());
    }

    #[test]
    fn idle_timeout_never_collapses_to_nothing() {
        let s = Settings { idle_minutes: 0, ..Settings::default() };
        assert_eq!(s.idle_timeout().as_secs(), 60, "a pause to think is not the end");
    }

    #[test]
    fn transcripts_default_when_unset() {
        let s = Settings::default();
        assert_eq!(s.transcripts_path(Path::new("/tmp/def")), PathBuf::from("/tmp/def"));
    }
}
