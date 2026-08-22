//! Speech recognition.
//!
//! Parakeet TDT 0.6B v3 via sherpa-onnx. Chosen over Whisper mainly because it
//! runs fast on **CPU** — the chat model already contends for the GPU, and that
//! contention has caused real load failures. Better measured accuracy at a
//! quarter of Whisper's size, across 25 European languages with automatic
//! language detection, is the bonus.
//!
//! [`SpeechToText`] exists so Whisper can be dropped in later: for the languages
//! Parakeet doesn't cover, and as insurance against `sherpa-rs` going stale.

pub mod capture;
pub mod model;
pub mod parakeet;

/// Audio must reach the model at this rate. Both Parakeet and Silero assume it.
pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Debug, thiserror::Error)]
pub enum SttError {
    #[error("model: {0}")]
    Model(#[from] model::ModelError),
    #[error("audio device: {0}")]
    Audio(String),
    #[error("recognizer: {0}")]
    Recognizer(String),
}

/// A loaded speech recognizer.
///
/// `&mut self` because sherpa's recognizer is stateful and not thread-safe;
/// callers keep it behind a lock rather than sharing it.
pub trait SpeechToText: Send {
    /// Transcribe one segment of 16kHz mono audio.
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, SttError>;
    fn model_id(&self) -> String;
}
