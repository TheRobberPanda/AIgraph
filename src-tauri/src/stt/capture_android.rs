//! Dictation on the phone.
//!
//! Parakeet runs on sherpa-onnx, which has no Android build. The phone has a
//! good recognizer of its own, so the frontend uses that directly and this side
//! only has to refuse politely — same shape as the desktop `capture`, so
//! `commands` is written once for both.

use std::sync::Arc;

use super::model::ModelPaths;
use super::SttError;

pub enum Event {
    /// A finished phrase, transcribed.
    Phrase(String),
    /// Speech detected or not, for a live indicator.
    Speaking(bool),
    Error(String),
}

/// Uninhabited: `start` never succeeds here, so `stop` can never be reached.
pub enum Dictation {}

impl Dictation {
    pub fn start(
        _paths: ModelPaths,
        _on_event: Arc<dyn Fn(Event) + Send + Sync>,
    ) -> Result<Self, SttError> {
        Err(SttError::Audio("on the phone, dictation uses the system recognizer".into()))
    }

    pub fn stop(self) {
        match self {}
    }
}
